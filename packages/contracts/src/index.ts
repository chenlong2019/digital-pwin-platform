/**
 * @simulation/contracts —— 平台稳定契约层
 *
 * 只定义「模块之间约定什么」,不定义「模块内部如何实现」。
 * 本包不依赖任何其他内部包,也不依赖 three / vue / 网络库 —— 这是整个平台
 * 依赖方向的最后一块基石(README §42)。
 */

// ————————————————————————————— 标识 —————————————————————————————

export type AgentId = string
export type TaskId = string
export type SessionId = string
export type CommandId = string
export type EventId = string

// ————————————————————————————— 几何 —————————————————————————————

/**
 * 世界系坐标(全平台唯一约定):
 *   +X 东、+Y 上、-Z 北(与 three.js 一致)
 * 航向角从正北顺时针,0° = 北,90° = 东。
 */
export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface PlanetPoint {
  x: number
  z: number
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z }
}

export function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

export function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** 罗盘方位角(0=北 90=东)对应的水平单位向量 */
export function headingToVector(headingDeg: number): PlanetPoint {
  const rad = (headingDeg * Math.PI) / 180
  return { x: Math.sin(rad), z: -Math.cos(rad) }
}

/** 从 (dx, dz) 求罗盘方位角,返回 0~360 */
export function vectorToHeading(dx: number, dz: number): number {
  return ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360
}

// ————————————————————————————— Agent —————————————————————————————

export type AgentType = 'drone' | 'vehicle' | 'boat' | 'robot' | 'npc'

export type AgentStatus = 'inactive' | 'active' | 'disabled'

export interface AgentSnapshotBase {
  readonly id: AgentId
  readonly type: AgentType
  readonly label: string
  readonly position: Vec3
  readonly headingDeg: number
  readonly status: AgentStatus
}

/**
 * Agent 对外发布的状态视图(不是内部 State 本身)。
 * 领域自定义数据放在 payload,由领域包提供类型安全的读取函数。
 */
export interface AgentSnapshot<TPayload = unknown> extends AgentSnapshotBase {
  readonly payload: TPayload
}

/** Agent 的执行上下文 —— Agent 不允许访问 Runtime 内部对象(README §47) */
export interface AgentUpdateContext {
  readonly tick: number
  readonly simulationTime: number
  readonly deltaTime: number
  /** 本 tick 内发给该 Agent 的指令 */
  readonly commands: ReadonlyArray<Command>
  /** Agent 读取环境的唯一入口,不直接访问 Sandbox 内部结构 */
  readonly sandbox: SandboxQuery
}

export interface Agent<TPayload = unknown> {
  readonly id: AgentId
  readonly type: AgentType
  readonly label: string
  /** 每个固定 tick 调用一次;只做「推进 + 读环境 + 消费指令」 */
  update(context: AgentUpdateContext): void
  /** 返回 true 表示本 Agent 已消费该指令 */
  handleCommand(command: Command): boolean
  getSnapshot(): AgentSnapshot<TPayload>
  dispose(): void
}

// ————————————————————————————— Sandbox —————————————————————————————

/** 轴对齐包围盒障碍物 —— 同一份数据同时供避障判定与可视化使用 */
export interface ObstacleBox {
  readonly name: string
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
  readonly minZ: number
  readonly maxZ: number
  /** 是否需要绕开(否则只是地面建筑,飞过去即可) */
  readonly solid: boolean
}

export interface RaycastHit {
  readonly distance: number
  readonly obstacle: string | null
  readonly point: Vec3
}

export interface WindState {
  /** 风速 m/s */
  readonly speed: number
  /** 风吹向的罗盘方位角(0=北,90=东) */
  readonly directionDeg: number
}

export type WeatherKind = 'clear' | 'cloudy' | 'overcast' | 'rain' | 'fog'

/** Agent 访问运行世界的唯一接口(README §50) */
export interface SandboxQuery {
  readonly id: string
  readonly obstacles: ReadonlyArray<ObstacleBox>
  getTerrainHeight(x: number, z: number): number
  queryObstacle(x: number, y: number, z: number): ObstacleBox | null
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): RaycastHit | null
  getWind(): WindState
  getWeather(): WeatherKind
  getWaterDepth(x: number, z: number): number
  isInsideGeofence(x: number, z: number): boolean
}

/** 环境对外发布的状态 */
export interface EnvironmentSnapshot {
  readonly wind: WindState
  readonly weather: WeatherKind
  /** 环境时间,0~24 小时 */
  readonly timeOfDay: number
  /** 沙盒标识 */
  readonly sandboxId: string
}

/** 运行世界(由 sandbox-core 实现) */
export interface Environment {
  update(context: { tick: number; simulationTime: number; deltaTime: number }): void
  getSnapshot(): EnvironmentSnapshot
  getQuery(): SandboxQuery
  dispose(): void
}

