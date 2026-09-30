/**
 * Simulation Runtime —— 平台仿真执行核心(README §12 / §14)。
 *
 * 每个 tick 严格按固定顺序执行,顺序本身就是确定性的一部分:
 *
 *   Tick
 *    ↓ ① Environment Update
 *    ↓ ② Task Update
 *    ↓ ③ Agent Update(先消费指令,再推进)
 *    ↓ ④ Collision / Safety
 *    ↓ ⑤ State Commit
 *    ↓ ⑥ Snapshot
 *    ↓ ⑦ Event
 *
 * Runtime 不负责:UI、Renderer、用户权限、MCP 工具定义、WebSocket 逻辑。
 * 它只依赖 contracts —— 因此可以原样跑在浏览器里,也可以原样跑在 Node 服务端。
 */
import type {
  Agent,
  AgentId,
  AgentSnapshot,
  Command,
  Environment,
  EventLevel,
  RuntimeStatus,
  SandboxQuery,
  SessionDescriptor,
  SimEvent,
  SimulationSnapshot,
  Task,
  TaskId,
  TaskUpdateContext,
} from '@simulation/contracts'
import { PLATFORM_COMMAND } from '@simulation/contracts'
import { SimulationClock } from './clock'
import type { SimulationClockOptions } from './clock'
import type { RandomSource } from './random'
import { createSeededRandom } from './random'
import { Stream } from './streams'

export interface SafetyContext {
  readonly tick: number
  readonly simulationTime: number
  readonly deltaTime: number
  readonly agents: ReadonlyArray<Agent>
  readonly sandbox: SandboxQuery
}

/** 碰撞 / 失效保护的统一钩子。领域逻辑仍归 Agent,这里只做跨 Agent 的仲裁。 */
export interface SafetyResolver {
  resolve(context: SafetyContext): void
}

export interface SimulationRuntimeOptions extends SimulationClockOptions {
  session: SessionDescriptor
  environment: Environment
  agents?: ReadonlyArray<Agent>
  tasks?: ReadonlyArray<Task>
  safety?: SafetyResolver
}

export interface RuntimeStats {
  readonly status: RuntimeStatus
  readonly ticks: number
  readonly simulationTime: number
  readonly realTime: number
  readonly droppedSteps: number
  readonly lastSteps: number
  readonly timeScale: number
  readonly agents: number
  readonly tasks: number
  readonly eventsEmitted: number
}

/** 从指令载荷里读中止原因(防御式,载荷是 unknown) */
function readReason(payload: unknown): string {
  if (payload !== null && typeof payload === 'object') {
    const reason = (payload as Record<string, unknown>)['reason']
    if (typeof reason === 'string' && reason.length > 0) return reason
  }
  return '任务已中止'
}

export class SimulationRuntime {
  readonly session: SessionDescriptor
  readonly clock: SimulationClock
  readonly random: RandomSource

  /** 每个 tick 发布一次对外状态视图 */
  readonly snapshots = new Stream<SimulationSnapshot>()
  /** 每个 tick 发布本 tick 新产生的事件 */
  readonly tickEvents = new Stream<ReadonlyArray<SimEvent>>()
  /** 指令进入运行时的瞬间发布(供 CommandLog 记录) */
  readonly commands = new Stream<Command>()

  private readonly environment: Environment
  private readonly agentList: Agent[] = []
  private readonly taskList: Task[] = []
  private readonly safety: SafetyResolver | undefined
  private readonly externalCommands: Command[] = []
  private readonly taskCommands: Command[] = []
  private readonly pendingEvents: SimEvent[] = []
  private readonly knownAgentIds = new Set<AgentId>()
  private eventCounter = 0
  private eventsEmitted = 0
  private status: RuntimeStatus = 'idle'
  private lastSnapshot: SimulationSnapshot | null = null

  constructor(options: SimulationRuntimeOptions) {
    this.session = options.session
    this.environment = options.environment
    this.safety = options.safety
    this.clock = new SimulationClock(options)
    this.random = createSeededRandom(options.session.seed)
    for (const agent of options.agents ?? []) this.addAgent(agent)
    for (const task of options.tasks ?? []) this.addTask(task)
  }

  // ————————————————————————————— 生命周期 —————————————————————————————

  get currentStatus(): RuntimeStatus {
    return this.status
  }

