/**
 * GridInspectionTask —— 电网巡检任务(README §10 里那个一直空着的领域任务实现)。
 *
 * 它是 `WaypointTask` 的**领域兄弟**:同一个 `Task` 契约、同一套平台指令
 * (`agent.takeOff / move / hover / land / aimAt`),但作业内容完全不同 ——
 * 航点任务只要求「到达」,巡检任务要求「到达 → 对准 → 看清 → 出结论」。
 *
 * 整场作业的节奏:
 *
 *   ⓪ prepare   等机体上电就绪 → 起飞爬到巡检高度。这一步在实测里被补了两次:
 *                先把「启动即发起飞」改成「先等上电」,再加上「指令被拒就重发」——
 *                因为上电不等于可飞,而契约层没有「命令被拒」的回执(见 updatePreparing)
 *   ① transit   转场飞向悬停位:高度优先 → 机头对准航向 → 按距离推进;前视探测到
 *               高障碍就先爬过去(塔是实体障碍物,不绕会撞)
 *   ② aligning  转机身对准拍摄方位。**这一步不能省**:云台偏航行程只有 ±5°,
 *               机身不转过去,镜头就只能斜着看目标,判定质量直接掉一档
 *   ③ capturing 定点悬停 → `agent.aimAt` 把负载对准部位 → 保持 dwell 秒
 *   ④ record    按**实际位姿**算观测几何(距离/偏心/俯仰/机身偏差)→ 交检测器判定
 *
 * 三条刻意的设计:
 *   · **单点失败不毁全局**:某个拍点转场或对准超时,就把它标记为「未采集」继续往下飞,
 *     最后在报告里如实显示「哪几个部位没拍到」。只有连续多个拍点失败才中止 ——
 *     真实作业里因为一阵风就放弃整条线路是不可接受的。
 *   · **进度按拍点计**:起飞/降落不算节点,巡检的完成度就是拍点数。
 *   · **不做检测**:判定全部交给 `@simulation/power-evaluation` 的判定器,任务只负责
 *     「把可比的观测交给它」。
 *     这样换检测算法(规则 → 视觉模型)不需要动飞行逻辑。
 */
import type {
  AgentId,
  AgentStatus,
  EventLevel,
  Task,
  TaskId,
  TaskResult,
  TaskSnapshot,
  TaskStatus,
  TaskUpdateContext,
  Vec3,
} from '@simulation/contracts'
import { PLATFORM_COMMAND, createCommand, distance3 } from '@simulation/contracts'
import type { PowerLine, PowerTower } from '@simulation/power-domain'
import { truthFor } from '@simulation/power-domain'
import type { InspectionRecord, InspectionReport, PartObservation } from '@simulation/power-evaluation'
import { buildInspectionReport, classifyOutcome, detect } from '@simulation/power-evaluation'
import type { InspectionRoute, RouteShot } from './inspection-route'
import { SEGMENT_TUNING, planApproach, planHeadingHold, planHold, planOrientation } from './flight-control'

export type InspectionStage =
  | 'pending'
  | 'preparing'
  | 'takingOff'
  | 'transit'
  | 'aligning'
  | 'capturing'
  | 'holding'
  | 'landing'
  | 'done'

export const INSPECTION_STAGE_LABELS: Record<InspectionStage, string> = {
  pending: '待启动',
  preparing: '等待机体就绪',
  takingOff: '自动起飞并爬升',
  transit: '转场飞向拍点',
  aligning: '对准拍摄方位',
  capturing: '定点悬停采集',
  holding: '巡检完成悬停',
  landing: '自动降落',
  done: '任务完成',
}

/** 拍点未完成的原因 —— 报告里要能看出「是飞不到还是拍不清」 */
export type SkipReason = 'transitTimeout' | 'alignTimeout' | 'aborted' | 'disabled'

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  transitTimeout: '转场超时,未能抵达拍点',
  alignTimeout: '对准超时,机身未能转到拍摄方位',
  aborted: '任务中止,该拍点未执行',
  disabled: '检查点已禁用,未执行',
}

