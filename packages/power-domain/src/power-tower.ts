/**
 * 杆塔资产 —— 输电线路的骨架,以及它上面**真实存在**的缺陷(地面真值)。见 §40。
 *
 * 真值单独放一层,是这个功能能自证的前提:巡检报告里的「发现缺陷」必须能和
 * 「真的有什么」对账,否则「准确率」只是自己说自己。检测器(见 power-evaluation)
 * 只读资产、不写资产,产出的判定与真值对比后才有 `漏检 / 误检` 这些指标。
 *
 * ⚠️ 本文件是**几何与台账**,不引用 vue / three / 渲染层,也不做任何 I/O。
 */
import type { DefectKind, DefectSeverity, TowerType } from './power-asset-type'

/** 资产上真实存在的一条缺陷(地面真值) */
export interface PartDefect {
  /** 对应的检查部位 id —— 见 `InspectionPart.id` */
  readonly partId: string
  readonly kind: DefectKind
  readonly severity: DefectSeverity
  /** 现场备注,进报告 */
  readonly note?: string
}

export interface PowerTower {
  readonly id: string
  readonly label: string
  readonly type: TowerType
  /** 塔位中心(世界系水平坐标) */
  readonly x: number
  readonly z: number
  /** 塔身高度(米):最低一层横担到地面 */
  readonly bodyHeightM: number
  /** 横担层高(米,相对地面,从下往上) */
  readonly armLevelsM: ReadonlyArray<number>
  /** 横担半宽(米):挂点距塔中心的水平距离 */
  readonly armHalfSpanM: number
  /** 资产上真实存在的缺陷(地面真值) */
  readonly defects: ReadonlyArray<PartDefect>
}

/** 部位 id → 该部位的真实缺陷;没有则 null */
export function truthFor(tower: PowerTower, partId: string): PartDefect | null {
  return tower.defects.find((defect) => defect.partId === partId) ?? null
}
