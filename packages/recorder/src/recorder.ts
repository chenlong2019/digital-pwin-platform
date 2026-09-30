/**
 * SimulationRecorder —— 过程记录系统(README §20)。
 *
 * 记录:AgentTrack / TelemetryLog(采样)/ EventLog / CommandLog
 * 不做:TaskResult、Replay UI、Agent Dynamics、State Mutation
 *
 * 为什么它只依赖 contracts:这里用结构化接口描述「可订阅的数据源」,
 * Runtime 的 Stream 天然满足,不需要 import simulation-core。
 * Core 因此永远不必知道 Recorder 的存在(README §71)。
 */
import type { AgentId, AgentSnapshot, Command, SimEvent, SimulationSnapshot } from '@simulation/contracts'

/** 任何具备订阅能力的数据源(与 simulation-core 的 Stream 结构兼容) */
export interface StreamLike<T> {
  subscribe(listener: (value: T) => void): () => void
}

export interface RecorderSource {
  readonly snapshots: StreamLike<SimulationSnapshot>
  readonly commands: StreamLike<Command>
}

export interface RecorderOptions {
  /** AgentTrack 采样率(Hz),README §77 建议 20 */
  readonly sampleHz?: number
  readonly maxTrackPoints?: number
  readonly maxEvents?: number
  readonly maxCommands?: number
  /**
   * 领域事件收割器。
   * 平台事件流只带 Runtime / Task 产生的事件;领域 Agent 的事件在遥测载荷里,
   * 由领域包提供收割函数(见 drone-agent 的 harvestDroneEvents)。
   * 同一 eventId 会被重复收割,本记录器按 eventId 去重。
   */
  readonly harvestEvents?: (snapshot: SimulationSnapshot) => ReadonlyArray<SimEvent>
}

export interface TrackPoint {
  readonly tick: number
  readonly simulationTime: number
  readonly x: number
  readonly y: number
  readonly z: number
  readonly headingDeg: number
}

export interface AgentTrack {
  readonly agentId: AgentId
  readonly type: string
  readonly label: string
  readonly points: ReadonlyArray<TrackPoint>
}

export interface RecorderStats {
  readonly tracks: number
  readonly samples: number
  readonly events: number
  readonly commands: number
}

interface MutableTrack {
  agentId: AgentId
  type: string
  label: string
  points: TrackPoint[]
}

export class SimulationRecorder {
  private readonly sampleHz: number
  private readonly maxTrackPoints: number
  private readonly maxEvents: number
  private readonly maxCommands: number
  private readonly harvestEvents: ((snapshot: SimulationSnapshot) => ReadonlyArray<SimEvent>) | undefined
  private readonly trackMap = new Map<AgentId, MutableTrack>()
  private readonly events: SimEvent[] = []
  private readonly eventIds = new Set<string>()
  private readonly commandList: Command[] = []
  private lastSampleTime = Number.NEGATIVE_INFINITY
  private sampleCount = 0
  private unsubscribe: (() => void) | null = null

  constructor(options: RecorderOptions = {}) {
    this.sampleHz = Math.max(1, options.sampleHz ?? 20)
    this.maxTrackPoints = options.maxTrackPoints ?? 20000
    this.maxEvents = options.maxEvents ?? 4000
    this.maxCommands = options.maxCommands ?? 2000
    this.harvestEvents = options.harvestEvents
  }

  /** 挂到一个数据源上;返回解绑函数 */
  attach(source: RecorderSource): () => void {
    this.detach()
    const offSnapshot = source.snapshots.subscribe((snapshot) => this.onSnapshot(snapshot))
    const offCommand = source.commands.subscribe((command) => this.onCommand(command))
    this.unsubscribe = () => {
      offSnapshot()
      offCommand()
    }
    return this.unsubscribe
  }

  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  getTracks(): ReadonlyArray<AgentTrack> {
    return [...this.trackMap.values()].map((track) => ({
      agentId: track.agentId,
      type: track.type,
      label: track.label,
      points: track.points,
    }))
  }

  getTrack(agentId: AgentId): AgentTrack | undefined {
    return this.getTracks().find((track) => track.agentId === agentId)
  }

  /** 按时间顺序返回事件日志(Runtime / Task / 领域事件合流) */
  getEventLog(): ReadonlyArray<SimEvent> {
    return this.events
  }

  getCommandLog(): ReadonlyArray<Command> {
    return this.commandList
  }

  getStats(): RecorderStats {
    return {
      tracks: this.trackMap.size,
      samples: this.sampleCount,
      events: this.events.length,
      commands: this.commandList.length,
    }
  }

  reset(): void {
    this.trackMap.clear()
    this.events.length = 0
    this.eventIds.clear()
    this.commandList.length = 0
    this.lastSampleTime = Number.NEGATIVE_INFINITY
    this.sampleCount = 0
  }

  // ————————————————————————————— 内部 —————————————————————————————

  private onSnapshot(snapshot: SimulationSnapshot): void {
    const interval = 1 / this.sampleHz
    if (snapshot.simulationTime - this.lastSampleTime >= interval - 1e-9) {
      this.lastSampleTime = snapshot.simulationTime
      for (const agent of snapshot.agents) this.sample(agent, snapshot)
      this.sampleCount += 1
    }
    for (const event of snapshot.events) this.pushEvent(event)
    if (this.harvestEvents) {
      for (const event of this.harvestEvents(snapshot)) this.pushEvent(event)
    }
  }

  private onCommand(command: Command): void {
    this.commandList.push(command)
    if (this.commandList.length > this.maxCommands * 1.25) {
      this.commandList.splice(0, this.commandList.length - this.maxCommands)
    }
  }

  private sample(agent: AgentSnapshot, snapshot: SimulationSnapshot): void {
    let track = this.trackMap.get(agent.id)
    if (!track) {
      track = { agentId: agent.id, type: agent.type, label: agent.label, points: [] }
      this.trackMap.set(agent.id, track)
    }
    track.points.push({
      tick: snapshot.tick,
      simulationTime: snapshot.simulationTime,
      x: agent.position.x,
      y: agent.position.y,
      z: agent.position.z,
      headingDeg: agent.headingDeg,
    })
    if (track.points.length > this.maxTrackPoints * 1.25) {
      track.points.splice(0, track.points.length - this.maxTrackPoints)
    }
  }

  private pushEvent(event: SimEvent): void {
    if (this.eventIds.has(event.eventId)) return
    this.eventIds.add(event.eventId)
    this.events.push(event)
    if (this.events.length > this.maxEvents * 1.25) {
      const removed = this.events.splice(0, this.events.length - this.maxEvents)
      for (const item of removed) this.eventIds.delete(item.eventId)
    }
  }
}
