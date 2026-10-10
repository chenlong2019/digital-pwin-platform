/**
 * 评分 —— 把一堆指标压成一个 0~1 的数(§29 `score.ts`)。
 *
 * 只有一条规则,写在明面上:**以「达标线」为满分线做归一化,再按权重加权**。
 *
 *   · 越大越好的指标(覆盖率、召回率):得分 = min(1, value / target)
 *   · 越小越好的指标(越障次数、超时次数):得分 = value ≤ target ? 1 : target / value
 *
 * 于是「刚好达标 = 1.0」这件事是可解释的,而不是拍一个经验系数。也因此
 * **没设 target 的指标不参与评分**(归一化没有基准),它照样出现在指标表里,
 * 只是不进总分 —— 权重和被同时记下来,便于回答「这次只算了三项,为什么」。
 *
 * 缺值的指标同样不参与评分:分母按「参与项的权重和」重算,而不是当 0 分扣,
 * 这样一次没拍到照片的巡检不会因为「没数据」被判成评分 0 —— 它会被
 * `EvaluationResult.status` 标成「未完成」。两件事分开表达。
 */
import type { Metric } from './metric'

export type ScoreGrade = 'good' | 'fair' | 'poor' | 'unknown'

export const SCORE_GRADE_LABELS: Record<ScoreGrade, string> = {
  good: '良好',
  fair: '一般',
  poor: '偏低',
  unknown: '无法评分',
}

export interface Score {
  /** 0~1 的总分;没有任何可评指标时为 null */
  readonly value: number | null
  readonly grade: ScoreGrade
  /** 每个参与评分的指标的归一化得分(键 = `Metric.key`),缺数据的不出现 */
  readonly byMetric: Readonly<Record<string, number>>
  /** 参与评分的权重和 —— 用它解释总分的分母 */
  readonly weight: number
}

/** 档位阈值:≥ good 算良好,≥ fair 算一般,再低算偏低 */
export const SCORE_GRADE_THRESHOLDS = { good: 0.9, fair: 0.75 } as const

export function gradeScore(value: number | null, thresholds: { good: number; fair: number } = SCORE_GRADE_THRESHOLDS): ScoreGrade {
  if (value === null) return 'unknown'
  if (value >= thresholds.good) return 'good'
  if (value >= thresholds.fair) return 'fair'
  return 'poor'
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * 单条指标的归一化得分。
 * 返回 null 表示「不参与评分」:缺值、没设达标线、或权重非正。
 */
export function normalizeMetric(metric: Metric): number | null {
  if (metric.value === null || metric.target === null || metric.weight <= 0) return null
  if (metric.direction === 'higher') {
    if (metric.target <= 0) return metric.value >= metric.target ? 1 : 0
    return clamp01(metric.value / metric.target)
  }
  if (metric.value <= metric.target) return 1
  if (metric.value <= 0) return 1
  return clamp01(metric.target / metric.value)
}

export function scoreMetrics(metrics: ReadonlyArray<Metric>): Score {
  const byMetric: Record<string, number> = {}
  let weighted = 0
  let weight = 0

  for (const metric of metrics) {
    const normalized = normalizeMetric(metric)
    if (normalized === null) continue
    byMetric[metric.key] = Math.round(normalized * 1000) / 1000
    weighted += normalized * metric.weight
    weight += metric.weight
  }

  const value = weight > 0 ? Math.round((weighted / weight) * 1000) / 1000 : null
  return { value, grade: gradeScore(value), byMetric, weight: Math.round(weight * 1000) / 1000 }
}
