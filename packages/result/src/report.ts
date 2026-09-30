/**
 * TaskResult 聚合(README §21 · §57)。
 *
 *   Task → Completed → Result Builder → TaskResult
 *
 * Task 自己给出的 TaskResult 只有 status / duration / metrics(§21)—— 那是「任务视角
 * 的结论」。Result 这一层负责把它和**过程数据**拼起来:轨迹、事件、指令、媒体,
 * 于是同一份结果既能给人看报告,也能给复盘用(§22 Replay 读的是同一批记录)。
 *
 * 边界:本包只**读**记录,不负责记录(那是 recorder 的事),也不做 IO ——
 * 导出成字符串即可,落盘是调用方的事。
 */
import type {
  AgentId,
  Command,
  EventLevel,
  MediaAsset,
  SimEvent,
  TaskId,
  TaskResult,
  TaskSnapshot,
  TaskStatus,
} from '@simulation/contracts'
import type { AgentTrack } from '@simulation/recorder'

/** 轨迹引用 —— 只给「去哪取 + 有多少」,不把上万个点内联进结果(§21 trackReference) */
export interface TrackReference {
  readonly agentId: AgentId
  readonly type: string
  readonly label: string
  readonly points: number
  readonly sampleHz: number
  readonly startTime: number
  readonly endTime: number
  readonly distanceFlown: number
  readonly maxAltitude: number
  readonly maxSpeed: number
}

/** 事件引用(§21 eventReference) */
export interface EventReference {
  readonly total: number
  readonly byLevel: Readonly<Record<EventLevel, number>>
  readonly firstTime: number
  readonly lastTime: number
  /**
   * 时间戳是否单调不减。
   * §77 的「时间戳连续」在这里被固化成可断言的字段 —— 记录器一旦乱序,结果里就能看见。
   */
  readonly monotonic: boolean
}

/** 结果统计(§32 Statistics) */
export interface ResultStatistics {
  readonly trackPoints: number
  readonly events: number
  readonly commands: number
  readonly warnings: number
  readonly errors: number
  readonly sampleHz: number
}

/** 任务结果的完整聚合 */
export interface TaskResultReport {
  readonly taskId: TaskId
  readonly type: string
  readonly label: string
  readonly agentId: AgentId | null
  readonly status: TaskStatus
  /** 任务自身时长(秒,取自 Task) */
  readonly duration: number
  readonly message: string
  /** 任务自带指标(航点数、距离、最高高度…) */
  readonly metrics: Readonly<Record<string, number>>
  readonly statistics: ResultStatistics
  readonly trackReference: TrackReference | null
  readonly eventReference: EventReference
  /** 本次任务产出的照片 / 视频(§23 MediaAsset) */
  readonly mediaReference: ReadonlyArray<MediaAsset>
  /** 生成这份结果时的仿真时刻 */
  readonly generatedAt: number
}

export interface BuildTaskResultInput {
  /** Task 的对外快照 */
  readonly task: TaskSnapshot
  /** Task 自己给出的结论(§21) */
  readonly outcome: TaskResult
  readonly tracks: ReadonlyArray<AgentTrack>
  readonly events: ReadonlyArray<SimEvent>
  readonly commands: ReadonlyArray<Command>
  readonly media?: ReadonlyArray<MediaAsset>
  /** 录制采样率,默认 20 Hz(§77 建议值) */
  readonly sampleHz?: number
  /** 生成时刻的仿真时间 */
  readonly generatedAt?: number
}

const DEFAULT_SAMPLE_HZ = 20

const EMPTY_LEVELS: Record<EventLevel, number> = { info: 0, warn: 0, error: 0, success: 0 }

/**
 * 轨迹引用的几何统计。
 *
 * 全部由采样点**算出来**,不额外记录 —— 这样即使换一个领域(车 / 船 / 机器人),
 * 同一份统计照样成立,不需要各自发明一套。
 */
