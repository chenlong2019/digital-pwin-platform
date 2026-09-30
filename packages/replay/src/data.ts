/**
 * 回放数据(README §22 · §58)。
 *
 *   Recorder Data → ReplaySession → ReplayController → ReplaySnapshot → Renderer
 *
 * Replay **不等于** Recorder:记录器把过程沉淀下来(§20),回放只消费那份沉淀。
 * 所以这里的第一件事就是把记录器里的东西抓成一份**自洽的快照** ——
 * 之后回放就不再需要 Runtime、不需要 Agent、不需要沙盒:
 * 哪怕原始会话已经 dispose,这份数据照样能放(这也是 §22「第一阶段:历史数据驱动回放」)。
 */
import type { Command, SessionDescriptor, SessionId, SimEvent } from '@simulation/contracts'
import type { AgentTrack, RecorderStats } from '@simulation/recorder'

/** §77 建议的 AgentTrack 采样率 */
export const DEFAULT_REPLAY_SAMPLE_HZ = 20

export interface ReplayData {
  readonly sessionId: SessionId
  readonly scenarioId: string
  readonly seed: number
  readonly label: string
  readonly sampleHz: number
  /** 数据覆盖的时间长度(秒) */
  readonly duration: number
  readonly tracks: ReadonlyArray<AgentTrack>
  readonly events: ReadonlyArray<SimEvent>
  readonly commands: ReadonlyArray<Command>
}

/**
 * 抓取源。Domain API 天然满足这个结构(它同时持有 session 与 recorder),
 * 但这里**不 import domain-api** —— 回放只依赖契约与记录器,
 * 于是它也能喂给服务端(§59)或另一个客户端(§60)使用。
 */
export interface ReplayCaptureSource {
  readonly session: SessionDescriptor
  readonly recorder: {
    getTracks(): ReadonlyArray<AgentTrack>
    getEventLog(): ReadonlyArray<SimEvent>
    getCommandLog(): ReadonlyArray<Command>
    getStats(): RecorderStats
  }
}

export interface CaptureReplayOptions {
  /** 覆盖采样率;不传就从轨迹点间隔反推 */
  readonly sampleHz?: number
}

/** 从轨迹点间隔反推真实采样率 —— 比记一个常量更可信 */
function inferSampleHz(tracks: ReadonlyArray<AgentTrack>): number {
  const points = tracks[0]?.points ?? []
  if (points.length < 2) return DEFAULT_REPLAY_SAMPLE_HZ
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return DEFAULT_REPLAY_SAMPLE_HZ
  const span = last.simulationTime - first.simulationTime
  if (span <= 1e-6) return DEFAULT_REPLAY_SAMPLE_HZ
  return Number(((points.length - 1) / span).toFixed(3))
}

/** 数据覆盖的时间长度 = 轨迹末点 / 事件 / 指令里最晚的那个时刻 */
function measureDuration(
  tracks: ReadonlyArray<AgentTrack>,
  events: ReadonlyArray<SimEvent>,
  commands: ReadonlyArray<Command>,
): number {
  let duration = 0
  for (const track of tracks) {
    const last = track.points[track.points.length - 1]
    if (last) duration = Math.max(duration, last.simulationTime)
  }
  for (const event of events) duration = Math.max(duration, event.simulationTime)
  for (const command of commands) duration = Math.max(duration, command.simulationTime)
  return duration
}

/**
 * 抓一份可回放的数据。
 *
 * 注意是**深拷贝一份点列**,不是引用记录器内部数组 —— 记录器是环形缓冲,
 * 新数据进来会把老点挤掉,引用它会导致回放中段突然丢帧。
 */
export function captureReplayData(
  source: ReplayCaptureSource,
  options: CaptureReplayOptions = {},
): ReplayData {
  const tracks = source.recorder.getTracks().map((track) => ({
    agentId: track.agentId,
    type: track.type,
    label: track.label,
    points: [...track.points],
  }))
  const events = [...source.recorder.getEventLog()]
  const commands = [...source.recorder.getCommandLog()]

  return {
    sessionId: source.session.sessionId,
    scenarioId: source.session.scenarioId,
    seed: source.session.seed,
    label: source.session.label,
    sampleHz: options.sampleHz ?? inferSampleHz(tracks),
    duration: measureDuration(tracks, events, commands),
    tracks,
    events,
    commands,
  }
}

/** 手搓一份回放数据(测试 / 导入外部录像用) */
export function createReplayData(input: Partial<ReplayData> & { sessionId: SessionId }): ReplayData {
  const tracks = input.tracks ?? []
  const events = input.events ?? []
  const commands = input.commands ?? []
  return {
    sessionId: input.sessionId,
    scenarioId: input.scenarioId ?? 'unknown',
    seed: input.seed ?? 0,
    label: input.label ?? '回放',
    sampleHz: input.sampleHz ?? inferSampleHz(tracks),
    duration: input.duration ?? measureDuration(tracks, events, commands),
    tracks,
    events,
    commands,
  }
}
