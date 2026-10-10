/**
 * 巡检点结果 —— 「一个部位一次采集」的全部事实(§55 `InspectionPointResult`)。
 *
 * 它同时是**评价的输入**与**对账的凭据**,所以两样东西并排放着:
 *   · 巡检结论(位姿、观测几何、成像质量、判定)—— 真实系统里能拿到的
 *   · 地面真值(`truth`)—— 只有仿真里才知道,只用于对账召回/精度
 *
 * 界面与导出都必须把这两块分开显示:把真值混进结论,报告就会看起来比现场强。
 *
 * 本文件刻意不依赖任何「航线 / 任务」类型:记录是任务写下来的**结果**,
 * 它不该反过来认识产它的那个状态机。评价侧也一样 —— 只吃记录,不吃任务。
 */
import type { Vec3 } from '@simulation/contracts'
import type { PartDefect, PartKind } from '@simulation/power-domain'
import type { DetectionResult, DetectionVerdict, PartObservation } from '../metric/data-quality-metric'

// ————————————————————————————— 对账 —————————————————————————————

/** 结论与真值的对账结果。`suspect` 计入报警,所以它按「报警」参与 precision */
export type InspectionOutcome = 'truePositive' | 'falsePositive' | 'missed' | 'trueNegative' | 'unchecked'

export const OUTCOME_LABELS: Record<InspectionOutcome, string> = {
  truePositive: '命中',
  falsePositive: '误报',
  missed: '漏检',
  trueNegative: '正确排除',
  unchecked: '未采集',
}

/** 对账:报警 = 结论不是「正常」(疑似也算报警,因为现场要派人去看) */
export function classifyOutcome(verdict: DetectionVerdict, truth: PartDefect | null): InspectionOutcome {
  if (verdict === 'unchecked') return 'unchecked'
  const alarm = verdict !== 'ok'
  if (alarm) return truth ? 'truePositive' : 'falsePositive'
  return truth ? 'missed' : 'trueNegative'
}

// ————————————————————————————— 记录 —————————————————————————————

export interface InspectionRecord {
  readonly shotId: string
  readonly towerId: string
  readonly towerLabel: string
  /** 全局部位 id:`<塔号>/<部位 id>` */
  readonly partId: string
  readonly partLabel: string
  readonly partKind: PartKind
  /** 采集时刻的仿真时间(秒) */
  readonly simulationTime: number
  /** 采集瞬间的机体位置(世界系) */
  readonly dronePosition: Vec3
  /** 采集几何;未采集时为 null */
  readonly observation: PartObservation | null
  readonly detection: DetectionResult
  /** 地面真值 —— 仅用于对账,不是巡检结论的一部分 */
  readonly truth: PartDefect | null
  readonly outcome: InspectionOutcome
}
