/**
 * 巡检作业评价器(§56 `InspectionEvaluator`)—— 把一份巡检报告读成「作业评价」。
 *
 * 输入:报告(指标与记录的汇总)
 * 输出:`EvaluationResult` —— 指标 + 总分 + 违规清单 + 状态(§56 的 PowerInspectionResult
 *      在本平台里的落地形态,词全部来自 `evaluation-core`)
 *
 * 三条规矩,决定了它为什么值得单独存在:
 *
 *   ① **只读报告,不吃 Runtime**。它不 tick、不读时钟、不碰随机数 —— 给同一份报告
 *      评一百遍,结果一模一样(§54「Input Data → Pure Evaluation → Result」)。
 *      所以它可以在测试里对着一份造出来的报告直接跑,不需要飞一遍。
 *   ② **违规与指标分开**。指标回答「干得怎么样」,违规回答「哪里不合规」。
 *      把两者揉成一个「不及格」,现场就不知道回去该干什么。
 *   ③ **严重度按后果分,不按数量分**。漏检是 major(会倒塔),覆盖不全按缺口大小
 *      分 major / minor(补飞能解决),精度低与画质差是 minor / info(多跑一趟而已)。
 *      「哪一条最要命」这件事由 `evaluation-core` 的固定四档决定,不由这里临时发明。
 */
import type { EvaluationResult, Evaluator, Violation } from '@simulation/evaluation-core'
import { createViolation, deriveEvaluationStatus, sortBySeverity } from '@simulation/evaluation-core'
import { DEFECT_LABELS, SEVERITY_LABELS } from '@simulation/power-domain'
import type { InspectionRecord } from '../point/inspection-point-result'
import type { InspectionReport } from '../report/inspection-report'
import { COVERAGE_TARGET, QUALITY_TARGET, PRECISION_TARGET, missionMetrics, missionScore } from '../score/mission-score'

export const INSPECTION_EVALUATOR_ID = 'power-inspection'
/** 评价规则版本:口径改了要往上走,旧报告仍然说清是被谁评的 */
export const INSPECTION_EVALUATOR_VERSION = 'rule-v1'

/** 覆盖率低于此值时,缺口已不是「补几个拍点」而是整基塔没拍,直接按 major 报 */
const COVERAGE_MAJOR_THRESHOLD = 0.5
/** 采集俯仰超过该角度(与判定器的畸变软限一致)就提示机位问题 */
const TILT_LIMIT_DEG = 35

export interface InspectionEvaluationInput {
  readonly report: InspectionReport
  /** 评价生成时刻(仿真秒);不传就用报告结束时刻 —— 包内不取墙钟 */
  readonly generatedAtS?: number
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** 报告 → 违规清单。按「已排序」返回,界面与导出直接用 */
export function inspectionViolations(report: InspectionReport): Violation[] {
  const summary = report.summary
  const violations: Violation[] = []

  // ① 没跑完:直接一个 major,后面那些指标只能算「当前进度」,不当作结论
  if (report.status !== 'completed') {
    violations.push(
      createViolation({
        rule: 'mission-incomplete',
        severity: 'major',
        message: `巡检未跑完(${report.status}):${report.message}`,
        atS: report.finishedAtS,
      }),
    )
  }

  // ② 覆盖缺口:说清缺多少,而不是只说「覆盖率低」
  if (summary.coverage < COVERAGE_TARGET) {
    violations.push(
      createViolation({
        rule: 'coverage-gap',
        severity: summary.coverage < COVERAGE_MAJOR_THRESHOLD ? 'major' : 'minor',
        message:
          `部位覆盖 ${percent(summary.coverage)},未达 ${percent(COVERAGE_TARGET)} 目标;` +
          `还有 ${summary.partsUnchecked} 个部位未采集`,
        atS: report.finishedAtS,
      }),
    )
  }

  // ③ 漏检:逐条报,带部位与真值类型 —— 这一条是现场最需要立刻知道的
  for (const record of report.records) {
    if (record.outcome !== 'missed') continue
    violations.push(missedViolation(record))
  }

  // ④ 画质:结论的底子。不依赖地面真值,所以现场也拿得到
  if (summary.averageQuality !== null && summary.averageQuality < QUALITY_TARGET) {
    violations.push(
      createViolation({
        rule: 'quality-gap',
        severity: 'minor',
        message: `平均成像质量 ${summary.averageQuality.toFixed(3)},低于 ${QUALITY_TARGET} —— 结论的可信度不足,建议复拍`,
        atS: report.finishedAtS,
      }),
    )
  }

  // ⑤ 精度:误报要人工复核,是成本不是风险
  if (summary.precision !== null && summary.precision < PRECISION_TARGET) {
    violations.push(
      createViolation({
        rule: 'precision-gap',
        severity: 'minor',
        message: `报警精度 ${percent(summary.precision)},低于 ${percent(PRECISION_TARGET)} —— 误报 ${summary.falsePositive} 条,需人工复核`,
        atS: report.finishedAtS,
      }),
    )
  }

  // ⑥ 机位:全在仰着头看这类问题不体现在任何指标里,但它解释了很多低画质
  for (const tower of report.towers) {
    if (tower.maxTiltDeg < TILT_LIMIT_DEG) continue
    violations.push(
      createViolation({
        rule: 'tilt-exceeded',
        severity: 'info',
        message: `${tower.towerLabel} 采集时最大俯仰 ${tower.maxTiltDeg}°,超过畸变软限 ${TILT_LIMIT_DEG}°`,
      }),
    )
  }

  // ⑦ 一句总结性的话都没有时,返回空清单 —— 「没有违规」是一个合法的结论
  return sortBySeverity(violations)
}

function missedViolation(record: InspectionRecord): Violation {
  const truth = record.truth
  const what = truth ? `${SEVERITY_LABELS[truth.severity]}·${DEFECT_LABELS[truth.kind]}` : '缺陷'
  return createViolation({
    rule: 'missed-defect',
    severity: 'major',
    message: `漏检:${record.towerLabel} ${record.partLabel} 存在${what},本次未报出(${record.detection.note})`,
    atS: record.simulationTime,
    ref: record.partId,
    at: record.dronePosition,
  })
}

/**
 * 评价一次巡检作业。
 *
 * 纯函数:同一份报告 + 同一个时刻 → 逐字节相同的结果。
 */
export function evaluateInspection(input: InspectionEvaluationInput): EvaluationResult {
  const report = input.report
  const violations = inspectionViolations(report)
  const metrics = missionMetrics(report)

  return {
    subjectId: report.id,
    subjectLabel: `${report.lineLabel} · ${report.taskLabel}`,
    evaluatorId: INSPECTION_EVALUATOR_ID,
    evaluatorVersion: INSPECTION_EVALUATOR_VERSION,
    status: deriveEvaluationStatus({ complete: report.status === 'completed', violations }),
    metrics,
    score: missionScore(report),
    violations,
    generatedAtS: input.generatedAtS ?? report.finishedAtS,
  }
}

/** §29 的评价器契约形态:给「按统一接口调用评价」的地方用(将来换评价算法只换这个对象) */
export const inspectionEvaluator: Evaluator<InspectionEvaluationInput, EvaluationResult> = {
  id: INSPECTION_EVALUATOR_ID,
  label: '电网巡检作业评价',
  version: INSPECTION_EVALUATOR_VERSION,
  evaluate: evaluateInspection,
}
