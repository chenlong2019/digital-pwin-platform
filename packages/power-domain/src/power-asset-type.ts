/**
 * 电力资产的枚举与标签 —— 线路 / 杆塔 / 部件 / 缺陷的行业口径。
 *
 * 标签(`*_LABELS`)与类型**放在一起**,是因为它们生来成对:报告、面板、导出
 * 都只能显示中文名,一旦拆到两个文件,加一种缺陷就会漏改一处。
 *
 * 坐标系沿用平台唯一约定:+X 东、+Y 上、−Z 北;航向 0° = 北、顺时针增加。
 */

// ————————————————————————————— 缺陷 —————————————————————————————

/**
 * 缺陷类型 —— 行业口径的简化子集。
 *
 * 只列这些不是偷懒:每一种都对应不同的**观察距离与角度要求**(绝缘子要近看单片,
 * 基础要俯视看护坡),所以它们同时是检测器的输入维度,而不只是一个标签。
 */
export type DefectKind =
  | 'insulatorBroken'
  | 'insulatorPollution'
  | 'armDeformation'
  | 'boltMissing'
  | 'towerRust'
  | 'foundationSettlement'
  | 'foreignObject'

export const DEFECT_LABELS: Record<DefectKind, string> = {
  insulatorBroken: '绝缘子破损',
  insulatorPollution: '绝缘子污秽',
  armDeformation: '横担变形',
  boltMissing: '螺栓缺失',
  towerRust: '塔材锈蚀',
  foundationSettlement: '基础沉陷',
  foreignObject: '异物搭挂',
}

export type DefectSeverity = 'minor' | 'major'

export const SEVERITY_LABELS: Record<DefectSeverity, string> = {
  minor: '隐患',
  major: '缺陷',
}

// ————————————————————————————— 部件 —————————————————————————————

export type PartKind = 'towerHead' | 'arm' | 'insulator' | 'towerBody' | 'foundation'

export const PART_KIND_LABELS: Record<PartKind, string> = {
  towerHead: '塔头',
  arm: '横担',
  insulator: '绝缘子串',
  towerBody: '塔身',
  foundation: '塔基',
}

// ————————————————————————————— 杆塔 —————————————————————————————

export type TowerType = 'suspension' | 'tension' | 'terminal'

export const TOWER_TYPE_LABELS: Record<TowerType, string> = {
  suspension: '直线塔',
  tension: '耐张塔',
  terminal: '终端塔',
}
