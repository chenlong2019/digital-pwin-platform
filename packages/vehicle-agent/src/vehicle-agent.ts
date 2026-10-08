/**
 * VehicleAgent —— 把零依赖的轮式仿真内核包装成平台 Agent。
 *
 * 与 DroneAgent 一一对应(实现同一份 Agent 契约),差别全在领域知识:
 *   · 平台级 move 载荷(forward/right/up/yawRate)在汽车上只用到 forward 与 right,
 *     其中 right 映射成**转向**而不是横移 —— 汽车没有侧向自由度
 *   · 起降类指令(takeOff / land)不认领,留给别的载体
 *   · 多了一套车身可动件指令(门 / 后视镜 / 灯光 / 挡位)
 *
 * 数据流(README §49 / §67):
 *   Command → VehicleAgent.handleCommand → VehicleSim → VehicleSim.step → State → Snapshot
 */
import type {
  Agent,
  AgentId,
  AgentSnapshot,
  AgentStatus,
  AgentUpdateContext,
  Command,
  SimEvent,
  SimulationSnapshot,
  Vec3,
} from '@simulation/contracts'
import { PLATFORM_COMMAND } from '@simulation/contracts'
import type {
  DoorKey,
  GearPosition,
  MirrorKey,
  VehicleConfig,
  VehicleLightPattern,
  VehicleSnapshot,
} from './vehicle-sim'
import { DOOR_KEYS, MIRROR_KEYS, VEHICLE_LIGHT_PATTERNS, VehicleSim } from './vehicle-sim'

/** 轮式载具专属指令 —— 平台契约里没有的概念,留在领域包 */
export const VEHICLE_COMMAND = {
  setGear: 'vehicle.setGear',
  setDrive: 'vehicle.setDrive',
  setSteer: 'vehicle.setSteer',
  setDoor: 'vehicle.setDoor',
  setMirror: 'vehicle.setMirror',
  setLights: 'vehicle.setLights',
  forceBattery: 'vehicle.forceBattery',
} as const

export interface VehicleAgentOptions {
  readonly id: AgentId
  readonly label?: string
  /** 出生点(世界系) */
  readonly origin?: Vec3
  readonly headingDeg?: number
  readonly config?: Partial<VehicleConfig>
  /** 出厂车门全开(展示用;真车交付都是关着的) */
  readonly spawnDoorsOpen?: boolean
}

