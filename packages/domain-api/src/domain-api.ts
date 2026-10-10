/**
 * SimulationDomainAPI —— 所有外部业务操作的唯一入口(README §24 / §62 / §82)。
 *
 *   UI / MCP / REST / WebSocket / SDK / AI Agent / Automation
 *        ↓
 *   SimulationDomainAPI
 *        ↓
 *   Authority(校验)  →  Command(请求)  →  Simulation Runtime
 *        ↓
 *   State  →  Snapshot  →  Renderer / Recorder / Realtime
 *
 * 外部**不允许**直接修改 Agent State / Task State / Simulation State,
 * 也不提供任何 Direct State Mutation API。所有写操作都必须是一条 Command。
 *
 * Human 与 AI 走完全相同的一条路(README §69)。
 */
import type {
  Agent,
  AgentId,
  AgentSnapshot,
  AgentType,
  AgentViewProjector,
  Command,
  EventLevel,
  RuntimeStatus,
  SessionDescriptor,
  SessionId,
  SimEvent,
  SimulationSnapshot,
  TaskId,
  TaskResult,
  TaskSnapshot,
  WeatherKind,
} from '@simulation/contracts'
import { PLATFORM_COMMAND, createCommand } from '@simulation/contracts'
import type { RuntimeStats } from '@simulation/simulation-core'
import { SimulationRuntime } from '@simulation/simulation-core'
import { AgentRegistry } from '@simulation/agent-core'
import type { AgentSeed, ObstacleDefinition, Scenario } from '@simulation/sandbox-core'
import { StaticSandbox, createSandboxFromScenario, defaultScenario } from '@simulation/sandbox-core'
import type { Waypoint } from '@simulation/task-core'
import { WaypointTask, defaultWaypoints } from '@simulation/task-core'
import type { DroneAgentOptions, DroneSnapshot } from '@simulation/drone-agent'
import { DroneAgent, harvestDroneEvents, projectDroneRenderView, readDroneTelemetry } from '@simulation/drone-agent'
import type { VehicleAgentOptions, VehicleSnapshot } from '@simulation/vehicle-agent'
import {
  VehicleAgent,
  harvestVehicleEvents,
  projectVehicleRenderView,
  readVehicleTelemetry,
} from '@simulation/vehicle-agent'
import type { AgentTrack, RecorderStats } from '@simulation/recorder'
import { SimulationRecorder } from '@simulation/recorder'
import type { InspectionRecord, InspectionReport } from '@simulation/power-evaluation'
import type { InspectionRoute } from '@simulation/grid-inspection'
import { GridInspectionTask } from '@simulation/grid-inspection'

// ————————————————————————————— Authority —————————————————————————————

export interface AuthorityRequest {
  readonly command: Command
  readonly actorId: string
  readonly simulationTime: number
  readonly isRunning: boolean
  readonly hasAgent: (id: AgentId) => boolean
  readonly hasTask: (id: TaskId) => boolean
}

export interface AuthorityDecision {
  readonly allowed: boolean
  readonly reason: string
}

export type AuthorityPolicy = (request: AuthorityRequest) => AuthorityDecision

/**
 * 默认操作规则(README §18 的 canXxx 系列的第一版实现):
 *   · 指令目标 Agent 必须存在
 *   · 任务控制指令的目标 Task 必须存在
 * 后续接多人协同时,在这里叠加角色权限与 Control Token 判定,调用方无需改动。
 */
export const defaultAuthorityPolicy: AuthorityPolicy = (request) => {
  const { command } = request
  if (command.agentId !== undefined && !request.hasAgent(command.agentId)) {
    return { allowed: false, reason: `目标 Agent 不存在:${command.agentId}` }
  }
  if (command.type.startsWith('task.') && command.taskId !== undefined && !request.hasTask(command.taskId)) {
    return { allowed: false, reason: `目标任务不存在:${command.taskId}` }
  }
  return { allowed: true, reason: '' }
}

// ————————————————————————————— 领域装配 —————————————————————————————

/**
 * 领域装配 —— 「这个会话跑哪种载体」的全部差异都收在这一个对象里。
 *
 * 之所以要这层:在此之前 SimulationDomainAPI 直接写死 `new DroneAgent` 与
 * `projectDroneRenderView`,于是平台虽然契约上支持 vehicle / boat / robot,
 * 运行时却只能跑无人机 —— 应用层想换载具无处可换。
 *
 * 有了 binding,加船/机器人 = 再写一个 binding,本文件一行都不用改;
 * 而会话本身的 Runtime / Recorder / Authority / Sandbox 那套机制完全复用。
 */
