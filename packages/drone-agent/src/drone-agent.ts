/**
 * DroneAgent —— 把零依赖的飞行仿真内核包装成平台 Agent。
 *
 * 迁移说明:`drone-sim.ts` 来自旧项目 firstapp,是 1453 行、**零 import** 的纯逻辑模块,
 * 天然满足 README §42「Core / Domain 不得依赖 UI / Renderer」,因此原样保留,
 * 本文件只负责:
 *   ① 实现 Agent 契约(update / handleCommand / getSnapshot / dispose)
 *   ② 把环境从「UI 直接写 config」改为「从 SandboxQuery 读取」
 *   ③ 把「UI 直接调方法」改为「Command 驱动」
 *   ④ 把机械状态(机臂折叠)纳入指令体系并联动起飞检查单
 *
 * 数据流(README §49 / §67):
 *   Command → DroneAgent.handleCommand → DroneSim → DroneSim.step → State → Snapshot
 */
import type {
  Agent,
  AgentId,
  AgentRenderView,
  AgentSnapshot,
  AgentStatus,
  AgentUpdateContext,
  Command,
  MoveCommandPayload,
  SimEvent,
  SimulationSnapshot,
  Vec3,
} from '@simulation/contracts'
import { PLATFORM_COMMAND } from '@simulation/contracts'
import type { DroneSnapshot, FaultFlags, FlightMode, SimConfig, StickState } from './drone-sim'
import { DEFAULT_CONFIG, DroneSim, NEUTRAL_STICK } from './drone-sim'
import type { AimSnapshot } from './aim'
import { solveAim } from './aim'

/** 无人机专属指令 —— 平台契约里没有的概念,留在领域包 */
export const DRONE_COMMAND = {
  startMotors: 'drone.startMotors',
  stopMotors: 'drone.stopMotors',
  emergencyStop: 'drone.emergencyStop',
  setMode: 'drone.setMode',
  setArmFold: 'drone.setArmFold',
  setConfig: 'drone.setConfig',
  setFaults: 'drone.setFaults',
  forceBattery: 'drone.forceBattery',
  setGimbalPitch: 'drone.setGimbalPitch',
  nudgeGimbal: 'drone.nudgeGimbal',
  setZoom: 'drone.setZoom',
  toggleRecording: 'drone.toggleRecording',
  takePhoto: 'drone.takePhoto',
} as const

export interface DroneAgentOptions {
  readonly id: AgentId
  readonly label?: string
  /** 出生点(世界系)。DroneSim 内部坐标是相对起飞点的偏移,这里补上原点。 */
  readonly origin?: Vec3
  readonly headingDeg?: number
  readonly config?: Partial<SimConfig>
  /** 出厂默认机臂收纳:真机必须展开机臂才能起飞 */
  readonly factoryFolded?: boolean
}