export interface GridInspectionTaskOptions {
  readonly id: TaskId
  readonly label?: string
  readonly agentId: AgentId
  readonly route: InspectionRoute
  /** 会话种子 —— 检测器靠它复现,必须与 Scenario 的 seed 一致 */
  readonly seed: number
  /** 起飞判定高度(米),默认 1.2 */
  readonly takeoffAltitudeM?: number
  /** 拍点到达判定半径(米),默认 1.5 */
  readonly arriveRadiusM?: number
  /** 高度到位判定(米),默认 0.6 */
  readonly altitudeToleranceM?: number
  /** 机身对准容差(度),默认 8 */
  readonly alignToleranceDeg?: number
  /** 单拍点转场超时(秒),默认 45 */
  readonly transitTimeoutS?: number
  /** 单拍点对准超时(秒),默认 15 */
  readonly alignTimeoutS?: number
  /** 起飞爬升超时(秒),默认 40 */
  readonly takeoffTimeoutS?: number
  /** 降落超时(秒),默认 60 */
  readonly landingTimeoutS?: number
  /** 连续多少个拍点未完成就中止整场巡检,默认 3 */
  readonly maxConsecutiveSkips?: number
  /** 完成后自动降落,默认 true */
  readonly landAtEnd?: boolean
}

const DEFAULT_TUNING = {
  takeoffAltitudeM: 1.2,
  arriveRadiusM: 1.5,
  altitudeToleranceM: 0.6,
  alignToleranceDeg: 8,
  transitTimeoutS: 45,
  alignTimeoutS: 15,
  takeoffTimeoutS: 40,
  landingTimeoutS: 60,
  maxConsecutiveSkips: 3,
} as const

/**
 * 起飞指令重发间隔(秒)。
 *
 * 机体「已上电」不等于「可飞」:自检 / 预热 / 搜星没过时,`autoTakeOff()` 会被
 * 内部检查单拒掉,而且**契约层不提供「命令被拒」的回执** —— 任务发完指令就再也
 * 收不到任何消息。所以只能按「高度没动」这个可观测量重发。间隔取 1 秒而不是
 * 每 tick:重发是补一次可能被丢弃的请求,不是持续施压,发太密只会把事件日志刷成
 * 一片「起飞前检查未通过」。
 */
const TAKEOFF_RETRY_INTERVAL_S = 1

/** 「机体还在地面」的高度判定(米):低于它才认为起飞指令尚未被接受 */
const GROUND_EPSILON_M = 0.25

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI
}

/** 巡检任务:逐塔逐部位飞过去、对准、采集、判定 */
export class GridInspectionTask implements Task {
  readonly id: TaskId
  readonly type = 'grid-inspection'
  readonly label: string
  readonly agentId: AgentId
  /** 本任务执行的航线 —— 报告与界面都要读它 */
  readonly route: InspectionRoute
  readonly seed: number

  private readonly tuning: {
    takeoffAltitudeM: number
    arriveRadiusM: number
    altitudeToleranceM: number
    alignToleranceDeg: number
    transitTimeoutS: number
    alignTimeoutS: number
    takeoffTimeoutS: number
    landingTimeoutS: number
    maxConsecutiveSkips: number
    landAtEnd: boolean
  }

  private currentStatus: TaskStatus = 'pending'
  private stage: InspectionStage = 'pending'
  private stageTime = 0
  private totalTime = 0
  private shotIndex = 0
  private result: TaskResult | null = null
  private failureReason = ''
  private readonly records: InspectionRecord[] = []

  private lastPosition: { x: number; z: number } | null = null
  private distanceFlown = 0
  private maxAltitude = 0
  private startedAtS = 0
  private consecutiveSkips = 0
  private skippedShots = 0
  /** 本航段为绕飞抬高的目标高度(滞回,同 WaypointTask) */
  private avoidAltitude: number | null = null
  /** 本拍点是否已经下发过瞄准指令 */
  private aimIssued = false
  /** 起飞指令重发倒计时(秒) */
  private takeoffRetryTimer = 0
  /** 是否已经就「起飞指令未被接受」提示过一次 —— 提示只该出现一次,不该跟着重发刷屏 */
  private takeoffRetryNoted = false