export interface DomainBinding {
  /** 本装配负责的载具类型 */
  readonly kind: AgentType
  /** 按场景里的 agent seed 建 Agent;不认领的 seed 返回 null(一个场景可以混编) */
  createAgent(seed: AgentSeed, options: SimulationSessionOptions): Agent | null
  /** AgentSnapshot → AgentRenderView,由领域包提供 */
  readonly projector: AgentViewProjector
  /** 从快照里收割领域事件 */
  readonly harvestEvents: (snapshot: SimulationSnapshot) => ReadonlyArray<SimEvent>
}

const droneBinding: DomainBinding = {
  kind: 'drone',
  createAgent: (seed, options) => {
    if (seed.kind !== 'drone') return null
    return new DroneAgent({
      ...options.drone,
      id: seed.id,
      label: seed.label ?? options.drone?.label,
      origin: { x: seed.x ?? 0, y: seed.y ?? 0, z: seed.z ?? 0 },
      headingDeg: seed.headingDeg ?? 0,
    })
  },
  projector: projectDroneRenderView,
  harvestEvents: harvestDroneEvents,
}

const vehicleBinding: DomainBinding = {
  kind: 'vehicle',
  createAgent: (seed, options) => {
    if (seed.kind !== 'vehicle') return null
    return new VehicleAgent({
      ...options.vehicle,
      id: seed.id,
      label: seed.label ?? options.vehicle?.label,
      origin: { x: seed.x ?? 0, y: seed.y ?? 0, z: seed.z ?? 0 },
      headingDeg: seed.headingDeg ?? 0,
    })
  },
  projector: projectVehicleRenderView,
  harvestEvents: harvestVehicleEvents,
}

/** 内置装配表 —— 应用层按场景 id 或用户选择挑一个 */
export const DOMAIN_BINDINGS = {
  drone: droneBinding,
  vehicle: vehicleBinding,
} as const

// ————————————————————————————— 会话配置 —————————————————————————————

export interface SimulationSessionOptions {
  readonly scenario?: Scenario
  readonly label?: string
  readonly fixedDeltaTime?: number
  readonly maxStepsPerFrame?: number
  readonly timeScale?: number
  /** 无人机初始参数(出厂机臂收纳等);会被 Scenario 的出生点覆盖 */
  readonly drone?: Partial<DroneAgentOptions>
  /** 汽车初始参数;同样会被 Scenario 的出生点覆盖 */
  readonly vehicle?: Partial<VehicleAgentOptions>
  /**
   * 领域装配 —— 决定这个会话跑哪种载体。
   * 不传 = 无人机(保持既有调用方行为不变);跑汽车传 `DOMAIN_BINDINGS.vehicle`。
   */
  readonly domain?: DomainBinding
  readonly authority?: AuthorityPolicy
  /** AgentTrack 采样率,默认 20 Hz */
  readonly sampleHz?: number
  /** 构造后自动启动仿真 */
  readonly autoStart?: boolean
}

export interface ExecuteCommandInput {
  readonly type: string
  readonly agentId?: AgentId
  readonly taskId?: TaskId
  readonly payload?: unknown
  readonly actorId?: string
}

export interface CreateWaypointTaskInput {
  readonly id?: TaskId
  readonly label?: string
  readonly agentId?: AgentId
  readonly waypoints?: ReadonlyArray<Waypoint>
  /** 起飞判定高度(米);任务会在此之上继续爬升到首个航点的高度再开始巡航 */
  readonly takeoffAltitude?: number
  readonly holdSeconds?: number
  readonly landAtEnd?: boolean
}

/**
 * 创建巡检任务的入参。
 *
 * `route` 由调用方传进来,而不是在这里根据场景现算 —— 因为「用多大镜头、每个拍点停多久」
 * 是**作业方案**,属于使用方的决定(§3.3 Package First:包提供能力,应用做组合)。
 * 任务拿到方案后就完全自主,不再依赖任何外部状态。
 */
