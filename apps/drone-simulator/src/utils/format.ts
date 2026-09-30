/**
 * 界面格式化工具。
 * 遥测里的数字大多是旧项目实测调出来的量纲,显示前统一在这里收口,
 * 免得每个面板各写一套 toFixed。
 *
 * 参数一律允许 null:遥测里「无值」比「零」更常见(前方无障碍、未记录返航点…),
 * 用零去糊会让界面说谎。
 */

type MaybeNumber = number | null | undefined

export function formatNumber(value: MaybeNumber, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '--'
}

export function formatMeters(value: MaybeNumber, digits = 1): string {
  return `${formatNumber(value, digits)} m`
}

export function formatSpeed(value: MaybeNumber, digits = 1): string {
  return `${formatNumber(value, digits)} m/s`
}

export function formatPercent(value: MaybeNumber, digits = 0): string {
  return `${formatNumber(value, digits)} %`
}

export function formatVolts(value: MaybeNumber, digits = 2): string {
  return `${formatNumber(value, digits)} V`
}

/** 秒 → mm:ss */
export function formatClock(seconds: MaybeNumber): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '--:--'
  const total = Math.max(0, Math.floor(seconds))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** 秒 → mm:ss.d(仿真时间用,要看到 60 Hz 的推进) */
export function formatSimulationClock(seconds: MaybeNumber): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '--:--.-'
  const tenths = Math.floor((Math.max(0, seconds) % 1) * 10)
  return `${formatClock(seconds)}.${tenths}`
}

export function formatHeading(degrees: MaybeNumber): string {
  return `${formatNumber(degrees, 0)}°`
}

/** 罗盘方位角 → 八方位中文(0 = 北,90 = 东,与平台约定一致) */
export function compassLabel(degrees: MaybeNumber): string {
  if (typeof degrees !== 'number' || !Number.isFinite(degrees)) return '--'
  const labels = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  const index = Math.round((((degrees % 360) + 360) % 360) / 45) % 8
  return labels[index] ?? '--'
}

export function formatSigned(value: MaybeNumber, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--'
  const text = value.toFixed(digits)
  return value > 0 ? `+${text}` : text
}
