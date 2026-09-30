/**
 * ReplayTimeline / ReplayController(README §22 · §58 · §32)。
 *
 *   Recorder Data → ReplaySession → ReplayController → ReplaySnapshot → Renderer
 *
 * 关键约定:
 *   · 回放**不重新跑仿真**。它只是在记录下来的采样点之间插值 ——
 *     所以回放出来的画面与当初看到的一致(§77:相同输入数据下应与记录状态
 *     保持规定容差内一致),而不是「同 seed 再跑一遍」那种近似重现。
 *   · 采样点**恰好落在记录时刻**时,取到的就是记录值本身,误差为 0。
 *   · 没有任何真实时间概念:推进靠外部投入 delta(§13:真实时间只允许在
 *     Runtime 的 advance 与这里出现),所以确定性不依赖机器快慢。
 */
import type { AgentId, Command, SimEvent, Vec3 } from '@simulation/contracts'
import type { TrackPoint } from '@simulation/recorder'
import type { ReplayData } from './data'

/** 某个 Agent 在回放某一时刻的位姿 */
export interface ReplayAgentState {
  readonly agentId: AgentId
  readonly type: string
  readonly label: string
  readonly position: Vec3
  readonly headingDeg: number
}

/** 回放对外发布的状态视图 —— 与 SimulationSnapshot 同构但不含仿真语义 */
export interface ReplaySnapshot {
  readonly sessionId: string
  readonly time: number
  /** 0~1 */
  readonly progress: number
  readonly playing: boolean
  readonly speed: number
  readonly agents: ReadonlyArray<ReplayAgentState>
  /** 到当前时刻为止**已经发生**的事件(回放时逐条浮现) */
  readonly events: ReadonlyArray<SimEvent>
  /** 当前时刻最近的一条指令 —— 复盘时看「当时按了什么」 */
  readonly command: Command | null
}

/** 最大的 i,使 points[i].simulationTime <= time(找不到则 0) */
function locate(points: ReadonlyArray<TrackPoint>, time: number): number {
  let low = 0
  let high = points.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if ((points[mid]?.simulationTime ?? 0) <= time) low = mid
    else high = mid - 1
  }
  return low
}

/** 最短弧上的角度插值:359° → 1° 应当走 2° 而不是 −358° */
function lerpAngle(from: number, to: number, k: number): number {
  const delta = ((to - from + 540) % 360) - 180
  return (from + delta * k + 360) % 360
}

function sampleTrack(points: ReadonlyArray<TrackPoint>, time: number): { position: Vec3; headingDeg: number } | null {
  const first = points[0]
  if (!first) return null
  const index = locate(points, time)
  const from = points[index] ?? first
  const to = points[index + 1]
  if (!to) return { position: { x: from.x, y: from.y, z: from.z }, headingDeg: from.headingDeg }

  const span = to.simulationTime - from.simulationTime
  const k = span > 1e-9 ? Math.min(1, Math.max(0, (time - from.simulationTime) / span)) : 0
  return {
    position: {
      x: from.x + (to.x - from.x) * k,
      y: from.y + (to.y - from.y) * k,
      z: from.z + (to.z - from.z) * k,
    },
    headingDeg: lerpAngle(from.headingDeg, to.headingDeg, k),
  }
}

/**
 * 回放时间轴(§32 ReplayTimeline)。
 * 只回答「现在是第几秒」,并把时间夹在 [0, duration] 内 ——
 * 越界的时间一律被夹紧而不是抛错,免得界面拖动滑杆时崩掉。
 */
export class ReplayTimeline {
  private current = 0

  constructor(private readonly data: ReplayData) {}

  get duration(): number {
    return this.data.duration
  }

  get time(): number {
    return this.current
  }

  get progress(): number {
    return this.data.duration > 0 ? this.current / this.data.duration : 0
  }

  get atEnd(): boolean {
    return this.data.duration > 0 && this.current >= this.data.duration - 1e-6
  }

  /** 跳到某个时刻,返回被夹紧后的实际时间 */
  seek(time: number): number {
    this.current = Math.min(this.data.duration, Math.max(0, time))
    return this.current
  }

  seekProgress(progress: number): number {
    return this.seek(progress * this.data.duration)
  }

  /** 前进 deltaSeconds × speed,返回实际推进的时间。到头后停在末尾(循环由控制器决定) */
  advance(deltaSeconds: number, speed = 1): number {
    const before = this.current
    this.seek(this.current + deltaSeconds * speed)
    return this.current - before
  }