export interface CreateGridInspectionTaskInput {
  readonly id?: TaskId
  readonly label?: string
  readonly agentId?: AgentId
  readonly route: InspectionRoute
  /** 判定用种子;不传 = 用场景种子,保证同场景同结论 */
  readonly seed?: number
  readonly transitTimeoutS?: number
  readonly alignTimeoutS?: number
  readonly maxConsecutiveSkips?: number
  readonly landAtEnd?: boolean
}

let sessionSeq = 0
let taskSeq = 0

export class SimulationDomainAPI {
  readonly session: SessionDescriptor
  readonly scenario: Scenario
  readonly sandbox: StaticSandbox
  readonly runtime: SimulationRuntime
  readonly recorder: SimulationRecorder
  readonly agents = new AgentRegistry()

  private readonly authority: AuthorityPolicy
  private readonly binding: DomainBinding
  private readonly detachRecorder: () => void

  constructor(options: SimulationSessionOptions = {}) {
    const scenario = options.scenario ?? defaultScenario()
    this.scenario = scenario
    sessionSeq += 1
    this.session = {
      sessionId: `session-${String(sessionSeq).padStart(2, '0')}`,
      scenarioId: scenario.id,
      seed: scenario.seed,
      label: options.label ?? scenario.label,
    }

    // Scenario --load--> Sandbox
    this.sandbox = createSandboxFromScenario(scenario)

    this.runtime = new SimulationRuntime({
      session: this.session,
      environment: this.sandbox,
      fixedDeltaTime: options.fixedDeltaTime,
      maxStepsPerFrame: options.maxStepsPerFrame,
      timeScale: options.timeScale,
    })

    // 载具类型在此分岔:同一个 Session 机制,不同的领域装配
    this.binding = options.domain ?? droneBinding
    for (const seed of scenario.agents) {
      const agent = this.binding.createAgent(seed, options)
      if (agent) this.registerAgent(agent)
    }

    this.authority = options.authority ?? defaultAuthorityPolicy
    this.recorder = new SimulationRecorder({
      sampleHz: options.sampleHz,
      harvestEvents: this.binding.harvestEvents,
    })
    this.detachRecorder = this.recorder.attach({
      snapshots: this.runtime.snapshots,
      commands: this.runtime.commands,
    })

    this.runtime.emit('info', 'session.created', `会话已创建:${this.session.label} · 场景 ${scenario.id}`)
    if (options.autoStart) this.start()
  }

  /** 渲染投影函数由领域包提供,应用层直接把它交给渲染适配器 */
  get projector(): AgentViewProjector {
    return this.binding.projector
  }

  /** 当前会话的载具类型 —— 应用层据此决定加载哪个机体视图与哪套 HUD */
  get agentKind(): AgentType {
    return this.binding.kind
  }

  get obstacles(): ReadonlyArray<ObstacleDefinition> {
    return this.scenario.obstacles
  }

  // ————————————————————————————— Session API —————————————————————————————

  start(): void {
    this.runtime.start()
  }

  pause(): void {
    this.runtime.pause()
  }

  resume(): void {
    this.runtime.resume()
  }

  get isRunning(): boolean {
    return this.runtime.currentStatus === 'running'
  }

  /** 会话运行状态 —— 外部只需要知道「跑没跑」,不需要认识 Runtime */
  get status(): RuntimeStatus {
    return this.runtime.currentStatus
  }

  get stats(): RuntimeStats {
    return this.runtime.stats
  }

  get recorderStats(): RecorderStats {
    return this.recorder.getStats()
  }

  /** 由渲染循环驱动:投入真实经过时间,返回本帧执行的固定步数 */
  advance(realDeltaSeconds: number): number {
    return this.runtime.advance(realDeltaSeconds)
  }

  /** 手动推进固定步数(测试 / 无头验证用) */
  step(steps = 1): void {
    this.runtime.step(steps)
  }

  setTimeScale(scale: number): void {
    this.runtime.setTimeScale(scale)
  }

  getSnapshot(): SimulationSnapshot {
    return this.runtime.getSnapshot()
  }

  onSnapshot(listener: (snapshot: SimulationSnapshot) => void): () => void {
    return this.runtime.snapshots.subscribe(listener)
  }

  // ————————————————————————————— Agent API —————————————————————————————

  registerAgent(agent: Agent): boolean {
    if (!this.agents.register(agent)) return false
    this.runtime.addAgent(agent)
    return true
  }

  removeAgent(id: AgentId): boolean {
    if (!this.agents.unregister(id)) return false
    this.runtime.removeAgent(id)
    return true
  }