  constructor(options: GridInspectionTaskOptions) {
    if (options.route.shots.length === 0) throw new Error('GridInspectionTask 的航线里没有任何拍点')
    this.id = options.id
    this.label = options.label ?? `电网巡检 · ${options.route.line.label}`
    this.agentId = options.agentId
    this.route = options.route
    this.seed = options.seed
    this.tuning = {
      takeoffAltitudeM: options.takeoffAltitudeM ?? DEFAULT_TUNING.takeoffAltitudeM,
      arriveRadiusM: options.arriveRadiusM ?? DEFAULT_TUNING.arriveRadiusM,
      altitudeToleranceM: options.altitudeToleranceM ?? DEFAULT_TUNING.altitudeToleranceM,
      alignToleranceDeg: options.alignToleranceDeg ?? DEFAULT_TUNING.alignToleranceDeg,
      transitTimeoutS: options.transitTimeoutS ?? DEFAULT_TUNING.transitTimeoutS,
      alignTimeoutS: options.alignTimeoutS ?? DEFAULT_TUNING.alignTimeoutS,
      takeoffTimeoutS: options.takeoffTimeoutS ?? DEFAULT_TUNING.takeoffTimeoutS,
      landingTimeoutS: options.landingTimeoutS ?? DEFAULT_TUNING.landingTimeoutS,
      maxConsecutiveSkips: options.maxConsecutiveSkips ?? DEFAULT_TUNING.maxConsecutiveSkips,
      landAtEnd: options.landAtEnd ?? true,
    }
  }

  // ————————————————————————————— 生命周期 —————————————————————————————

  get status(): TaskStatus {
    return this.currentStatus
  }

  get currentStage(): InspectionStage {
    return this.stage
  }

  /** 已采集的部位记录(报告的原材料),以只读视图返回 */
  getRecords(): ReadonlyArray<InspectionRecord> {
    return this.records
  }

  get currentShot(): RouteShot | null {
    return this.route.shots[this.shotIndex] ?? null
  }

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

  abort(reason = '巡检任务已中止'): void {
    if (this.currentStatus === 'completed' || this.currentStatus === 'aborted') return
    this.currentStatus = 'aborted'
    this.failureReason = reason
    this.result = this.buildResult('aborted', reason, null)
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

    const position = snapshot.position
    this.maxAltitude = Math.max(this.maxAltitude, position.y)
    if (this.lastPosition) {
      this.distanceFlown += Math.hypot(position.x - this.lastPosition.x, position.z - this.lastPosition.z)
    }
    this.lastPosition = { x: position.x, z: position.z }

    switch (this.stage) {
      case 'pending':
        this.startedAtS = context.simulationTime
        this.stage = 'preparing'
        this.stageTime = 0
        context.log(
          'info',
          `巡检开始:${this.route.line.label} · ${this.route.shots.length} 个拍点 / ${this.route.parts.length} 个部位,镜头 ${this.route.lensZoom}×`,
        )
        break

      case 'preparing':
        this.updatePreparing(context, snapshot.status)
        break

      case 'takingOff':
        this.updateTakingOff(context, position, snapshot.status)
        break

      case 'transit':
        this.updateTransit(context, snapshot.headingDeg, position)
        break

      case 'aligning':
        this.updateAligning(context, snapshot.headingDeg, position)
        break

      case 'capturing':
        this.updateCapturing(context, snapshot.headingDeg, position)
        break

      case 'holding':
        if (this.tuning.landAtEnd) this.beginLanding(context)
        else this.complete(context, context.simulationTime)
        break

      case 'landing':
        if (position.y <= 0.05) this.complete(context, context.simulationTime)
        else if (this.stageTime > this.tuning.landingTimeoutS) {
          this.fail(context, `降落超时(${this.tuning.landingTimeoutS} 秒)`)
        }
        break

      case 'done':
        break
    }
  }

