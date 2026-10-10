/**
 * 评价结果(§29 `evaluation-result.ts`) —— 一段评价的完整产出。
 *
 * 四样东西并列,不合并:「量出来的指标」「压成的分」「违规清单」「状态」。
 * 前两样回答「干得怎么样」,第三样回答「哪里不合规」,第四样回答「过没过」。
 *
 * `generatedAtS` 由调用方注入(仿真秒),包内不取墙钟 —— 与本平台其余部分一致
 * （确定性仿真里没有「现在」)。
 */
import type { EvaluationStatus } from './evaluation'
import type { Metric } from './metric'
import type { Score } from './score'
import { hasBlockingViolation } from './violation'
import type { Violation } from './violation'

export interface EvaluationResult {
  /** 被评对象的稳定标识(任务 id / 报告 id) */
  readonly subjectId: string
  readonly subjectLabel: string
  /** 谁评的 */
  readonly evaluatorId: string
  readonly evaluatorVersion: string
  readonly status: EvaluationStatus
  readonly metrics: ReadonlyArray<Metric>
  readonly score: Score
  /** 违规清单(已按严重度排序) */
  readonly violations: ReadonlyArray<Violation>
  /** 生成时刻的仿真时间(秒),由调用方注入 */
  readonly generatedAtS: number
}

export interface EvaluationStatusInput {
  /** 被评对象是否**跑完了**。没跑完 ≠ 跑得差,所以单独一个入参 */
  readonly complete: boolean
  readonly violations: ReadonlyArray<Violation>
}

/**
 * 状态口径(所有行业评价共用):
 *   · 没跑完 → `incomplete`(哪怕指标好看,也不假装完成)
 *   · 有 major / critical 违规 → `failed`
 *   · 只有 info / minor → `warning`(降分但不否决)
 *   · 一条都没有 → `passed`
 */
export function deriveEvaluationStatus(input: EvaluationStatusInput): EvaluationStatus {
  if (!input.complete) return 'incomplete'
  if (hasBlockingViolation(input.violations)) return 'failed'
  if (input.violations.length > 0) return 'warning'
  return 'passed'
}