  getAgent<TPayload = unknown>(id: AgentId): Agent<TPayload> | undefined {
    return this.agents.get<TPayload>(id)
  }

  getAgentState(id: AgentId): AgentSnapshot | undefined {
    return this.runtime.getAgentSnapshot(id)
  }

  /** 便捷入口:读无人机遥测(领域收窄在 drone-agent 里完成) */
  getDroneTelemetry(id?: AgentId): DroneSnapshot | undefined {
    const target = id ?? this.primaryDroneId()
    if (target === undefined) return undefined
    return readDroneTelemetry(this.runtime.getAgentSnapshot(target))
  }

  /** 便捷入口:读车辆遥测(领域收窄在 vehicle-agent 里完成) */
  getVehicleTelemetry(id?: AgentId): VehicleSnapshot | undefined {
    const target = id ?? this.primaryAgentId('vehicle')
    if (target === undefined) return undefined
    return readVehicleTelemetry(this.runtime.getAgentSnapshot(target))
  }

  getAgentTrack(id: AgentId): AgentTrack | undefined {
    return this.recorder.getTrack(id)
  }

  /** 取会话里第一个指定类型的 Agent;不传类型则取第一个注册的 */
  primaryAgentId(type?: AgentType): AgentId | undefined {
    const list = this.agents.list()
    if (type === undefined) return list[0]?.id
    return list.find((agent) => agent.type === type)?.id
  }

  primaryDroneId(): AgentId | undefined {
    return this.primaryAgentId('drone')
  }

  primaryVehicleId(): AgentId | undefined {
    return this.primaryAgentId('vehicle')
  }

  // ————————————————————————————— Command —————————————————————————————

  /**
   * 提交一条指令。UI / Task / AI 全部走这里。
   * 被 Authority 拒绝时返回 null,并记一条 warn 事件(非法 Command → Reject)。
   */
  executeCommand(input: ExecuteCommandInput): Command | null {
    const actorId = input.actorId ?? 'user'
    const command = createCommand({
      type: input.type,
      sessionId: this.session.sessionId,
      actorId,
      simulationTime: this.runtime.clock.simulationTime,
      agentId: input.agentId,
      taskId: input.taskId,
      payload: input.payload,
    })

    const decision = this.authority({
      command,
      actorId,
      simulationTime: command.simulationTime,
      isRunning: this.isRunning,
      hasAgent: (id) => this.agents.has(id),
      hasTask: (id) => this.runtime.listTasks().some((task) => task.id === id),
    })

    if (!decision.allowed) {
      this.runtime.emit('warn', 'command.rejected', `指令被拒绝(${decision.reason})`, {
        agentId: command.agentId,
        actorId,
        payload: { commandType: command.type },
      })
      return null
    }

    this.runtime.submit(command)
    return command
  }

  /** 发布一条自定义事件(UI 侧的说明性日志等) */
  log(level: EventLevel, message: string, payload?: unknown): SimEvent {
    return this.runtime.emit(level, 'session.log', message, { payload })
  }

  // ————————————————————————————— Task API —————————————————————————————

  createWaypointTask(input: CreateWaypointTaskInput = {}): TaskId | null {
    const agentId = input.agentId ?? this.primaryDroneId()
    if (agentId === undefined) {
      this.runtime.emit('error', 'task.create.failed', '没有可用的 Agent,无法创建航点任务')
      return null
    }
    taskSeq += 1
    const id = input.id ?? `task-${String(taskSeq).padStart(2, '0')}`
    const task = new WaypointTask({
      id,
      label: input.label ?? `航点任务 ${taskSeq}`,
      agentId,
      waypoints: input.waypoints ?? defaultWaypoints(),
      takeoffAltitude: input.takeoffAltitude,
      holdSeconds: input.holdSeconds,
      landAtEnd: input.landAtEnd,
    })
    this.runtime.addTask(task)
    this.runtime.emit('info', 'task.created', `已创建任务:${task.label}`, { taskId: id, agentId })
    return id
  }

