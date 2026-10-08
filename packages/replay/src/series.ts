/**
 * 回放数据的曲线与统计(README §21 · §22)。
 *
 * 看板上的每个数字都出自这里,而这里全是**纯函数** ——
 * 输入记录下来的点列,输出图表能直接用的数。
 * 于是「看板上的数字对不对」可以被单测钉住,而不是靠肉眼看图。
 *
 * 口径与 result 包保持一致:距离是三维累计航程,速度是相邻两点的差分
 * (记录点 20 Hz,这个差分足够平滑,不再引入滤波 —— 滤波会把峰值抹掉,
 * 而复盘时最想看的恰恰是峰值)。
 */
import type { AgentTrack, TrackPoint } from '@simulation/recorder'
import type { ReplayData } from './data'

/** 曲线上的一个采样点 */
export interface ReplaySeriesPoint {
  readonly time: number
  /** 高度(m) */
  readonly altitude: number
  /** 水平速度(m/s) */
  readonly speed: number
  /** 垂直速度(m/s),正 = 上升 */
  readonly climbRate: number
}

/** 一次回放的统计摘要 */
export interface ReplayStatistics {
  readonly duration: number
  readonly points: number
  /** 累计航程(m),含垂直分量 */
  readonly distanceFlown: number
  readonly maxAltitude: number
  readonly minAltitude: number
  readonly maxSpeed: number
  /** 最大下降率(m/s),取正数 —— 复盘时看「掉得多快」 */
  readonly maxDescentRate: number
  readonly events: number
  readonly commands: number
}

/**
 * 从轨迹点列算高度 / 水平速度 / 垂直速度曲线。
 *
 * 首个点没有「前一点」,速度记 0 —— 那不是「停在原地」,是「无从比较」,
 * 图上第一个点贴着零线是正常的,不要误读成起飞前在动。
 */
export function buildReplaySeries(points: ReadonlyArray<TrackPoint>): ReplaySeriesPoint[] {
  const series: ReplaySeriesPoint[] = []
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]
    if (!point) continue

    const previous = points[i - 1]
    let speed = 0
    let climbRate = 0
    if (previous) {
      const dt = point.simulationTime - previous.simulationTime
      if (dt > 1e-6) {
        speed = Math.hypot(point.x - previous.x, point.z - previous.z) / dt
        climbRate = (point.y - previous.y) / dt
      }
    }
    series.push({ time: point.simulationTime, altitude: point.y, speed, climbRate })
  }
  return series
}

/** 汇总统计。事件与指令只取时刻,所以调用方传什么带 simulationTime 的都行 */
export function summarizePoints(
  points: ReadonlyArray<TrackPoint>,
  events: ReadonlyArray<{ simulationTime: number }>,
  commands: ReadonlyArray<{ simulationTime: number }>,
): ReplayStatistics {
  let distanceFlown = 0
  let maxAltitude = 0
  let minAltitude = Number.POSITIVE_INFINITY
  let maxSpeed = 0
  let maxDescentRate = 0
  let lastTime = 0

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]
    if (!point) continue

    maxAltitude = Math.max(maxAltitude, point.y)
    minAltitude = Math.min(minAltitude, point.y)
    lastTime = Math.max(lastTime, point.simulationTime)

    const previous = points[i - 1]
    if (!previous) continue

    distanceFlown += Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z)
    const dt = point.simulationTime - previous.simulationTime
    if (dt > 1e-6) {
      maxSpeed = Math.max(maxSpeed, Math.hypot(point.x - previous.x, point.z - previous.z) / dt)
      maxDescentRate = Math.max(maxDescentRate, (previous.y - point.y) / dt)
    }
  }

  // 收尾事件(落地、断电)可能晚于轨迹末点,所以时长取轨迹/事件/指令三者的最晚时刻
  let duration = lastTime
  for (const event of events) duration = Math.max(duration, event.simulationTime)
  for (const command of commands) duration = Math.max(duration, command.simulationTime)

  return {
    duration,
    points: points.length,
    distanceFlown,
    maxAltitude,
    minAltitude: Number.isFinite(minAltitude) ? minAltitude : 0,
    maxSpeed,
    maxDescentRate,
    events: events.length,
    commands: commands.length,
  }
}

/**
 * 挑出「主轨迹」—— 点数最多的那条。
 *
 * 场景里可能有多架(README §80 的方向),但看板一次看一条才读得懂,
 * 所以先看「动作最多」的那个;点数相同取先出现的,保证结果稳定可测。
 */
export function primaryTrack(data: ReplayData): AgentTrack | null {
  let best: AgentTrack | null = null
  for (const track of data.tracks) {
    if (!best || track.points.length > best.points.length) best = track
  }
  return best
}
