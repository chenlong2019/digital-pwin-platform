/**
 * WaypointTask —— 平台级航点任务实现(README §10:「Mission 不是平台级核心抽象」)。
 *
 * 它只使用**平台契约**:
 *   · 读:ctx.getAgentSnapshot(agentId) → 通用 AgentSnapshot(position / headingDeg)
 *   · 读世界:ctx.sandbox.raycast / obstacles → 通用 SandboxQuery(README §50)
 *   · 写:ctx.emitCommand(agent.move / agent.takeOff / agent.land / agent.hover)
 *
 * 因此它完全不知道「无人机」这个概念 —— 换成车/船/机器人,只要对应 Agent 认领
 * 这些平台指令,同一个任务就能原样复用。这是 README §3.3「Package First」的落点。
 *
 * 控制律分三段,顺序很重要:
 *   ① 起飞   —— 离地
 *   ② 爬到航线高度并**原地保持**,再开始水平机动
 *              (这一条是实测踩出来的:边爬边平移会在低空撞进障碍物高度带)
 *   ③ 巡航   —— 机头指向航点,前进档位与距离成比例的 P 控制;
 *              每个 tick 用 raycast 探前方 20 米,若障碍物高于当前高度就先爬过去。
 *              转向未对齐(>45°)时先原地转,对齐后再推进 —— 与真机航点飞行手感一致。
 */
import type {
  AgentSnapshot,
  Task,
  TaskId,
  TaskResult,
  TaskSnapshot,
  TaskStatus,
  TaskUpdateContext,
  AgentId,
  ObstacleBox,
  Vec3,
} from '@simulation/contracts'
import {
  PLATFORM_COMMAND,
  createCommand,
  headingToVector,
  horizontalDistance,
  vectorToHeading,
} from '@simulation/contracts'

export interface Waypoint {
  readonly id: string
  readonly label: string
  /** 世界系 X(东为正) */
  readonly x: number
  /** 世界系 Z(南为正) */
  readonly z: number
  /** 期望相对起飞点的高度(米) */
  readonly altitude: number
  /** 到达判定半径(米),默认 1.5 */
  readonly radius?: number
}

export type WaypointStage = 'pending' | 'takingOff' | 'cruising' | 'holding' | 'landing' | 'done'

export const WAYPOINT_STAGE_LABELS: Record<WaypointStage, string> = {
  pending: '待启动',
  takingOff: '自动起飞',
  cruising: '巡航中',
  holding: '航点悬停',
  landing: '自动降落',
  done: '任务完成',
}

export interface WaypointTaskOptions {
  readonly id: TaskId
  readonly label?: string
  readonly agentId: AgentId
  readonly waypoints: ReadonlyArray<Waypoint>
  /** 起飞判定高度(米),默认 1.2 */
  readonly takeoffAltitude?: number
  /** 到达最后一个航点后的悬停时间(秒),默认 2 */
  readonly holdSeconds?: number
  /** 是否在完成后自动降落,默认 true */
  readonly landAtEnd?: boolean
  /** 起飞 + 爬升到首个航线高度的超时(秒),默认 30 */
  readonly takeoffTimeout?: number
  /** 单个航点超时(秒),默认 90 */
  readonly waypointTimeout?: number
  /** 降落超时(秒),默认 60 */
  readonly landingTimeout?: number
}

const DEFAULT_RADIUS = 1.5
/** 航向误差超过该角度就先转向再前进 */
const ALIGN_THRESHOLD_DEG = 45
/** 满舵偏航对应的航向误差(度) */
const YAW_FULL_SCALE_DEG = 60
/** 前进满舵对应的距离(米) */
const FORWARD_FULL_SCALE_M = 6
/** 高度误差满舵对应的高度差(米) */
const ALTITUDE_FULL_SCALE_M = 2
/** 高度到位判定(米):留一点死区,免得在目标高度附近反复微调 */
const ALTITUDE_TOLERANCE_M = 0.6
/** 前方探测距离(米) */
const OBSTACLE_PROBE_M = 20
/** 飞越障碍物时在最高点之上留的余量(米) */
const OBSTACLE_CLEARANCE_M = 3

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 从 from 转到 to 的最短角度差,范围 (-180, 180] */
function shortestAngle(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180
}

export class WaypointTask implements Task {
  readonly id: TaskId
  readonly type = 'waypoint'
  readonly label: string
  readonly agentId: AgentId

  private readonly tuning: {
    takeoffAltitude: number
    holdSeconds: number
    landAtEnd: boolean
    takeoffTimeout: number
    waypointTimeout: number
    landingTimeout: number
  }
  private readonly waypointList: Waypoint[]