// ————————————————————————————— Command —————————————————————————————

/**
 * Command 表示「我要做什么」。
 * type 用字符串而非枚举,使领域包可以自由扩展指令而不改动契约层。
 */
export interface Command<TPayload = unknown> {
  readonly commandId: CommandId
  readonly type: string
  /** 下发时刻的仿真时间(不是墙上时钟) */
  readonly simulationTime: number
  readonly sessionId: SessionId
  /** 发起者:用户 id / 'ai' / 'system' */
  readonly actorId: string
  readonly agentId?: AgentId
  readonly taskId?: TaskId
  readonly payload: TPayload
}

/** 指令被 Authority 拒绝的结果 */
export interface CommandRejection {
  readonly command: Command
  readonly reason: string
}

/**
 * 平台级通用指令(README §51 列举的 Takeoff / Move / Land / StartTask 等)。
 *
 * 这些是「任何可动机器人都会有的动作」,所以属于平台契约;无人机专属的
 * 指令(切挡位、折叠机臂、云台…)由领域包自定义 type,不污染这一层。
 * 好处:task-core 发指令时不需要知道 DroneAgent 的私有指令名。
 */
export const PLATFORM_COMMAND = {
  powerOn: 'agent.powerOn',
  powerOff: 'agent.powerOff',
  takeOff: 'agent.takeOff',
  land: 'agent.land',
  move: 'agent.move',
  hover: 'agent.hover',
  stop: 'agent.stop',
  returnToHome: 'agent.returnToHome',
  cancelReturnToHome: 'agent.cancelReturnToHome',
  reset: 'agent.reset',
  startTask: 'task.start',
  pauseTask: 'task.pause',
  resumeTask: 'task.resume',
  abortTask: 'task.abort',
} as const

export type PlatformCommandType = (typeof PLATFORM_COMMAND)[keyof typeof PLATFORM_COMMAND]

/** agent.move 的载荷:机体坐标系下的归一化控制量 */
export interface MoveCommandPayload {
  /** 前进/后退 -1~1,正 = 向机头方向 */
  readonly forward: number
  /** 右移/左移 -1~1,正 = 向右 */
  readonly right: number
  /** 上升/下降 -1~1,正 = 上升 */
  readonly up: number
  /** 偏航 -1~1,正 = 右转 */
  readonly yawRate: number
}

export function neutralizeMove(): MoveCommandPayload {
  return { forward: 0, right: 0, up: 0, yawRate: 0 }
}

export interface ReturnToHomePayload {
  readonly reason?: string
}

let commandSeq = 0

export interface CreateCommandOptions<TPayload = unknown> {
  readonly type: string
  readonly sessionId: SessionId
  readonly actorId: string
  readonly simulationTime: number
  readonly payload?: TPayload
  readonly agentId?: AgentId
  readonly taskId?: TaskId
}

export function createCommand<TPayload = unknown>(options: CreateCommandOptions<TPayload>): Command<TPayload> {
  commandSeq += 1
  return {
    commandId: `cmd-${commandSeq}`,
    type: options.type,
    simulationTime: options.simulationTime,
    sessionId: options.sessionId,
    actorId: options.actorId,
    agentId: options.agentId,
    taskId: options.taskId,
    payload: (options.payload ?? (undefined as TPayload)),
  }
}

// ————————————————————————————— Event —————————————————————————————

export type EventLevel = 'info' | 'warn' | 'error' | 'success'

/** Event 表示「刚才发生了什么」—— 已经发生的事实 */
export interface SimEvent<TPayload = unknown> {
  readonly eventId: EventId
  readonly type: string
  readonly level: EventLevel
  readonly simulationTime: number
  readonly tick: number
  readonly sessionId: SessionId
  readonly agentId?: AgentId
  readonly taskId?: TaskId
  readonly actorId?: string
  readonly message?: string
  readonly payload?: TPayload
}

// ————————————————————————————— Task —————————————————————————————

export type TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted'

export interface TaskProgress {
  /** 已完成的关键节点数 */
  readonly completed: number
  /** 关键节点总数 */
  readonly total: number
  /** 当前节点的人类可读描述 */
  readonly stage: string
}

export interface TaskSnapshot {
  readonly id: TaskId
  readonly type: string
  readonly label: string
  readonly status: TaskStatus
  readonly agentId: AgentId | null
  readonly progress: TaskProgress
  readonly result: TaskResult | null
}

export interface TaskResult {
  readonly taskId: TaskId
  readonly status: TaskStatus
  readonly duration: number
  readonly metrics: Readonly<Record<string, number>>
  readonly message: string
}