  get stats(): RuntimeStats {
    return {
      status: this.status,
      ticks: this.clock.tick,
      simulationTime: this.clock.simulationTime,
      realTime: this.clock.stats.realTime,
      droppedSteps: this.clock.stats.droppedSteps,
      lastSteps: this.clock.stats.lastSteps,
      timeScale: this.clock.scale,
      agents: this.agentList.length,
      tasks: this.taskList.length,
      eventsEmitted: this.eventsEmitted,
    }
  }

  start(): void {
    if (this.status === 'running') return
    this.status = 'running'
    this.emit('info', 'runtime.started', `仿真已启动 · 固定步长 ${(this.clock.fixedDeltaTime * 1000).toFixed(2)} ms`)
  }

  pause(): void {
    if (this.status !== 'running') return
    this.status = 'paused'
    this.emit('info', 'runtime.paused', '仿真已暂停')
  }

  resume(): void {
    if (this.status !== 'paused') return
    this.status = 'running'
    this.emit('info', 'runtime.resumed', '仿真已恢复')
  }

  stop(): void {
    this.status = 'idle'
  }

  setTimeScale(scale: number): void {
    this.clock.setTimeScale(scale)
  }

  /**
   * 由渲染循环调用:投入真实经过时间,时钟换算成固定步数后逐个推进。
   * 这是「真实时间」唯一被允许进入仿真的地方。
   */
  advance(realDeltaSeconds: number): number {
    if (this.status !== 'running') return 0
    const steps = this.clock.advance(realDeltaSeconds)
    for (let i = 0; i < steps; i += 1) this.runTick()
    return steps
  }

  /** 手动推进固定步数(测试 / 无头回放用),不受 status 限制 */
  step(steps = 1): void {
    const count = Math.max(1, Math.floor(steps))
    for (let i = 0; i < count; i += 1) this.runTick()
  }

  // ————————————————————————————— 注册表 —————————————————————————————

  addAgent(agent: Agent): boolean {
    if (this.knownAgentIds.has(agent.id)) return false
    this.knownAgentIds.add(agent.id)
    this.agentList.push(agent)
    return true
  }

  removeAgent(id: AgentId): boolean {
    const index = this.agentList.findIndex((agent) => agent.id === id)
    if (index < 0) return false
    const [removed] = this.agentList.splice(index, 1)
    this.knownAgentIds.delete(id)
    removed?.dispose()
    return true
  }

  getAgent<TPayload>(id: AgentId): Agent<TPayload> | undefined {
    return this.agentList.find((agent) => agent.id === id) as Agent<TPayload> | undefined
  }

  listAgents(): ReadonlyArray<Agent> {
    return this.agentList
  }

  getAgentSnapshot(id: AgentId): AgentSnapshot | undefined {
    return this.agentList.find((agent) => agent.id === id)?.getSnapshot()
  }

  addTask(task: Task): boolean {
    if (this.taskList.some((existing) => existing.id === task.id)) return false
    this.taskList.push(task)
    return true
  }

  removeTask(id: TaskId): boolean {
    const index = this.taskList.findIndex((task) => task.id === id)
    if (index < 0) return false
    this.taskList.splice(index, 1)
    return true
  }

  listTasks(): ReadonlyArray<Task> {
    return this.taskList
  }

  // ————————————————————————————— 指令 —————————————————————————————

  /**
   * 提交一条已通过 Authority 校验的指令。
   * 指令不立即生效,而是在下一个 tick 的 Agent 阶段被消费 —— 保证顺序确定性。
   */
  submit(command: Command): void {
    this.externalCommands.push(command)
    this.commands.publish(command)
  }

  // ————————————————————————————— 事件 —————————————————————————————

  /** 记录一个事件。tick 之间调用也可,会随下一个 Snapshot 一起发布。 */
  emit(
    level: EventLevel,
    type: string,
    message: string,
    extra: { agentId?: AgentId; taskId?: TaskId; actorId?: string; payload?: unknown } = {},
  ): SimEvent {
    const event: SimEvent = {
      eventId: `evt-${(this.eventCounter += 1)}`,
      type,
      level,
      simulationTime: this.clock.simulationTime,
      tick: this.clock.tick,
      sessionId: this.session.sessionId,
      agentId: extra.agentId,
      taskId: extra.taskId,
      actorId: extra.actorId,
      message,
      payload: extra.payload,
    }
    this.pendingEvents.push(event)
    return event
  }

  // ————————————————————————————— 快照 —————————————————————————————

  getSnapshot(): SimulationSnapshot {
    return this.lastSnapshot ?? this.buildSnapshot([])
  }