function describeTrack(track: AgentTrack, sampleHz: number): TrackReference {
  let distance = 0
  let maxAltitude = 0
  let maxSpeed = 0
  let previous: { x: number; z: number; y: number; t: number } | null = null

  for (const point of track.points) {
    maxAltitude = Math.max(maxAltitude, point.y)
    if (previous) {
      const dt = point.simulationTime - previous.t
      const step = Math.hypot(point.x - previous.x, point.z - previous.z)
      distance += step
      if (dt > 1e-9) maxSpeed = Math.max(maxSpeed, step / dt)
    }
    previous = { x: point.x, y: point.y, z: point.z, t: point.simulationTime }
  }

  const first = track.points[0]
  const last = track.points[track.points.length - 1]

  return {
    agentId: track.agentId,
    type: track.type,
    label: track.label,
    points: track.points.length,
    sampleHz,
    startTime: first?.simulationTime ?? 0,
    endTime: last?.simulationTime ?? 0,
    distanceFlown: Number(distance.toFixed(2)),
    maxAltitude: Number(maxAltitude.toFixed(2)),
    maxSpeed: Number(maxSpeed.toFixed(2)),
  }
}

function describeEvents(events: ReadonlyArray<SimEvent>): EventReference {
  const byLevel: Record<EventLevel, number> = { ...EMPTY_LEVELS }
  let monotonic = true
  let previousTime = Number.NEGATIVE_INFINITY

  for (const event of events) {
    byLevel[event.level] = (byLevel[event.level] ?? 0) + 1
    if (event.simulationTime < previousTime - 1e-9) monotonic = false
    previousTime = event.simulationTime
  }

  return {
    total: events.length,
    byLevel,
    firstTime: events[0]?.simulationTime ?? 0,
    lastTime: events[events.length - 1]?.simulationTime ?? 0,
    monotonic,
  }
}

/** 挑出与本次任务相关的轨迹:优先任务指派的 Agent,没有就取第一条 */
function pickTrack(tracks: ReadonlyArray<AgentTrack>, agentId: AgentId | null): AgentTrack | null {
  if (tracks.length === 0) return null
  if (agentId !== null) {
    const owned = tracks.find((track) => track.agentId === agentId)
    if (owned) return owned
  }
  return tracks[0] ?? null
}

/** 把 Task 的结论 + 过程数据拼成一份完整结果 */
export function buildTaskResult(input: BuildTaskResultInput): TaskResultReport {
  const sampleHz = Math.max(1, input.sampleHz ?? DEFAULT_SAMPLE_HZ)
  const track = pickTrack(input.tracks, input.task.agentId)
  const events = describeEvents(input.events)

  return {
    taskId: input.task.id,
    type: input.task.type,
    label: input.task.label,
    agentId: input.task.agentId,
    status: input.outcome.status,
    duration: input.outcome.duration,
    message: input.outcome.message,
    metrics: input.outcome.metrics,
    statistics: {
      trackPoints: track?.points.length ?? 0,
      events: events.total,
      commands: input.commands.length,
      warnings: events.byLevel.warn,
      errors: events.byLevel.error,
      sampleHz,
    },
    trackReference: track ? describeTrack(track, sampleHz) : null,
    eventReference: events,
    mediaReference: input.media ?? [],
    generatedAt: input.generatedAt ?? 0,
  }
}

// ————————————————————————————— ResultSummary —————————————————————————————

/** 一行摘要:面板上放不下整份报告时用它(§32 ResultSummary) */
export interface ResultSummary {
  readonly taskId: TaskId
  readonly status: TaskStatus
  /** 例:`2 分 34 秒` */
  readonly durationText: string
  /** 例:`312.4 m · 最高 19.2 m · 0 告警` */
  readonly headline: string
}

export function summarizeTaskResult(report: TaskResultReport): ResultSummary {
  const distance = report.trackReference?.distanceFlown ?? 0
  const altitude = report.trackReference?.maxAltitude ?? 0
  const parts = [
    `${distance.toFixed(1)} m`,
    `最高 ${altitude.toFixed(1)} m`,
    report.statistics.warnings > 0 ? `${report.statistics.warnings} 告警` : '0 告警',
  ]
  return {
    taskId: report.taskId,
    status: report.status,
    durationText: formatDuration(report.duration),
    headline: parts.join(' · '),
  }
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`
}