  reset(): void {
    this.current = 0
  }

  sample(playing: boolean, speed: number): ReplaySnapshot {
    return sampleReplayData(this.data, this.current, playing, speed)
  }
}

/** 在任意时刻对整份数据取样(纯函数 —— 定序、可测、无状态) */
export function sampleReplayData(
  data: ReplayData,
  time: number,
  playing = false,
  speed = 1,
): ReplaySnapshot {
  const clamped = Math.min(data.duration, Math.max(0, time))

  const agents: ReplayAgentState[] = []
  for (const track of data.tracks) {
    const sampled = sampleTrack(track.points, clamped)
    if (!sampled) continue
    agents.push({
      agentId: track.agentId,
      type: track.type,
      label: track.label,
      position: sampled.position,
      headingDeg: sampled.headingDeg,
    })
  }

  const events = data.events.filter((event) => event.simulationTime <= clamped)

  let command: Command | null = null
  for (let i = data.commands.length - 1; i >= 0; i -= 1) {
    const candidate = data.commands[i]
    if (candidate && candidate.simulationTime <= clamped) {
      command = candidate
      break
    }
  }

  return {
    sessionId: data.sessionId,
    time: clamped,
    progress: data.duration > 0 ? clamped / data.duration : 0,
    playing,
    speed,
    agents,
    events,
    command,
  }
}

export interface ReplayControllerOptions {
  readonly speed?: number
  /** 放到末尾后自动从头开始,默认 false */
  readonly loop?: boolean
  /** 构造后立即开始播放,默认 false */
  readonly autoPlay?: boolean
}

/**
 * 回放控制器(§22 ReplayController)。
 *
 * 与 Runtime 一样由外部帧驱动(`update(delta)`),自己不持有定时器 ——
 * 这样它既能挂在渲染循环里(浏览器),也能在无头测试里按固定步长精确推进。
 */
export class ReplayController {
  readonly data: ReplayData
  readonly timeline: ReplayTimeline

  private playingState = false
  private speedValue: number
  private readonly loop: boolean
  private readonly listeners = new Set<(snapshot: ReplaySnapshot) => void>()

  constructor(data: ReplayData, options: ReplayControllerOptions = {}) {
    this.data = data
    this.timeline = new ReplayTimeline(data)
    this.speedValue = options.speed ?? 1
    this.loop = options.loop ?? false
    this.playingState = options.autoPlay ?? false
  }

  get playing(): boolean {
    return this.playingState
  }

  get speed(): number {
    return this.speedValue
  }

  get progress(): number {
    return this.timeline.progress
  }

  get snapshot(): ReplaySnapshot {
    return this.timeline.sample(this.playingState, this.speedValue)
  }

  play(): void {
    if (this.playingState) return
    this.playingState = true
    this.publish()
  }

  pause(): void {
    if (!this.playingState) return
    this.playingState = false
    this.publish()
  }

  toggle(): void {
    this.playingState = !this.playingState
    this.publish()
  }

  seek(time: number): void {
    this.timeline.seek(time)
    this.publish()
  }

  seekProgress(progress: number): void {
    this.timeline.seekProgress(progress)
    this.publish()
  }

  setSpeed(speed: number): void {
    this.speedValue = Math.max(0.05, speed)
    this.publish()
  }

  /**
   * 帧驱动:投入真实经过时间,推进回放(未播放时原地不动)。
   *
   * 循环模式下会把**超出末尾的时间结转**到下一轮(3 秒投进 2 秒的片子 ⇒ 停在 1 秒),
   * 否则播放速度会随帧率漂移 —— 这与 Runtime 固定步长要解决的是同一个问题。
   */
  update(deltaSeconds: number): void {
    if (!this.playingState) return
    const duration = this.timeline.duration
    if (duration <= 0) {
      this.playingState = false
      this.publish()
      return
    }

    const target = this.timeline.time + deltaSeconds * this.speedValue
    if (target < duration) {
      this.timeline.seek(target)
    } else if (this.loop) {
      this.timeline.seek(target % duration)
    } else {
      this.timeline.seek(duration)
      this.playingState = false
    }
    this.publish()
  }

  subscribe(listener: (snapshot: ReplaySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    this.playingState = false
    this.listeners.clear()
  }

  private publish(): void {
    const snapshot = this.snapshot
    for (const listener of [...this.listeners]) listener(snapshot)
  }
}