  private currentStatus: TaskStatus = 'pending'
  private stage: WaypointStage = 'pending'
  private index = 0
  private stageTime = 0
  private totalTime = 0
  private result: TaskResult | null = null
  private failureReason = ''
  private lastPosition: { x: number; z: number } | null = null
  private distanceFlown = 0
  private maxAltitude = 0
  private reached = 0
  /**
   * 本航段为飞越障碍物而抬高的目标高度。
   * 不做滞回的话,一飞过障碍物就会立刻下降到原高度、下一 tick 又探测到它,来回抖。
   */
  private avoidAltitude: number | null = null

  constructor(options: WaypointTaskOptions) {
    if (options.waypoints.length === 0) throw new Error('WaypointTask 至少需要一个航点')
    this.id = options.id
    this.label = options.label ?? '航点飞行任务'
    this.agentId = options.agentId
    this.waypointList = [...options.waypoints]
    this.tuning = {
      takeoffAltitude: options.takeoffAltitude ?? 1.2,
      holdSeconds: options.holdSeconds ?? 2,
      landAtEnd: options.landAtEnd ?? true,
      takeoffTimeout: options.takeoffTimeout ?? 30,
      waypointTimeout: options.waypointTimeout ?? 90,
      landingTimeout: options.landingTimeout ?? 60,
    }
  }

  get status(): TaskStatus {
    return this.currentStatus
  }

  get currentStage(): WaypointStage {
    return this.stage
  }

  /** 本次任务的航线高度下限:首个航点的高度 */
  private get climbAltitude(): number {
    return Math.max(this.tuning.takeoffAltitude, this.waypointList[0]?.altitude ?? 0)
  }

  // ————————————————————————————— 生命周期 —————————————————————————————

  start(): void {
    if (this.currentStatus === 'running') return
    this.currentStatus = 'running'
    this.failureReason = ''
    this.result = null
  }

  pause(): void {
    if (this.currentStatus !== 'running') return
    this.currentStatus = 'paused'
  }

  resume(): void {
    if (this.currentStatus !== 'paused') return
    this.currentStatus = 'running'
  }

  abort(reason = '任务已中止'): void {
    if (this.currentStatus === 'completed' || this.currentStatus === 'aborted') return
    this.currentStatus = 'aborted'
    this.failureReason = reason
    this.result = this.buildResult('aborted', reason)
  }

  // ————————————————————————————— 每 tick —————————————————————————————

  update(context: TaskUpdateContext): void {
    if (this.currentStatus !== 'running') return
    this.totalTime += context.deltaTime
    this.stageTime += context.deltaTime

    const snapshot = context.getAgentSnapshot(this.agentId)
    if (!snapshot) {
      this.fail(context, `目标 Agent 不存在:${this.agentId}`)
      return
    }

    const altitude = snapshot.position.y
    this.maxAltitude = Math.max(this.maxAltitude, altitude)
    if (this.lastPosition) {
      this.distanceFlown += Math.hypot(
        snapshot.position.x - this.lastPosition.x,
        snapshot.position.z - this.lastPosition.z,
      )
    }
    this.lastPosition = { x: snapshot.position.x, z: snapshot.position.z }

    switch (this.stage) {
      case 'pending':
        this.stage = 'takingOff'
        this.stageTime = 0
        this.emit(context, PLATFORM_COMMAND.takeOff, {})
        context.log('info', `任务启动:起飞并爬升至 ${this.climbAltitude} 米航线高度`)
        break

      case 'takingOff':
        this.updateTakingOff(context, snapshot)
        break

      case 'cruising':
        this.updateCruise(context, snapshot)
        break

      case 'holding':
        if (this.stageTime >= this.tuning.holdSeconds) {
          if (this.tuning.landAtEnd) this.beginLanding(context)
          else this.complete(context)
        }
        break

      case 'landing':
        if (altitude <= 0.05) this.complete(context)
        else if (this.stageTime > this.tuning.landingTimeout) {
          this.fail(context, `降落超时(${this.tuning.landingTimeout} 秒)`)
        }
        break

      case 'done':
        break
    }
  }