// ————————————————————————————— 载荷读取(防御式,不用裸断言) —————————————————————————————

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function unitField(payload: unknown, key: string): number {
  const value = payloadRecord(payload)[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(-1, Math.min(1, value))
}

function numberField(payload: unknown, key: string, fallback: number): number {
  const value = payloadRecord(payload)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringField(payload: unknown, key: string, fallback: string): string {
  const value = payloadRecord(payload)[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function isFlightMode(value: unknown): value is FlightMode {
  return value === 'cine' || value === 'normal' || value === 'sport'
}

/** 只挑出 SimConfig 里真实存在的键,避免把垃圾字段写进配置 */
function pickSimConfig(payload: unknown): Partial<SimConfig> {
  const source = payloadRecord(payload)
  const result: Partial<SimConfig> = {}
  // 用 as const 元组而非 keyof SimConfig:后者会包含 rcFailsafe,导致写入类型塌成 never
  const numericKeys = [
    'maxAltitude',
    'maxDistance',
    'rthAltitude',
    'lowBatteryPercent',
    'criticalBatteryPercent',
  ] as const
  for (const key of numericKeys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
  }
  const failsafe = source['rcFailsafe']
  if (failsafe === 'rth' || failsafe === 'hover' || failsafe === 'land') result.rcFailsafe = failsafe
  return result
}

function pickFaults(payload: unknown): Partial<FaultFlags> {
  const source = payloadRecord(payload)
  const result: Partial<FaultFlags> = {}
  for (const key of [
    'gnssLost',
    'compassError',
    'imuError',
    'motorFailure',
    'rcLost',
    'visionLost',
    'obstacleAvoidanceOff',
  ] as const) {
    const value = source[key]
    if (typeof value === 'boolean') result[key] = value
  }
  return result
}

// ————————————————————————————— DroneAgent —————————————————————————————

export class DroneAgent implements Agent<DroneSnapshot> {
  readonly id: AgentId
  readonly type = 'drone'
  readonly label: string
  /** 领域内核直接可见,便于测试与调试;外部业务仍应走 Domain API */
  readonly sim: DroneSim

  private readonly origin: Vec3
  private readonly originHeadingDeg: number
  private armFold: number
  private environmentSynced = false
  private obstacleSignature = ''

  /** 载荷瞄准目标(世界系);null = 未瞄准 */
  private aimTarget: Vec3 | null = null
  private aimLabel = ''
  private aimTrack = true
  private aimSolution: AimSnapshot | null = null

  constructor(options: DroneAgentOptions) {
    this.id = options.id
    this.label = options.label ?? 'DJI Mini 4 Pro'
    this.origin = options.origin ?? { x: 0, y: 0, z: 0 }
    this.originHeadingDeg = options.headingDeg ?? 0
    this.sim = new DroneSim()
    this.sim.config = { ...DEFAULT_CONFIG, ...options.config }
    // 出生航向交给 sim 自己保管:机头朝向的坐标系与世界系是同一个(见 DroneSim.heading 的说明),
    // 所以场景给的朝向必须写进 sim,而不是在对外读数上加一层偏移 —— 那样会出现
    // 「报告朝南、实际按朝北解算」,凡是按航向算的控制律(转场对准、避障探测、返航)都会飞反。
    this.sim.spawnHeadingDeg = this.originHeadingDeg
    this.sim.heading = this.originHeadingDeg
    this.armFold = options.factoryFolded === false ? 0 : 1
    this.sim.armFold = this.armFold
    this.syncExternalChecks()
  }

  // ————————————————————————————— 机械状态 —————————————————————————————

  get currentArmFold(): number {
    return this.armFold
  }

  get armUnfolded(): boolean {
    return this.armFold < 0.5
  }

  /**
   * 机臂折叠是「机械状态」而非飞行状态,但真机必须先展开才能起飞,
   * 所以它要以 externalChecks 的形式进入起飞检查单 —— 与旧项目的处理一致。
   */
  setArmFold(fold: number): void {
    const next = Math.max(0, Math.min(1, fold))
    this.armFold = next
    this.sim.armFold = next
    this.syncExternalChecks()
  }

  private syncExternalChecks(): void {
    const unfolded = this.armUnfolded
    this.sim.externalChecks = [
      {
        id: 'arm',
        label: '机臂展开',
        ok: unfolded,
        detail: unfolded ? '四臂已展开' : '四臂处于收纳状态,起飞前需展开',
        blocking: true,
      },
    ]
  }

  // ————————————————————————————— 坐标映射 —————————————————————————————

  /** DroneSim 内部坐标是相对起飞点的偏移,这里换算成世界系 */
  get worldPosition(): Vec3 {
    return {
      x: this.origin.x + this.sim.position.x,
      y: this.origin.y + this.sim.position.y,
      z: this.origin.z + this.sim.position.z,
    }
  }

  /**
   * 机头朝向(世界系罗盘)。
   *
   * 直接取 sim 的航向:它本身就是世界航向(出生朝向在构造时已经写进去了),
   * 这里再叠一次场景朝向就会双计 —— 出生航向非 0 时读数与真实机头正好差一个朝向角。
   */
  get worldHeadingDeg(): number {
    return this.sim.heading
  }

  private get statusValue(): AgentStatus {
    if (this.sim.damaged) return 'disabled'
    if (this.sim.phase === 'powerOff') return 'inactive'
    return 'active'
  }

  // ————————————————————————————— 载荷瞄准 —————————————————————————————

  /**
   * 把载荷对准世界系一个点。目标点由调用方给出,角度解算在这里 ——
   * 因为只有这个类知道机体原点与航向偏移(DroneSim 内部坐标是相对起飞点的)。
   */
  setAim(target: Vec3, label = '目标点', track = true): void {
    this.aimTarget = { ...target }
    this.aimLabel = label
    this.aimTrack = track
    this.aimSolution = null
    this.sim.aimHold = true
    this.sim.pushEvent('info', `载荷瞄准:${label}`)
  }

  /** 解除瞄准,云台偏航恢复自动回中 */
  clearAim(reason = '载荷解除瞄准'): void {
    if (!this.aimTarget) return
    this.aimTarget = null
    this.aimLabel = ''
    this.aimSolution = null
    this.sim.clearGimbalAim()
    this.sim.pushEvent('info', reason)
  }

  /** 当前瞄准解算结果;未瞄准时为 null */
  get aim(): AimSnapshot | null {
    return this.aimSolution
  }

  /** 每 tick 重算一次瞄准:机体一动,同一目标的方位与仰角就变了 */
  private updateAim(): void {
    const target = this.aimTarget
    if (!target) return
    // 单次解算模式(track = false):解出一次就采住,不再随动
    if (!this.aimTrack && this.aimSolution) {
      this.sim.setGimbalAim(this.aimSolution.pitchDeg, this.aimSolution.yawDeg)
      return
    }
    const solution = solveAim({ drone: this.worldPosition, headingDeg: this.worldHeadingDeg, target })
    this.aimSolution = { ...solution, target: { ...target }, label: this.aimLabel, track: this.aimTrack }
    this.sim.setGimbalAim(solution.pitchDeg, solution.yawDeg)
  }

  // ————————————————————————————— Agent 契约 —————————————————————————————

  update(context: AgentUpdateContext): void {
    this.syncEnvironment(context)
    // 先解算再推进:云台角度必须在 Sim 的 updateCamera 之前写好,
    // 否则「刚下发瞄准」的那一帧会被偏航回中拉回去,第一帧永远对不上
    this.updateAim()
    this.sim.step(context.deltaTime)
  }

  /**
   * 返回 true 表示「本 Agent 认领了这条指令」。
   * 注意:业务上被拒绝(例如检查单未过导致起飞失败)也返回 true —— 原因由
   * DroneSim 自己写进事件日志,这样不会在 Runtime 层产生误导性的「拒绝指令」告警。
   */
  handleCommand(command: Command): boolean {
    const sim = this.sim
    switch (command.type) {
      // ——— 平台级通用指令 ———
      case PLATFORM_COMMAND.powerOn:
        sim.powerOn()
        return true
      case PLATFORM_COMMAND.powerOff:
        sim.powerOff()
        return true
      case PLATFORM_COMMAND.takeOff:
        // 地面待机时自动完成「启动电机 + 起飞」,与真机一键起飞一致
        sim.autoTakeOff()
        return true
      case PLATFORM_COMMAND.land:
        sim.startLanding()
        return true
      case PLATFORM_COMMAND.hover:
      case PLATFORM_COMMAND.stop:
        // 摇杆量是「Agent 状态」而不是一次性动作:设成中位后就保持住,
        // 直到下一条 move / hover 改变它。这样指令频率不会隐式影响飞行品质。
        sim.setStick(NEUTRAL_STICK)
        return true
      case PLATFORM_COMMAND.move: {
        const move: MoveCommandPayload = {
          forward: unitField(command.payload, 'forward'),
          right: unitField(command.payload, 'right'),
          up: unitField(command.payload, 'up'),
          yawRate: unitField(command.payload, 'yawRate'),
        }
        const stick: Partial<StickState> = {
          pitch: move.forward,
          roll: move.right,
          throttle: move.up,
          yaw: move.yawRate,
        }
        sim.setStick(stick)
        return true
      }
      case PLATFORM_COMMAND.returnToHome:
        sim.startRth(stringField(command.payload, 'reason', '收到返航指令'))
        return true
      case PLATFORM_COMMAND.cancelReturnToHome:
        sim.cancelRth()
        return true
      case PLATFORM_COMMAND.reset:
        sim.reset()
        sim.setStick(NEUTRAL_STICK)
        // 瞄准目标是 Agent 侧状态,复位时一并清掉 —— 否则重置后云台还咬着旧目标
        this.aimTarget = null
        this.aimSolution = null
        this.aimLabel = ''
        return true
      case PLATFORM_COMMAND.aimAt: {
        const source = payloadRecord(command.payload)
        const x = source['x']
        const y = source['y']
        const z = source['z']
        if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
          this.sim.pushEvent('warn', '瞄准指令缺少有效的目标坐标,已忽略')
          return true
        }
        const label = typeof source['label'] === 'string' && source['label'] ? source['label'] : '目标点'
        this.setAim({ x, y, z }, label, source['track'] !== false)
        return true
      }
      case PLATFORM_COMMAND.clearAim:
        this.clearAim(stringField(command.payload, 'reason', '载荷解除瞄准'))
        return true

      // ——— 无人机专属指令 ———
      case DRONE_COMMAND.startMotors:
        sim.startMotors()
        return true
      case DRONE_COMMAND.stopMotors:
        sim.stopMotors()
        return true
      case DRONE_COMMAND.emergencyStop:
        // 新内核规则:紧急停桨只在**落地后**可用,空中调用会被拒绝并写一条警告,
        // 不改动任何飞行状态(空中「动力丧失」仅由电池耗尽等真实故障触发)。
        // 拒绝原因由 DroneSim 自己写进事件日志,所以这里照旧返回 true。
        sim.emergencyStop()
        return true
      case DRONE_COMMAND.setMode: {
        const mode = payloadRecord(command.payload)['mode']
        if (isFlightMode(mode)) sim.setMode(mode)
        return true
      }
      case DRONE_COMMAND.setArmFold:
        this.setArmFold(numberField(command.payload, 'fold', this.armFold))
        return true
      case DRONE_COMMAND.setConfig:
        sim.config = { ...sim.config, ...pickSimConfig(command.payload) }
        return true
      case DRONE_COMMAND.setFaults:
        sim.faults = { ...sim.faults, ...pickFaults(command.payload) }
        return true
      case DRONE_COMMAND.forceBattery:
        sim.forceBatteryLevel(numberField(command.payload, 'percent', sim.batteryPercent))
        return true
      case DRONE_COMMAND.setGimbalPitch:
        sim.setGimbalPitch(numberField(command.payload, 'pitch', sim.gimbalPitch))
        return true
      case DRONE_COMMAND.nudgeGimbal:
        sim.nudgeGimbal(
          numberField(command.payload, 'deltaPitch', 0),
          numberField(command.payload, 'deltaYaw', 0),
        )
        return true
      case DRONE_COMMAND.setZoom:
        sim.setZoom(numberField(command.payload, 'zoom', 1))
        return true
      case DRONE_COMMAND.toggleRecording:
        sim.toggleRecording()
        return true
      case DRONE_COMMAND.takePhoto:
        sim.takePhoto()
        return true

      default:
        return false
    }
  }

  getSnapshot(): AgentSnapshot<DroneAgentSnapshot> {
    const telemetry = this.sim.snapshot()
    return {
      id: this.id,
      type: this.type,
      label: this.label,
      position: this.worldPosition,
      headingDeg: this.worldHeadingDeg,
      status: this.statusValue,
      // 瞄准解算是 Agent 侧状态(要世界系),不在 DroneSim 里,所以在这里并进载荷
      payload: { ...telemetry, aim: this.aimSolution },
    }
  }

  dispose(): void {
    this.sim.obstacles = []
    this.sim.externalChecks = []
    this.aimTarget = null
    this.aimSolution = null
  }

  // ————————————————————————————— 环境同步 —————————————————————————————

  /**
   * 环境(风、障碍物)统一来自 Sandbox,不再由 UI 直接写 config。
   * 障碍物签名不变就不重建数组,避免每 tick 分配。
   */
  private syncEnvironment(context: AgentUpdateContext): void {
    const sandbox = context.sandbox
    const wind = sandbox.getWind()
    this.sim.config.windSpeed = Math.max(0, wind.speed)
    this.sim.config.windDirection = ((wind.directionDeg % 360) + 360) % 360

    const signature = sandbox.obstacles
      .map((box) => `${box.name}:${box.minX},${box.minY},${box.minZ},${box.maxX},${box.maxY},${box.maxZ}`)
      .join('|')
    if (!this.environmentSynced || signature !== this.obstacleSignature) {
      this.environmentSynced = true
      this.obstacleSignature = signature
      this.sim.obstacles = sandbox.obstacles.map((box) => ({ ...box }))
    }
  }
}

// ————————————————————————————— 供 UI / Recorder 使用的读取工具 —————————————————————————————

/**
 * 无人机 Agent 的完整载荷:内核遥测 + Agent 侧附加状态。
 *
 * 「载荷」是平台契约里唯一的扩展位(AgentSnapshot.payload 是 unknown),
 * 所以 Agent 侧算出来的东西(瞄准解算)并在这里,而不是塞进零依赖内核。
 */
export interface DroneAgentSnapshot extends DroneSnapshot {
  /** 载荷瞄准解算结果;未瞄准时为 null */
  readonly aim: AimSnapshot | null
}

/**
 * 类型安全地从通用 AgentSnapshot 里读出无人机遥测。
 * 契约层的 payload 是 unknown,由领域包提供唯一的收窄入口,避免 UI 到处写 as。
 */
export function readDroneTelemetry(snapshot: AgentSnapshot | undefined): DroneAgentSnapshot | undefined {
  if (!snapshot || snapshot.type !== 'drone') return undefined
  const payload = snapshot.payload
  if (payload === null || typeof payload !== 'object') return undefined
  const candidate = payload as Partial<DroneAgentSnapshot>
  return typeof candidate.phase === 'string' && typeof candidate.batteryPercent === 'number'
    ? (candidate as DroneAgentSnapshot)
    : undefined
}

/**
 * 把领域事件「收割」成平台事件。
 * DroneSim 的事件存在遥测里(滚动窗口,最多 12 条),同一 eventId 会被重复收割,
 * 因此订阅方必须按 eventId 去重 —— Recorder 已经这么做了。
 */
export function harvestDroneEvents(snapshot: SimulationSnapshot): ReadonlyArray<SimEvent> {
  const events: SimEvent[] = []
  for (const agent of snapshot.agents) {
    const telemetry = readDroneTelemetry(agent)
    if (!telemetry) continue
    for (const item of telemetry.events) {
      events.push({
        eventId: `drone.${agent.id}.${item.id}`,
        type: 'drone.event',
        level: item.level,
        simulationTime: item.time,
        tick: snapshot.tick,
        sessionId: snapshot.sessionId,
        agentId: agent.id,
        message: item.text,
      })
    }
  }
  return events
}

/**
 * 领域包自己负责「把我投影成渲染视图」。
 *
 * 这样渲染适配器只需要认识 AgentRenderView(平台契约),完全不用认识无人机遥测:
 *   DroneSnapshot → AgentRenderView → three-adapter
 * 换机型/换领域只要换这个投影函数,渲染层一行都不用动。
 */
export function projectDroneRenderView(agent: AgentSnapshot): AgentRenderView | null {
  const telemetry = readDroneTelemetry(agent)
  if (!telemetry) return null
  return {
    agentId: agent.id,
    type: agent.type,
    label: agent.label,
    visible: true,
    pose: {
      x: agent.position.x,
      y: agent.position.y,
      z: agent.position.z,
      headingDeg: agent.headingDeg,
      // 航空惯例:俯仰正 = 抬头,横滚正 = 右压坡
      pitchDeg: telemetry.tiltPitch,
      rollDeg: telemetry.tiltRoll,
    },
    rig: {
      motorLoad: telemetry.motorLoad,
      armFold: telemetry.armFold,
      gimbalPitchDeg: telemetry.gimbalPitch,
      gimbalRollDeg: telemetry.gimbalRoll,
      gimbalYawDeg: telemetry.gimbalYaw,
      cameraZoom: telemetry.cameraZoom,
    },
    lights: {
      pattern: statusPatternFor(telemetry),
      batteryLevel: telemetry.batteryPercent,
      flying: telemetry.airborne,
    },
    // 上电与否决定灯光与测距雷达是否工作:自检/预热阶段已通电,powerOff 才算断电
    powered: telemetry.phase !== 'powerOff',
  }
}

// ————————————————————————————— 状态灯语 —————————————————————————————

/**
 * 状态灯语键。与 three-adapter 的 `STATUS_PATTERNS` 表逐项对应 ——
 * 两边不互相 import(领域层不得依赖渲染层),靠应用层的一个测试断言两份清单一致,
 * 谁单方面加了灯语都会立刻红。
 */
export const DRONE_LIGHT_PATTERNS = [
  'selfCheck',
  'sensorWarmup',
  'gnssNormal',
  'gnssWeak',
  'attiMode',
  'rcLost',
  'lowBattery',
  'criticalBattery',
  'tilted',
  'fcError',
  'compassError',
  'motorRunning',
  'off',
] as const

export type DroneLightPattern = (typeof DRONE_LIGHT_PATTERNS)[number]

/**
 * 灯语判定需要的最小状态面 —— 不用 DroneSim 整类,
 * 这样 `DroneSim` 本体与它的 `DroneSnapshot` 都能喂进来。
 */
export type StatusPatternSource = Pick<
  DroneSnapshot,
  | 'phase'
  | 'damaged'
  | 'faults'
  | 'criticalBattery'
  | 'lowBattery'
  | 'motorsOn'
  | 'positionSource'
  | 'gpsBars'
>

/**
 * 灯语与飞行状态的对应关系(与《Mini 4 Pro 灯光说明》一致)。
 *
 * 放在领域层而不是渲染层:这是**产品行为**(真机什么状态亮什么灯),
 * 不是画法。渲染层只负责把灯语画出来,不解释它的含义。
 */
export function statusPatternFor(sim: StatusPatternSource): DroneLightPattern {
  if (sim.damaged) return 'fcError'
  if (sim.phase === 'powerOff') return 'off'
  switch (sim.phase) {
    case 'selfCheck':
      return 'selfCheck'
    case 'warmingUp':
      return 'sensorWarmup'
    case 'emergency':
      return 'fcError'
    default:
      break
  }
  if (sim.faults.imuError) return 'fcError'
  if (sim.faults.compassError) return 'compassError'
  if (sim.faults.rcLost) return 'rcLost'
  if (sim.criticalBattery) return 'criticalBattery'
  if (sim.lowBattery) return 'lowBattery'
  if (sim.motorsOn) return 'motorRunning'
  const source = sim.positionSource
  if (source === 'gps') return sim.gpsBars >= 3 ? 'gnssNormal' : 'gnssWeak'
  if (source === 'vision') return 'gnssWeak'
  return 'attiMode'
}