  /**
   * 创建电网巡检任务(README §10 的领域任务,与航点任务同一条 Task 契约)。
   *
   * 与 `createWaypointTask` 并列而不是合并:两者的差别不在参数多少,而在
   * 「作业内容」—— 航点任务只求到达,巡检任务要求到达 → 对准 → 采集 → 判定。
   * 合成一个「万能任务」就会让参数表变成一个开关堆。
   */
  createGridInspectionTask(input: CreateGridInspectionTaskInput): TaskId | null {
    const agentId = input.agentId ?? this.primaryDroneId()
    if (agentId === undefined) {
      this.runtime.emit('error', 'task.create.failed', '没有可用的无人机 Agent,无法创建巡检任务')
      return null
    }
    taskSeq += 1
    const id = input.id ?? `task-${String(taskSeq).padStart(2, '0')}`
    const task = new GridInspectionTask({
      id,
      label: input.label ?? `电网巡检 ${taskSeq}`,
      agentId,
      route: input.route,
      seed: input.seed ?? this.scenario.seed,
      transitTimeoutS: input.transitTimeoutS,
      alignTimeoutS: input.alignTimeoutS,
      maxConsecutiveSkips: input.maxConsecutiveSkips,
      landAtEnd: input.landAtEnd,
    })
    this.runtime.addTask(task)
    this.runtime.emit('info', 'task.created', `已创建巡检任务:${task.label}`, {
      taskId: id,
      agentId,
      payload: { shots: input.route.shots.length, parts: input.route.parts.length },
    })
    return id
  }

  /** 取巡检任务的采集记录(尚未完成的记录也在里面,`outcome` 会标成未采集) */
  getInspectionRecords(id: TaskId): ReadonlyArray<InspectionRecord> {
    return this.findInspectionTask(id)?.getRecords() ?? []
  }

  /**
   * 取巡检报告。`generatedAt` 必填:报告里要写生成时刻,但仿真包不取墙钟(§75)。
   * 巡检还在跑时取到的是当前进度的截面,状态标 `inProgress`,不打扮成已完成。
   */
  getInspectionReport(id: TaskId, generatedAt: string): InspectionReport | null {
    const task = this.findInspectionTask(id)
    if (!task) return null
    return task.report({
      generatedAt,
      sessionLabel: this.session.label,
      scenarioId: this.scenario.id,
    })
  }

  private findInspectionTask(id: TaskId): GridInspectionTask | null {
    const task = this.runtime.listTasks().find((item) => item.id === id)
    return task instanceof GridInspectionTask ? task : null
  }

  startTask(id: TaskId): Command | null {
    return this.executeCommand({ type: PLATFORM_COMMAND.startTask, taskId: id })
  }

  pauseTask(id: TaskId): Command | null {
    return this.executeCommand({ type: PLATFORM_COMMAND.pauseTask, taskId: id })
  }

  resumeTask(id: TaskId): Command | null {
    return this.executeCommand({ type: PLATFORM_COMMAND.resumeTask, taskId: id })
  }

  abortTask(id: TaskId, reason = '用户中止任务'): Command | null {
    return this.executeCommand({ type: PLATFORM_COMMAND.abortTask, taskId: id, payload: { reason } })
  }

  getTaskSnapshots(): ReadonlyArray<TaskSnapshot> {
    return this.runtime.listTasks().map((task) => task.getSnapshot())
  }

  getTaskResult(id: TaskId): TaskResult | null {
    return this.runtime.listTasks().find((task) => task.id === id)?.getResult() ?? null
  }

  // ————————————————————————————— Environment API —————————————————————————————

  setWind(speed: number, directionDeg: number): void {
    this.sandbox.setWind({ speed: Math.max(0, speed), directionDeg: ((directionDeg % 360) + 360) % 360 })
  }

  setWeather(weather: WeatherKind): void {
    this.sandbox.setWeather(weather)
  }

  // ————————————————————————————— Result API —————————————————————————————

  getEventLog(): ReadonlyArray<SimEvent> {
    return this.recorder.getEventLog()
  }

  getCommandLog(): ReadonlyArray<Command> {
    return this.recorder.getCommandLog()
  }

  dispose(): void {
    this.detachRecorder()
    this.runtime.dispose()
    this.agents.clear()
  }
}

/** 一步到位:用默认场景建一个无人机测试沙盒会话 */
export function createDroneSandboxSession(options: SimulationSessionOptions = {}): SimulationDomainAPI {
  return new SimulationDomainAPI(options)
}

/** 一步到位:建一个轮式载具沙盒会话 */
export function createVehicleSandboxSession(options: SimulationSessionOptions = {}): SimulationDomainAPI {
  return new SimulationDomainAPI({ ...options, domain: vehicleBinding })
}

export type { SessionId }