  /**
   * 等机体上电就绪,再发起飞指令。
   *
   * 这一步是实测补出来的。原先这里是「任务启动即发起飞」,而实际操作是:会话打开
   * 页面就自动上电(见 `use-sandbox-simulation` 的 `autoStart` 分支),但
   * **自检 / 预热 / 搜星还要跑几秒** —— 这几秒里 `autoTakeOff()` 会被内部检查单
   * 拒掉。契约层没有「命令被拒」的回执,任务发完就把这件事忘了,于是原地空等满
   * 整个超时窗口,最后报出「起飞爬升超时(40 秒未到达 32 米)」,把「机体还没准备好」
   * 说成了「飞不起来」。
   *
   * 判据用契约层的 `AgentStatus`:它已经区分了「未上电」与「已上电」,所以任务
   * 不必去猜、也不必知道是哪种载具。上电之后仍有自检要过,那一段交给
   * `updateTakingOff()` 的重发去覆盖。
   */
  private updatePreparing(context: TaskUpdateContext, status: AgentStatus): void {
    if (status !== 'active') {
      if (this.stageTime > this.tuning.takeoffTimeoutS) {
        this.fail(
          context,
          `等待机体就绪超时(${this.tuning.takeoffTimeoutS} 秒:机体未上电或处于禁飞状态)`,
        )
      }
      return
    }
    this.stage = 'takingOff'
    this.stageTime = 0
    // 首次指令刚发出去,重发要等一个间隔 —— 否则下一 tick 就会立刻再发一条
    this.takeoffRetryTimer = TAKEOFF_RETRY_INTERVAL_S
    this.takeoffRetryNoted = false
    this.emit(context, PLATFORM_COMMAND.takeOff, {})
  }

  /**
   * 起飞后原地爬到巡检高度。高度不够就水平机动会撞进塔身高度带,所以只动升降。
   *
   * 这里做了一件契约层没能力做、但作业必需的事:**确认起飞指令真的被接受了**。
   * 机体上电 ≠ 机体可飞 —— 自检 / 预热 / 搜星未过时起飞会被拒,而任务收不到回执。
   * 能观测到的只有「高度没动」,所以就按它重发,直到真离地。只在地面高度重发:
   * 一旦离地就说明指令已被接受,再发只是往指令流里灌噪声。
   */
  private updateTakingOff(context: TaskUpdateContext, position: Vec3, status: AgentStatus): void {
    const target = this.route.cruiseAltitudeM
    if (position.y >= target - this.tuning.altitudeToleranceM) {
      this.stage = 'transit'
      this.stageTime = 0
      this.avoidAltitude = null
      context.log('success', `已爬升至 ${position.y.toFixed(1)} 米巡检高度,开始逐塔巡检`)
      return
    }
    if (this.stageTime > this.tuning.takeoffTimeoutS) {
      this.fail(context, `起飞爬升超时(${this.tuning.takeoffTimeoutS} 秒未到达 ${target} 米)`)
      return
    }

    if (status === 'active' && position.y < GROUND_EPSILON_M) {
      this.takeoffRetryTimer -= context.deltaTime
      if (this.takeoffRetryTimer <= 0) {
        this.takeoffRetryTimer = TAKEOFF_RETRY_INTERVAL_S
        if (!this.takeoffRetryNoted) {
          this.takeoffRetryNoted = true
          context.log('warn', '机体尚未接受起飞指令(起飞前检查未完成),任务保持重试')
        }
        this.emit(context, PLATFORM_COMMAND.takeOff, {})
      }
    }

    const up = clamp((target - position.y) / SEGMENT_TUNING.altitudeFullScaleM, SEGMENT_TUNING.maxDescendCommand, 1)
    this.emit(context, PLATFORM_COMMAND.move, { forward: 0, right: 0, up, yawRate: 0 })
  }