// ————————————————————————————— 载荷读取(防御式,不用裸断言) —————————————————————————————

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function numberField(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringField(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : fallback
}

function isGear(value: unknown): value is GearPosition {
  return value === 'P' || value === 'R' || value === 'N' || value === 'D'
}

function isLightPattern(value: unknown): value is VehicleLightPattern {
  return typeof value === 'string' && (VEHICLE_LIGHT_PATTERNS as ReadonlyArray<string>).includes(value)
}

function asDoorKey(value: string): DoorKey | null {
  return (DOOR_KEYS as ReadonlyArray<string>).includes(value) ? (value as DoorKey) : null
}

function asMirrorKey(value: string): MirrorKey | null {
  return (MIRROR_KEYS as ReadonlyArray<string>).includes(value) ? (value as MirrorKey) : null
}

export class VehicleAgent implements Agent<VehicleSnapshot> {
  readonly id: AgentId
  readonly type = 'vehicle' as const
  readonly label: string

  private readonly sim: VehicleSim
  private readonly origin: Vec3
  private statusValue: AgentStatus = 'inactive'
  private environmentSynced = false
  private obstacleSignature = ''

  constructor(options: VehicleAgentOptions) {
    this.id = options.id
    this.label = options.label ?? 'Model 3'
    this.origin = options.origin ?? { x: 0, y: 0, z: 0 }
    this.sim = new VehicleSim(options.config)
    this.sim.headingDeg = options.headingDeg ?? 0
    if (options.spawnDoorsOpen) this.sim.setAllDoors(1)
  }

  /** 只读入口 —— HUD 需要挡位等细节时走 getSnapshot,不要从这里改状态 */
  get telemetry(): VehicleSnapshot {
    return this.sim.snapshot()
  }

  update(context: AgentUpdateContext): void {
    this.syncEnvironment(context)
    const origin = this.origin
    this.sim.step(context.deltaTime, (x, z) => context.sandbox.getTerrainHeight(origin.x + x, origin.z + z))
    this.statusValue = this.sim.powered ? 'active' : 'inactive'
  }

  handleCommand(command: Command): boolean {
    switch (command.type) {
      // —— 平台级 ——
      case PLATFORM_COMMAND.powerOn:
        this.sim.setPower(true)
        return true
      case PLATFORM_COMMAND.powerOff:
        this.sim.setPower(false)
        return true
      case PLATFORM_COMMAND.reset:
        this.sim.reset()
        return true
      case PLATFORM_COMMAND.stop:
        this.sim.setDrive(0, 1)
        this.sim.setGear('P')
        return true
      case PLATFORM_COMMAND.hover:
        // 汽车没有悬停:归中 = 松油门
        this.sim.setDrive(0, 0)
        return true
      case PLATFORM_COMMAND.move:
        this.applyMove(command.payload)
        return true

      // —— 轮式载具专属 ——
      case VEHICLE_COMMAND.setGear: {
        const payload = payloadRecord(command.payload)
        const gear = payload.gear
        if (isGear(gear)) this.sim.setGear(gear)
        return true
      }
      case VEHICLE_COMMAND.setDrive: {
        const payload = payloadRecord(command.payload)
        this.sim.setDrive(numberField(payload, 'throttle', 0), numberField(payload, 'brake', 0))
        return true
      }
      case VEHICLE_COMMAND.setSteer: {
        const payload = payloadRecord(command.payload)
        this.sim.setSteer(numberField(payload, 'steerDeg', 0))
        return true
      }
      case VEHICLE_COMMAND.setDoor: {
        const payload = payloadRecord(command.payload)
        const open = numberField(payload, 'open', 1)
        const target = stringField(payload, 'target', 'all')
        if (target === 'all') {
          this.sim.setAllDoors(open)
        } else {
          const key = asDoorKey(target)
          if (key) this.sim.setDoor(key, open)
        }
        return true
      }
      case VEHICLE_COMMAND.setMirror: {
        const payload = payloadRecord(command.payload)
        const folded = numberField(payload, 'folded', 1)
        const target = stringField(payload, 'target', 'all')
        if (target === 'all') {
          this.sim.setAllMirrors(folded)
        } else {
          const key = asMirrorKey(target)
          if (key) this.sim.setMirror(key, folded)
        }
        return true
      }
      case VEHICLE_COMMAND.setLights: {
        const payload = payloadRecord(command.payload)
        const pattern = payload.pattern
        if (isLightPattern(pattern)) this.sim.setLights(pattern)
        return true
      }
      case VEHICLE_COMMAND.forceBattery:
        this.sim.forceBattery(numberField(payloadRecord(command.payload), 'percent', 100))
        return true

      default:
        // 起降等不适用本载体的指令:不认领,交回内核
        return false
    }
  }

  /**
   * 平台 move 载荷 → 汽车的油门与转向。
   *
   * `right` 正 = 想往右 → 前轮右偏(物理层约定 steer 正 = 右转)。
   * `up` / `yawRate` 汽车没有对应自由度,直接忽略而不是报错 ——
   * 同一份载荷要能喂给无人机、车、船,各自只取自己认得的字段。
   */
  private applyMove(payload: unknown): void {
    const record = payloadRecord(payload)
    const forward = numberField(record, 'forward', 0)
    const right = numberField(record, 'right', 0)

    this.sim.setSteer(right * this.sim.config.maxSteerDeg)

    if (forward < -0.01) this.sim.setGear('R')
    this.sim.setDrive(Math.abs(forward) > 0.01 ? Math.abs(forward) : 0, 0)
  }

  getSnapshot(): AgentSnapshot<VehicleSnapshot> {
    return {
      id: this.id,
      type: this.type,
      label: this.label,
      position: {
        x: this.origin.x + this.sim.x,
        y: this.origin.y + this.sim.y,
        z: this.origin.z + this.sim.z,
      },
      headingDeg: this.sim.headingDeg,
      status: this.statusValue,
      payload: this.sim.snapshot(),
    }
  }

  dispose(): void {
    this.sim.obstacles = []
  }

  /**
   * 环境统一来自 Sandbox,不由 UI 直接写。
   * 障碍物签名不变就不重建数组,避免每 tick 分配 —— 与 DroneAgent 同一手法。
   */
  private syncEnvironment(context: AgentUpdateContext): void {
    const sandbox = context.sandbox
    const signature = sandbox.obstacles
      .map((box) => `${box.name}:${box.minX},${box.minZ},${box.maxX},${box.maxZ}`)
      .join('|')
    if (!this.environmentSynced || signature !== this.obstacleSignature) {
      this.environmentSynced = true
      this.obstacleSignature = signature
      this.sim.obstacles = sandbox.obstacles.map((box) => ({
        name: box.name,
        minX: box.minX,
        maxX: box.maxX,
        minZ: box.minZ,
        maxZ: box.maxZ,
        solid: box.solid,
      }))
    }
  }
}

// ————————————————————————————— 供 UI / Recorder 使用的读取工具 —————————————————————————————

/**
 * 类型安全地从通用 AgentSnapshot 里读出车辆遥测。
 * 契约层的 payload 是 unknown,由领域包提供唯一的收窄入口,避免 UI 到处写 as。
 */
export function readVehicleTelemetry(snapshot: AgentSnapshot | undefined): VehicleSnapshot | undefined {
  if (!snapshot || snapshot.type !== 'vehicle') return undefined
  const payload = snapshot.payload
  if (payload === null || typeof payload !== 'object') return undefined
  const candidate = payload as Partial<VehicleSnapshot>
  return typeof candidate.gear === 'string' && typeof candidate.speedMps === 'number'
    ? (candidate as VehicleSnapshot)
    : undefined
}

/**
 * 把领域事件「收割」成平台事件。
 * 车辆事件与无人机一样存在遥测里(滚动窗口),同一 eventId 会被重复收割,
 * 订阅方必须按 eventId 去重 —— Recorder 已经这么做了。
 */
export function harvestVehicleEvents(snapshot: SimulationSnapshot): ReadonlyArray<SimEvent> {
  const events: SimEvent[] = []
  for (const agent of snapshot.agents) {
    const telemetry = readVehicleTelemetry(agent)
    if (!telemetry) continue
    for (const item of telemetry.events) {
      events.push({
        eventId: `vehicle.${agent.id}.${item.id}`,
        type: 'vehicle.event',
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