  /** 起飞 + 原地垂直爬升到航线高度。水平位置必须保持不动,否则会撞进低空障碍物。 */
  private updateTakingOff(context: TaskUpdateContext, snapshot: AgentSnapshot): void {
    const altitude = snapshot.position.y
    const target = this.climbAltitude

    if (altitude >= target - ALTITUDE_TOLERANCE_M) {
      this.stage = 'cruising'
      this.stageTime = 0
      this.avoidAltitude = null
      context.log('success', `已爬升至 ${altitude.toFixed(1)} 米,开始飞向第 1 个航点`)
      this.emit(context, PLATFORM_COMMAND.hover, {})
      return
    }

    if (this.stageTime > this.tuning.takeoffTimeout) {
      this.fail(context, `起飞爬升超时(${this.tuning.takeoffTimeout} 秒未到达 ${target} 米)`)
      return
    }

    const up = clamp((target - altitude) / ALTITUDE_FULL_SCALE_M, 0, 1)
    this.emit(context, PLATFORM_COMMAND.move, { forward: 0, right: 0, up, yawRate: 0 })
  }

  private updateCruise(context: TaskUpdateContext, snapshot: AgentSnapshot): void {
    const waypoint = this.waypointList[this.index]
    if (!waypoint) {
      this.beginHolding(context)
      return
    }

    const radius = waypoint.radius ?? DEFAULT_RADIUS
    const distance = horizontalDistance(snapshot.position, { x: waypoint.x, y: 0, z: waypoint.z })
    const altitude = snapshot.position.y
    const desiredHeading = vectorToHeading(waypoint.x - snapshot.position.x, waypoint.z - snapshot.position.z)

    // 目标高度必须先算:绕飞时本航段的目标高度会高于航点标称高度,
    // 拿标称高度去判定「到了没」会永远到不了(实测踩过这个坑)。
    const targetAltitude = this.resolveTargetAltitude(context, snapshot, waypoint, desiredHeading, distance)

    if (distance <= radius && Math.abs(targetAltitude - altitude) <= ALTITUDE_TOLERANCE_M) {
      this.reached += 1
      context.log('success', `已到达航点 ${this.index + 1}/${this.waypointList.length}:${waypoint.label}`)
      this.index += 1
      this.stageTime = 0
      this.avoidAltitude = null
      if (this.index >= this.waypointList.length) this.beginHolding(context)
      return
    }

    if (this.stageTime > this.tuning.waypointTimeout) {
      this.fail(context, `飞往航点「${waypoint.label}」超时(${this.tuning.waypointTimeout} 秒)`)
      return
    }

    // —— 高度优先:先站到本航段该有的高度,再水平机动 ——
    if (Math.abs(targetAltitude - altitude) > ALTITUDE_TOLERANCE_M) {
      const up = clamp((targetAltitude - altitude) / ALTITUDE_FULL_SCALE_M, -0.6, 1)
      this.emit(context, PLATFORM_COMMAND.move, { forward: 0, right: 0, up, yawRate: 0 })
      return
    }

    // —— 机头指向航点 ——
    const headingError = shortestAngle(snapshot.headingDeg, desiredHeading)
    const yawRate = clamp(headingError / YAW_FULL_SCALE_DEG, -1, 1)
    const aligned = Math.abs(headingError) < ALIGN_THRESHOLD_DEG
    const forward = aligned ? clamp(distance / FORWARD_FULL_SCALE_M, 0, 1) : 0
    const up = clamp((targetAltitude - altitude) / ALTITUDE_FULL_SCALE_M, -0.6, 1)

    this.emit(context, PLATFORM_COMMAND.move, { forward, right: 0, up, yawRate })
  }

  /**
   * 本航段的目标高度 = max(航点高度, 需要飞越的障碍物高度 + 余量)。
   * 只用 SandboxQuery 的 raycast / obstacles,没有一行代码认识「无人机」。
   */
  private resolveTargetAltitude(
    context: TaskUpdateContext,
    snapshot: AgentSnapshot,
    waypoint: Waypoint,
    desiredHeading: number,
    distance: number,
  ): number {
    if (this.avoidAltitude !== null) return Math.max(this.avoidAltitude, waypoint.altitude)

    const probeDistance = Math.min(distance, OBSTACLE_PROBE_M)
    if (probeDistance < 3) return waypoint.altitude

    const direction = headingToVector(desiredHeading)
    const origin: Vec3 = { x: snapshot.position.x, y: snapshot.position.y, z: snapshot.position.z }
    const hit = context.sandbox.raycast(origin, { x: direction.x, y: 0, z: direction.z }, probeDistance)
    if (!hit || hit.obstacle === null) return waypoint.altitude

    const obstacle = findObstacle(context, hit.obstacle)
    if (!obstacle || !obstacle.solid) return waypoint.altitude

    const overAltitude = obstacle.maxY + OBSTACLE_CLEARANCE_M
    if (overAltitude <= waypoint.altitude) return waypoint.altitude

    this.avoidAltitude = overAltitude
    context.log('warn', `前方 ${hit.distance.toFixed(1)} 米有「${hit.obstacle}」,爬升到 ${overAltitude} 米飞越`)
    return overAltitude
  }