/** Task 的执行上下文:Task 只能通过它读状态、下发指令、写事件 */
export interface TaskUpdateContext {
  readonly tick: number
  readonly simulationTime: number
  readonly deltaTime: number
  readonly sessionId: SessionId
  /** 读取 Agent 的对外快照 */
  readonly getAgentSnapshot: (id: AgentId) => AgentSnapshot | undefined
  readonly sandbox: SandboxQuery
  /** Task 不直接改 Agent State,只发指令(README §49) */
  readonly emitCommand: (command: Command) => void
  readonly log: (level: EventLevel, message: string, payload?: unknown) => void
}

export interface Task {
  readonly id: TaskId
  readonly type: string
  readonly label: string
  readonly status: TaskStatus
  readonly agentId: AgentId | null
  start(): void
  pause(): void
  resume(): void
  abort(reason?: string): void
  update(context: TaskUpdateContext): void
  getResult(): TaskResult | null
  getSnapshot(): TaskSnapshot
}

// ————————————————————————————— Snapshot —————————————————————————————

/** 某个 Simulation Tick 对外发布的状态快照 */
export interface SimulationSnapshot {
  readonly sessionId: SessionId
  readonly tick: number
  readonly simulationTime: number
  readonly agents: ReadonlyArray<AgentSnapshot>
  readonly tasks: ReadonlyArray<TaskSnapshot>
  readonly environment: EnvironmentSnapshot
  /** 本 tick 新产生的事件(不是全部历史) */
  readonly events: ReadonlyArray<SimEvent>
}

export type SnapshotListener = (snapshot: SimulationSnapshot) => void

export type RuntimeStatus = 'idle' | 'running' | 'paused'

// ————————————————————————————— Render Adapter —————————————————————————————

/**
 * 渲染适配器消费的「中性位姿」—— 平台级概念,不含任何 three / Cesium 术语。
 *
 * 这样适配器就不需要认识无人机遥测:领域包(或应用层)负责把 AgentSnapshot
 * 投影成 AgentRenderView,渲染层只认这个结构。换渲染器不用改仿真,
 * 换领域也不用改渲染。
 */
export interface AgentBodyPose {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly headingDeg: number
  /** 正 = 抬头 */
  readonly pitchDeg: number
  /** 正 = 右压坡 */
  readonly rollDeg: number
}

/** 机械/外观状态,可选;不适用的 Agent 传 null */
export interface AgentRigState {
  /** 动力负荷 0~1 */
  readonly motorLoad: number
  /** 机臂折叠度 0 = 展开,1 = 收纳 */
  readonly armFold: number
  readonly gimbalPitchDeg: number
  readonly gimbalRollDeg: number
  readonly gimbalYawDeg: number
  /**
   * 相机变焦倍数(1 = 广角)。
   *
   * 只有「机载取景」用它 —— 观察者 / 跟随视角的缩放是用户的滚轮状态,
   * 不该被设备变焦顶掉,两者的保存与归还在渲染适配器内部处理。
   */
  readonly cameraZoom: number
}

/**
 * 状态灯语 —— 只描述「该亮什么」,不描述「怎么亮」。
 *
 * pattern 的取值由领域包定义(无人机是十几种灯语),渲染层只做查表与插值:
 * 灯语与飞行状态的对应关系属于**产品行为**,不是渲染细节,所以判定留在领域层。
 */
export interface AgentLightState {
  /** 灯语键,取值域由领域包声明;渲染层不认识时按「熄灭」处理 */
  readonly pattern: string
  /** 电量百分数 0~100,电池灯珠用 */
  readonly batteryLevel: number
  readonly flying: boolean
}

export interface AgentRenderView {
  readonly agentId: AgentId
  readonly type: AgentType
  readonly label: string
  readonly pose: AgentBodyPose
  readonly rig: AgentRigState | null
  readonly lights: AgentLightState | null
  /** 设备是否通电 —— 灯光、测距传感器等「上电才工作」的部件看它 */
  readonly powered: boolean
  readonly visible: boolean
}

/** 由应用层注入:把通用 AgentSnapshot 投影成渲染视图 */
export type AgentViewProjector = (agent: AgentSnapshot) => AgentRenderView | null

export interface RenderSelection {
  readonly agentIds: ReadonlyArray<AgentId>
}

/** 统一渲染适配器契约(README §64)。Renderer 只消费 Snapshot。 */
export interface RenderAdapter {
  initialize(): Promise<void>
  updateSnapshot(snapshot: SimulationSnapshot): void
  updateSelection(selection: RenderSelection): void
  /** 帧驱动入口:由应用层渲染循环调用(README §64 未列举,但渲染必须有帧入口) */
  render(deltaSeconds: number): void
  dispose(): void
}

// ————————————————————————————— Session —————————————————————————————

export interface SessionDescriptor {
  readonly sessionId: SessionId
  /** Scenario 标识:同一 Scenario + 同一 Seed + 同一 Command 序列应得到等价结果 */
  readonly scenarioId: string
  readonly seed: number
  readonly label: string
}