  private updateTransit(context: TaskUpdateContext, headingDeg: number, position: Vec3): void {
    const shot = this.route.shots[this.shotIndex]
    if (!shot) {
      this.beginHolding(context)
      return
    }

    // 被禁用的检查点不飞:直接记「未采集」跳过,而且**不算连续失败** ——
    // 那是作业计划里的取舍,不是执行出了故障,不该把整场巡检拖进中止。
    // 它的部位仍然留在航线里,所以覆盖率会如实掉下来(用例 B)。
    if (!shot.enabled) {
      this.skipShot(context, shot, 'disabled', position, { countAsSkip: false })
      return
    }

    const solution = planApproach({
      position,
      headingDeg,
      target: shot.hover,
      arriveRadiusM: this.tuning.arriveRadiusM,
      altitudeToleranceM: this.tuning.altitudeToleranceM,
      avoidAltitudeM: this.avoidAltitude,
      probeAhead: (direction, maxDistanceM) => this.probeAhead(context, position, direction, maxDistanceM),
    })
    if (solution.advisory) context.log('warn', solution.advisory)
    this.avoidAltitude = solution.avoidAltitudeM

    if (solution.arrived) {
      this.stage = 'aligning'
      this.stageTime = 0
      this.emit(context, PLATFORM_COMMAND.hover, {})
      return
    }

    if (this.stageTime > this.tuning.transitTimeoutS) {
      this.skipShot(context, shot, 'transitTimeout', position)
      return
    }

    this.emit(context, PLATFORM_COMMAND.move, solution.command)
  }

  /**
   * 转机身对准拍摄方位。
   *
   * 云台偏航只有 ±5°,机身不转到位就只能斜着看 —— 所以这一步是**判定质量的前提**,
   * 不是「锦上添花的姿态调整」。对准超时同样按「未采集」处理,而不是硬拍一张。
   */
  private updateAligning(context: TaskUpdateContext, headingDeg: number, position: Vec3): void {
    const shot = this.route.shots[this.shotIndex]
    if (!shot) {
      this.beginHolding(context)
      return
    }

    const orientation = planOrientation({
      headingDeg,
      desiredHeadingDeg: shot.headingDeg,
      toleranceDeg: this.tuning.alignToleranceDeg,
    })

    if (orientation.aligned) {
      this.stage = 'capturing'
      this.stageTime = 0
      this.aimIssued = false
      context.log('info', `已对准拍摄方位(${shot.label})`)
      return
    }

    if (this.stageTime > this.tuning.alignTimeoutS) {
      this.skipShot(context, shot, 'alignTimeout', position)
      return
    }

    // 对准期间同时保持位置:只转机身的画法会让机体随风漂出去
    const hold = planHold({
      position,
      headingDeg,
      holdPoint: shot.hover,
      toleranceM: this.tuning.arriveRadiusM,
    })
    this.emit(context, PLATFORM_COMMAND.move, { ...hold.command, yawRate: orientation.yawRate })
  }

  /** 定点悬停采集:下发瞄准 → 按住悬停位 → 采集时长到点后落记录 */
  private updateCapturing(context: TaskUpdateContext, headingDeg: number, position: Vec3): void {
    const shot = this.route.shots[this.shotIndex]
    if (!shot) {
      this.beginHolding(context)
      return
    }

    if (!this.aimIssued) {
      this.aimIssued = true
      this.emit(context, PLATFORM_COMMAND.aimAt, {
        x: shot.aim.x,
        y: shot.aim.y,
        z: shot.aim.z,
        label: `${shot.towerLabel} · ${shot.parts.map((part) => part.label).join(' / ')}`,
        track: true,
      })
      context.log('info', `锁定拍摄目标:${shot.label}`)
    }

    // 位置保持 + 航向保持(采集期间画面抖一下就判废,值得每 tick 修)
    const hold = planHold({
      position,
      headingDeg,
      holdPoint: shot.hover,
      toleranceM: this.tuning.arriveRadiusM,
    })
    const yawRate = planHeadingHold({ headingDeg, desiredHeadingDeg: shot.headingDeg })
    this.emit(context, PLATFORM_COMMAND.move, { ...hold.command, yawRate })

    if (this.stageTime >= this.route.dwellSeconds) {
      this.recordShot(context, shot, headingDeg, position)
      this.advanceShot(context)
    }
  }

  // ————————————————————————————— 记录与判定 —————————————————————————————

