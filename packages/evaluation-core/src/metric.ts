/**
 * 指标 —— 评价的最小单位(§29 `metric.ts`)。
 *
 * 一条指标必须同时回答四件事,少一件就没法拿去做评价:
 *   · `value` —— 量出来的数。**可以缺失**（null）：「没测出来」不等于「是 0」，
 *     把它们混成一个数,报告就会在没数据时显示满分。
 *   · `unit` —— 怎么读这个数(比值 / 计数 / 米 / 秒 / 0~1 得分)。
 *   · `direction` —— 越大越好还是越小越好。没有这个,「0.8」到底是好是坏没法判断。
 *   · `target` —— 达标线。`null` = 该指标只上报、不设阈值。
 *   · `weight` —— 参与总评分时的相对权重；<= 0 = 不参与评分。
 *
 * 这里刻意不给「指标」加实现类:指标是数据,不是行为。行为在 `score.ts` 里,
 * 而且只有一条(归一化 + 加权),多了就是给业务包留后门。
 */
/** 指标的量纲。够用即可 —— 加新的量纲等于加一套显示口径,不要随手扩 */
export type MetricUnit = 'ratio' | 'count' | 'meters' | 'seconds' | 'score' | 'none'

/** 越大越好 / 越小越好 */
export type MetricDirection = 'higher' | 'lower'

export interface Metric {
  /** 稳定标识:`coverage` / `recall` / `dataQuality`… 用于按 key 取分,不用于显示 */
  readonly key: string
  readonly label: string
  /** 缺失就是 null(见文件头);求平均、算分时按「不参与」处理 */
  readonly value: number | null
  readonly unit: MetricUnit
  readonly direction: MetricDirection
  /** 达标线;null = 不设阈值 */
  readonly target: number | null
  /** 参与总评分的相对权重;<= 0 = 不参与评分 */
  readonly weight: number
}

export interface MetricInput {
  readonly key: string
  readonly label: string
  readonly value: number | null
  readonly unit?: MetricUnit
  readonly direction?: MetricDirection
  readonly target?: number | null
  readonly weight?: number
}

export function createMetric(input: MetricInput): Metric {
  return {
    key: input.key,
    label: input.label,
    value: input.value,
    unit: input.unit ?? 'ratio',
    direction: input.direction ?? 'higher',
    target: input.target ?? null,
    weight: input.weight ?? 1,
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * 比值指标 —— **分母为零时给 null,不给 1**。
 *
 * 「没有可评的对象」和「全都合格」是两件事:一次没拍到任何部位的巡检,
 * 召回率不该显示 100%。这条规则在本平台是从报告一路贯彻到界面的
 * （分母为零时界面显示「—」）。
 */
export function metricRatio(numerator: number, denominator: number, digits = 3): number | null {
  if (denominator <= 0) return null
  return round(numerator / denominator, digits)
}

/** 平均值指标;空集给 null,理由同上 */
export function metricAverage(values: ReadonlyArray<number>, digits = 3): number | null {
  if (values.length === 0) return null
  let total = 0
  for (const value of values) total += value
  return round(total / values.length, digits)
}

/** 计数指标:计数永远有值(0 就是 0),所以不给 null */
export function metricCount(key: string, label: string, value: number, weight = 0): Metric {
  return createMetric({ key, label, value, unit: 'count', direction: 'higher', weight })
}

/**
 * 是否达标。
 *
 * 三态:true / false / **null(无法判断)**。缺值、或没设阈值,都返回 null ——
 * 界面据此显示「—」,而不是把「不知道」渲染成「合格」。
 */
export function meetsTarget(metric: Metric): boolean | null {
  if (metric.value === null || metric.target === null) return null
  return metric.direction === 'higher' ? metric.value >= metric.target : metric.value <= metric.target
}

/** 指标值的显示文本(界面与导出共用同一口径,免得两边各写一个 toFixed) */
export function formatMetricValue(metric: Metric, digits = 2): string {
  if (metric.value === null) return '—'
  if (metric.unit === 'ratio') return `${(metric.value * 100).toFixed(digits > 0 ? 1 : 0)} %`
  if (metric.unit === 'score') return metric.value.toFixed(digits)
  if (metric.unit === 'meters') return `${metric.value.toFixed(digits)} m`
  if (metric.unit === 'seconds') return `${metric.value.toFixed(digits)} s`
  if (metric.unit === 'count') return String(Math.round(metric.value))
  return String(metric.value)
}