  private beginHolding(context: TaskUpdateContext): void {
    this.stage = 'holding'
    this.stageTime = 0
    // 归中一次即可:摇杆量是状态,不需要每 tick 重复下发
    this.emit(context, PLATFORM_COMMAND.hover, {})
  }

  private beginLanding(context: TaskUpdateContext): void {
    this.stage = 'landing'
    this.stageTime = 0
    this.emit(context, PLATFORM_COMMAND.hover, {})
    this.emit(context, PLATFORM_COMMAND.land, {})
    context.log('info', '航点已全部到达,开始自动降落')
  }

  // ————————————————————————————— 结果 —————————————————————————————

  getResult(): TaskResult | null {
    return this.result
  }

  getSnapshot(): TaskSnapshot {
    const total = this.waypointList.length + 2 // 起飞 + N 个航点 + 降落
    const completed = Math.min(total, (this.stage === 'pending' ? 0 : 1) + this.reached + (this.stage === 'done' ? 1 : 0))
    return {
      id: this.id,
      type: this.type,
      label: this.label,
      status: this.currentStatus,
      agentId: this.agentId,
      progress: {
        completed,
        total,
        stage: this.describeStage(),
      },
      result: this.result,
    }
  }

  private describeStage(): string {
    if (this.stage === 'cruising' || this.stage === 'takingOff') {
      const waypoint = this.waypointList[this.index]
      const suffix = waypoint ? ` → ${waypoint.label}` : ''
      const target = this.avoidAltitude === null ? '' : ` · 绕飞 ${this.avoidAltitude.toFixed(0)} m`
      return `${WAYPOINT_STAGE_LABELS[this.stage]}(${this.index + 1}/${this.waypointList.length})${suffix}${target}`
    }
    return WAYPOINT_STAGE_LABELS[this.stage]
  }

  private complete(context: TaskUpdateContext): void {
    this.stage = 'done'
    this.currentStatus = 'completed'
    this.result = this.buildResult(
      'completed',
      `任务完成:${this.waypointList.length} 个航点全部到达,飞行 ${this.totalTime.toFixed(1)} 秒`,
    )
    context.log('success', this.result.message)
  }

  private fail(context: TaskUpdateContext, reason: string): void {
    this.currentStatus = 'failed'
    this.failureReason = reason
    this.result = this.buildResult('failed', `任务失败:${reason}`)
    context.log('error', this.result.message)
  }

  private buildResult(status: TaskStatus, message: string): TaskResult {
    return {
      taskId: this.id,
      status,
      duration: this.totalTime,
      metrics: {
        waypointsReached: this.reached,
        waypointsTotal: this.waypointList.length,
        distanceFlown: Number(this.distanceFlown.toFixed(2)),
        maxAltitude: Number(this.maxAltitude.toFixed(2)),
      },
      message,
    }
  }

  private emit(context: TaskUpdateContext, type: string, payload: unknown): void {
    context.emitCommand(
      createCommand({
        type,
        sessionId: context.sessionId,
        actorId: 'task',
        simulationTime: context.simulationTime,
        agentId: this.agentId,
        taskId: this.id,
        payload,
      }),
    )
  }

  get failure(): string {
    return this.failureReason
  }
}

function findObstacle(context: TaskUpdateContext, name: string): ObstacleBox | null {
  return context.sandbox.obstacles.find((box) => box.name === name) ?? null
}

/**
 * 给「简单场景」用的一组默认航点。
 *
 * 注意航道高度是**故意**贴着障碍物高度带的:1 号航点 12 米,而建筑 A 高 13 米,
 * 直飞航线正好穿过它 —— 这样默认场景一跑就能看到「探测 → 爬升 → 飞越」的完整行为,
 * 而不是靠把航点摆得四平八稳把问题藏起来。
 */
export function defaultWaypoints(): Waypoint[] {
  return [
    { id: 'wp-1', label: '航点 1 · 东侧空域', x: 26, z: -26, altitude: 12 },
    { id: 'wp-2', label: '航点 2 · 西侧空域', x: -26, z: 24, altitude: 16 },
    { id: 'wp-3', label: '航点 3 · 返航点上方', x: 0, z: 0, altitude: 10 },
  ]
}