  /**
   * 落一条采集记录:按**实际位姿**算观测几何,再交检测器。
   *
   * 这里刻意不用航线里的理想值(悬停点、期望航向),全部从快照现算 ——
   * 报告要回答的是「当时到底拍成什么样」,而不是「本来打算拍成什么样」。
   */
  private recordShot(context: TaskUpdateContext, shot: RouteShot, headingDeg: number, position: Vec3): void {
    const tower = this.findTower(shot.towerId)
    const weather = context.sandbox.getWeather()
    const wind = context.sandbox.getWind()

    // 镜头光轴:悬停位看向对准位
    const axisRaw = {
      x: shot.aim.x - position.x,
      y: shot.aim.y - position.y,
      z: shot.aim.z - position.z,
    }
    const axisLength = Math.max(Math.hypot(axisRaw.x, axisRaw.y, axisRaw.z), 1e-6)
    const axis = { x: axisRaw.x / axisLength, y: axisRaw.y / axisLength, z: axisRaw.z / axisLength }
    const tiltDeg = radToDeg(Math.atan2(axisRaw.y, Math.hypot(axisRaw.x, axisRaw.z)))
    const headingErrorDeg = shortestAngle(headingDeg, shot.headingDeg)

    let alarms = 0
    for (const part of shot.parts) {
      const toPart = {
        x: part.target.x - position.x,
        y: part.target.y - position.y,
        z: part.target.z - position.z,
      }
      const rangeM = distance3(position, part.target)
      const length = Math.max(Math.hypot(toPart.x, toPart.y, toPart.z), 1e-6)
      const cos = clamp(
        (axis.x * toPart.x + axis.y * toPart.y + axis.z * toPart.z) / length,
        -1,
        1,
      )
      const observation: PartObservation = {
        rangeM,
        offAxisDeg: radToDeg(Math.acos(cos)),
        tiltDeg,
        headingErrorDeg,
      }

      const truth = tower ? truthFor(tower, part.partId) : null
      const detection = detect({
        towerId: shot.towerId,
        partId: part.partId,
        partKind: part.kind,
        criticalSizeM: part.criticalSizeM,
        truth,
        observation,
        lensZoom: this.route.lensZoom,
        weather,
        windSpeedMps: wind.speed,
        seed: this.seed,
      })

      const outcome = classifyOutcome(detection.verdict, truth)
      if (detection.verdict !== 'ok') alarms += 1
      this.records.push({
        shotId: shot.id,
        towerId: shot.towerId,
        towerLabel: shot.towerLabel,
        partId: part.id,
        partLabel: part.label,
        partKind: part.kind,
        simulationTime: context.simulationTime,
        dronePosition: { ...position },
        observation,
        detection,
        truth,
        outcome,
      })
    }

    this.consecutiveSkips = 0
    const level: EventLevel = alarms > 0 ? 'warn' : 'success'
    context.log(
      level,
      `${shot.label} 采集完成:${shot.parts.length} 个部位${alarms > 0 ? `,${alarms} 项需关注` : ',未见异常'}`,
    )
  }

  /** 拍点未完成:把它的部位全部记为「未采集」,报告里才不会凭空多出覆盖率 */
  private skipShot(
    context: TaskUpdateContext,
    shot: RouteShot,
    reason: SkipReason,
    position: Vec3,
    options: { readonly countAsSkip?: boolean } = {},
  ): void {
    const countsAsSkip = options.countAsSkip ?? true
    const note = SKIP_REASON_LABELS[reason]
    for (const part of shot.parts) {
      this.records.push({
        shotId: shot.id,
        towerId: shot.towerId,
        towerLabel: shot.towerLabel,
        partId: part.id,
        partLabel: part.label,
        partKind: part.kind,
        simulationTime: context.simulationTime,
        dronePosition: { ...position },
        observation: null,
        detection: {
          verdict: 'unchecked',
          kind: null,
          severity: null,
          confidence: 0,
          quality: {
            featurePixels: 0,
            resolution: 0,
            offAxis: 0,
            tilt: 0,
            aim: 0,
            weather: 0,
            wind: 0,
            quality: 0,
          },
          note,
        },
        truth: null,
        outcome: 'unchecked',
      })
    }
    this.skippedShots += 1
    if (countsAsSkip) this.consecutiveSkips += 1
    // 禁用是计划内的取舍,不该跟「飞不到」一样报错 —— 但它确实拉低了覆盖率
    context.log(reason === 'disabled' ? 'warn' : 'error', `${shot.label} ${note},该拍点 ${shot.parts.length} 个部位记为未采集`)

    if (countsAsSkip && this.consecutiveSkips >= this.tuning.maxConsecutiveSkips) {
      this.fail(
        context,
        `连续 ${this.consecutiveSkips} 个拍点未能完成(${note}),巡检中止:已采集 ${this.records.filter((record) => record.outcome !== 'unchecked').length} 个部位`,
      )
      return
    }
    this.advanceShot(context)
  }

