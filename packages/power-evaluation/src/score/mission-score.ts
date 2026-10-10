/**
 * 作业评分(§53 `score/mission-score.ts`)—— 一次巡检的四条指标,以及它们压成的分。
 *
 * 为什么是这四条(而不是十几条):
 *   · **部位覆盖率** —— 该看的看没看全。这是作业完成度,权重最高。
 *   · **缺陷召回率** —— 真有缺陷有没有漏掉。电力巡检里漏检是**最贵**的错误:
 *     一次漏掉的螺栓缺失可能在下一次大风里变成倒塔。
 *   · **报警精度** —— 报出来的缺陷是不是真的。精度低不等于危险,但意味着
 *     每一个报警都要派人复核,是实打实的成本。
 *   · **平均成像质量** —— 前三项是「结论」,这一项是「结论的底子」:画质差到
 *     看不清时,前两项的数字也不可信。它同时是唯一**不依赖地面真值**的可信度指标 ——
 *     现场拿不到真值,但拿得到画质。
 *
 * 达标线(`*_TARGET`)写在这儿而不是散在判定里,因为它表达的是**验收口径**,
 * 换一套口径就是换一套评分,不涉及算法。
 *
 * 召回率/精度在「没有真值缺陷」或「没有报警」时是 null —— 按 `evaluation-core`
 * 的规则,缺数据的指标**不参与评分**,权重和随之重算。所以一次干净的巡检
 * (没有真值缺陷)不会因为召回率是「—」而被扣分,覆盖率与画质照样说话。
 */
import type { Metric, Score } from '@simulation/evaluation-core'
import { createMetric, scoreMetrics } from '@simulation/evaluation-core'
import type { InspectionReport } from '../report/inspection-report'

/** 覆盖率达标线:能不能把该看的看全,97% 以下就说明有整基塔没拍成 */
export const COVERAGE_TARGET = 0.97
/** 召回率达标线:真值缺陷的漏检上限 */
export const RECALL_TARGET = 0.9
/** 精度达标线:报警里允许的误报比例 */
export const PRECISION_TARGET = 0.8
/** 平均成像质量达标线:低于它,上面的结论就该打问号 */
export const QUALITY_TARGET = 0.8

/** 指标权重:覆盖率 > 召回 > 精度 > 画质。注意力按「后果有多贵」分配,不按「好不好看」 */
export const MISSION_METRIC_WEIGHTS = {
  coverage: 0.35,
  recall: 0.3,
  precision: 0.2,
  dataQuality: 0.15,
} as const

/** 报告 → 四条指标。纯函数:同一份报告永远得到同一组指标 */
export function missionMetrics(report: InspectionReport): Metric[] {
  const summary = report.summary
  return [
    createMetric({
      key: 'coverage',
      label: '部位覆盖率',
      value: summary.coverage,
      unit: 'ratio',
      direction: 'higher',
      target: COVERAGE_TARGET,
      weight: MISSION_METRIC_WEIGHTS.coverage,
    }),
    createMetric({
      key: 'recall',
      label: '缺陷召回率',
      value: summary.recall,
      unit: 'ratio',
      direction: 'higher',
      target: RECALL_TARGET,
      weight: MISSION_METRIC_WEIGHTS.recall,
    }),
    createMetric({
      key: 'precision',
      label: '报警精度',
      value: summary.precision,
      unit: 'ratio',
      direction: 'higher',
      target: PRECISION_TARGET,
      weight: MISSION_METRIC_WEIGHTS.precision,
    }),
    createMetric({
      key: 'dataQuality',
      label: '平均成像质量',
      value: summary.averageQuality,
      unit: 'ratio',
      direction: 'higher',
      target: QUALITY_TARGET,
      weight: MISSION_METRIC_WEIGHTS.dataQuality,
    }),
  ]
}

/** 报告 → 总分。归一化与加权全部在 `evaluation-core` 里,这里只负责选指标 */
export function missionScore(report: InspectionReport): Score {
  return scoreMetrics(missionMetrics(report))
}
