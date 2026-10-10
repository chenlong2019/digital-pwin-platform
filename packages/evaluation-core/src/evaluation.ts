/**
 * 评价器契约(§29 `evaluation.ts`)。
 *
 * 这一层只固定两件事:**评价器怎么自我介绍**、**评价状态怎么表述**。
 * 输入输出类型由业务包自己定(它的指标只对它自己有意义),但「谁评的、哪一版、
 * 评出了什么状态」必须统一 —— 否则一次作业出了结论,没人能回答它是被哪一版
 * 规则评的。
 */
export type EvaluationStatus = 'passed' | 'warning' | 'failed' | 'incomplete'

export const EVALUATION_STATUS_LABELS: Record<EvaluationStatus, string> = {
  passed: '通过',
  warning: '有告警',
  failed: '不通过',
  incomplete: '未完成',
}

/**
 * 通用评价器:`I` 是输入(业务侧的数据),`O` 是输出(通常是 `EvaluationResult` 的子集)。
 *
 * 约束在文档里,不在类型里:**评价器必须是纯函数** —— 不吃时钟、不吃随机数、
 * 不读 Runtime。同一次作业评两遍必须一模一样,否则「报告可复现」这件事就断了。
 */
export interface Evaluator<I, O> {
  /** 稳定标识:`power-inspection` / … 写进结果里,便于追溯 */
  readonly id: string
  readonly label: string
  /** 规则版本:算法改了要往上走,旧结果仍然能说清自己是被谁评的 */
  readonly version: string
  evaluate(input: I): O
}