  /** 切到下一个拍点;没有下一个就进入收尾 */
  private advanceShot(context: TaskUpdateContext): void {
    this.shotIndex += 1
    this.stageTime = 0
    this.avoidAltitude = null
    this.aimIssued = false
    this.emit(context, PLATFORM_COMMAND.hover, {})
    if (this.shotIndex >= this.route.shots.length) this.beginHolding(context)
    else this.stage = 'transit'
  }

  private beginHolding(context: TaskUpdateContext): void {
    this.stage = 'holding'
    this.stageTime = 0
    this.emit(context, PLATFORM_COMMAND.clearAim, { reason: '巡检拍点执行完毕' })
    const checked = this.records.filter((record) => record.outcome !== 'unchecked').length
    const alarms = this.records.filter(
      (record) => record.detection.verdict === 'defect' || record.detection.verdict === 'suspect',
    ).length
    context.log(
      'success',
      `全部拍点执行完毕:采集 ${checked} / ${this.route.parts.length} 个部位,${alarms} 项需关注`,
    )
  }

  private beginLanding(context: TaskUpdateContext): void {
    this.stage = 'landing'
    this.stageTime = 0
    this.emit(context, PLATFORM_COMMAND.hover, {})
    this.emit(context, PLATFORM_COMMAND.land, {})
    context.log('info', '开始自动降落')
  }

  // ————————————————————————————— 结果与快照 —————————————————————————————

  private complete(context: TaskUpdateContext, simulationTime: number): void {
    this.stage = 'done'
    this.currentStatus = 'completed'
    this.result = this.buildResult('completed', '巡检任务完成', simulationTime)
    context.log('success', this.result.message)
  }

  private fail(context: TaskUpdateContext, reason: string): void {
    this.currentStatus = 'failed'
    this.failureReason = reason
    this.stage = 'done'
    this.result = this.buildResult('failed', `巡检失败:${reason}`, context.simulationTime)
    context.log('error', this.result.message)
  }

  private buildResult(status: TaskStatus, message: string, simulationTime: number | null): TaskResult {
    const checked = this.records.filter((record) => record.outcome !== 'unchecked')
    const truePositive = checked.filter((record) => record.outcome === 'truePositive').length
    const falsePositive = checked.filter((record) => record.outcome === 'falsePositive').length
    const missed = checked.filter((record) => record.outcome === 'missed').length
    const truthDefects = checked.filter((record) => record.truth !== null).length

    const metrics: Record<string, number> = {
      shotsTotal: this.route.shots.length,
      shotsTaken: new Set(checked.map((record) => record.shotId)).size,
      shotsSkipped: this.skippedShots,
      shotsDisabled: this.route.shots.filter((shot) => !shot.enabled).length,
      partsTotal: this.route.parts.length,
      partsChecked: checked.length,
      coverage: this.route.parts.length === 0 ? 0 : Number(((checked.length / this.route.parts.length) * 100).toFixed(1)),
      defectsReported: checked.filter((record) => record.detection.verdict === 'defect').length,
      suspects: checked.filter((record) => record.detection.verdict === 'suspect').length,
      truthDefects,
      truePositive,
      missed,
      falsePositive,
      distanceFlown: Number(this.distanceFlown.toFixed(1)),
      maxAltitude: Number(this.maxAltitude.toFixed(1)),
      durationS: Number((simulationTime === null ? this.totalTime : simulationTime - this.startedAtS).toFixed(1)),
    }
    if (truePositive + missed > 0) {
      metrics['recall'] = Number(((truePositive / (truePositive + missed)) * 100).toFixed(1))
    }
    if (truePositive + falsePositive > 0) {
      metrics['precision'] = Number(((truePositive / (truePositive + falsePositive)) * 100).toFixed(1))
    }

    return {
      taskId: this.id,
      status,
      duration: Number(this.totalTime.toFixed(1)),
      metrics,
      message,
    }
  }