  private buildSnapshot(events: ReadonlyArray<SimEvent>): SimulationSnapshot {
    return {
      sessionId: this.session.sessionId,
      tick: this.clock.tick,
      simulationTime: this.clock.simulationTime,
      agents: this.agentList.map((agent) => agent.getSnapshot()),
      tasks: this.taskList.map((task) => task.getSnapshot()),
      environment: this.environment.getSnapshot(),
      events,
    }
  }

  // ————————————————————————————— 单 tick —————————————————————————————

  private runTick(): void {
    this.clock.commitTick()
    const tick = this.clock.tick
    const simulationTime = this.clock.simulationTime
    const deltaTime = this.clock.fixedDeltaTime
    const sandbox = this.environment.getQuery()

    // ① Environment
    this.environment.update({ tick, simulationTime, deltaTime })

    // ② 指令入队:上一 tick 没消费完的外部指令 + 本 tick 新提交的
    const queue = this.externalCommands.splice(0, this.externalCommands.length)
    this.taskCommands.length = 0

    // ②a 平台级任务指令先派发给 Task 生命周期 ——
    //     任务控制同样必须经过 Authority + Command(README §82),不允许外部直接调 task.start()
    for (const command of queue) {
      if (!command.type.startsWith('task.')) continue
      const task = command.taskId === undefined ? undefined : this.taskList.find((item) => item.id === command.taskId)
      if (!task) continue
      switch (command.type) {
        case PLATFORM_COMMAND.startTask:
          task.start()
          break
        case PLATFORM_COMMAND.pauseTask:
          task.pause()
          break
        case PLATFORM_COMMAND.resumeTask:
          task.resume()
          break
        case PLATFORM_COMMAND.abortTask:
          task.abort(readReason(command.payload))
          break
        default:
          break
      }
    }

    // ②b Task 更新 —— Task 只能通过 emitCommand 下发指令,不能直接改 Agent State
    for (const task of this.taskList) {
      if (task.status !== 'running') continue
      const context: TaskUpdateContext = {
        tick,
        simulationTime,
        deltaTime,
        sessionId: this.session.sessionId,
        getAgentSnapshot: (id) => this.getAgentSnapshot(id),
        sandbox,
        emitCommand: (command) => {
          this.taskCommands.push(command)
        },
        log: (level, message, payload) => {
          this.emit(level, 'task.log', message, { taskId: task.id, payload })
        },
      }
      task.update(context)
    }

    // ③ Agent —— 先消费指令,再推进。Task 本 tick 发出的指令同 tick 生效,保证响应及时
    const agentQueue = queue.concat(this.taskCommands)
    this.taskCommands.length = 0
    const unmatched = new Set<AgentId>()
    for (const agent of this.agentList) {
      const mine: Command[] = []
      for (const command of agentQueue) {
        if (command.taskId !== undefined && command.type.startsWith('task.')) continue
        if (command.agentId === undefined || command.agentId === agent.id) {
          mine.push(command)
        } else if (!this.knownAgentIds.has(command.agentId)) {
          unmatched.add(command.agentId)
        }
      }
      for (const command of mine) {
        if (!agent.handleCommand(command)) {
          this.emit('warn', 'command.ignored', `${agent.label} 拒绝了指令 ${command.type}`, {
            agentId: agent.id,
            actorId: command.actorId,
          })
        }
      }
      agent.update({ tick, simulationTime, deltaTime, commands: mine, sandbox })
    }
    for (const id of unmatched) {
      this.emit('warn', 'command.unrouted', `指令目标 Agent 不存在:${id}`)
    }

    // ④ Collision / Safety
    this.safety?.resolve({ tick, simulationTime, deltaTime, agents: this.agentList, sandbox })

    // ⑤ State Commit —— Agent 自身状态即权威状态,此处提交 tick 边界
    // ⑥ Snapshot + ⑦ Event
    const events = this.pendingEvents.splice(0, this.pendingEvents.length)
    this.eventsEmitted += events.length
    const snapshot = this.buildSnapshot(events)
    this.lastSnapshot = snapshot
    if (events.length > 0) this.tickEvents.publish(events)
    this.snapshots.publish(snapshot)
  }

  dispose(): void {
    this.status = 'idle'
    for (const agent of this.agentList) agent.dispose()
    this.agentList.length = 0
    this.taskList.length = 0
    this.knownAgentIds.clear()
    this.externalCommands.length = 0
    this.taskCommands.length = 0
    this.pendingEvents.length = 0
    this.snapshots.clear()
    this.tickEvents.clear()
    this.commands.clear()
    this.environment.dispose()
    this.lastSnapshot = null
  }
}