  getResult(): TaskResult | null {
    return this.result
  }

  getSnapshot(): TaskSnapshot {
    return {
      id: this.id,
      type: this.type,
      label: this.label,
      status: this.currentStatus,
      agentId: this.agentId,
      progress: {
        // 进度按**拍点**计:巡检的完成度就是拍点数,不把起飞降落算成节点
        completed: Math.min(this.shotIndex, this.route.shots.length),
        total: this.route.shots.length,
        stage: this.describeStage(),
      },
      result: this.result,
    }
  }

  private describeStage(): string {
    const shot = this.currentShot
    const position = `${Math.min(this.shotIndex + 1, this.route.shots.length)}/${this.route.shots.length}`
    switch (this.stage) {
      case 'transit':
        return shot ? `${INSPECTION_STAGE_LABELS.transit}(${position})→ ${shot.towerLabel}` : INSPECTION_STAGE_LABELS.transit
      case 'aligning':
        return shot ? `${INSPECTION_STAGE_LABELS.aligning}(${position})· ${shot.towerLabel}` : INSPECTION_STAGE_LABELS.aligning
      case 'capturing':
        return shot
          ? `${INSPECTION_STAGE_LABELS.capturing}(${position})· ${Math.min(this.stageTime, this.route.dwellSeconds).toFixed(1)}/${this.route.dwellSeconds} s`
          : INSPECTION_STAGE_LABELS.capturing
      default:
        return INSPECTION_STAGE_LABELS[this.stage]
    }
  }

  // ————————————————————————————— 工具 —————————————————————————————

  private findTower(towerId: string): PowerTower | undefined {
    const line: PowerLine = this.route.line
    return line.towers.find((tower) => tower.id === towerId)
  }

  /** 前方探测 —— 与 WaypointTask 同一条路子:只认实体障碍物 */
  private probeAhead(
    context: TaskUpdateContext,
    position: Vec3,
    direction: { x: number; z: number },
    maxDistanceM: number,
  ): { label: string; maxY: number; distanceM: number } | null {
    const hit = context.sandbox.raycast(
      { x: position.x, y: position.y, z: position.z },
      { x: direction.x, y: 0, z: direction.z },
      maxDistanceM,
    )
    if (!hit || hit.obstacle === null) return null
    const obstacle = context.sandbox.obstacles.find((box) => box.name === hit.obstacle)
    if (!obstacle || !obstacle.solid) return null
    return { label: hit.obstacle, maxY: obstacle.maxY, distanceM: hit.distance }
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

  /** 巡检起点(仿真时间),报告要用 */
  get startedAt(): number {
    return this.startedAtS
  }

  /**
   * 生成巡检报告 —— 巡检进行中也能取,拿到的是**当前进度**的截面。
   *
   * `generatedAt` 必须由调用方传入(墙钟时间不属于仿真,包内取时间会破坏 §75 的
   * 「同输入同结果」)。运行中取报告时状态标为 `inProgress`,不假装已经完成。
   */
  report(input: { generatedAt: string; sessionLabel: string; scenarioId: string }): InspectionReport {
    const status: InspectionReport['status'] =
      this.currentStatus === 'completed'
        ? 'completed'
        : this.currentStatus === 'failed'
          ? 'failed'
          : this.currentStatus === 'aborted'
            ? 'aborted'
            : 'inProgress'
    const message =
      status === 'inProgress'
        ? `巡检进行中:${Math.min(this.shotIndex, this.route.shots.length)} / ${this.route.shots.length} 个拍点`
        : (this.result?.message ?? this.failureReason)

    return buildInspectionReport({
      route: this.route,
      records: this.records,
      status,
      message,
      sessionLabel: input.sessionLabel,
      scenarioId: input.scenarioId,
      taskLabel: this.label,
      startedAtS: this.startedAtS,
      finishedAtS: this.startedAtS + this.totalTime,
      maxAltitudeM: this.maxAltitude,
      generatedAt: input.generatedAt,
    })
  }

  /** 其它模块读航线里程够了就够:这里只做一次转发,避免调用方各写一遍 */
  get plannedTransitLengthM(): number {
    return this.route.transitLengthM
  }
}

function shortestAngle(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180
}
