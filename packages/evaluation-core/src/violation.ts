/**
 * 违规 —— 「这次作业违反了哪条规则」(§29 `violation.ts`)。
 *
 * 一段评价里最容易变成垃圾场的就是告警:每个业务包自己造一套严重度、自己决定
 * 谁更重要,最后没人说得清「为什么这次不通过」。所以严重度是**固定四档**,
 * 排序与计数都在这里给出,业务侧只负责「按规矩判」,不负责「按心情排」。
 *
 * `ref` 只放一个稳定的字符串标识(部位 id / 塔号 / 拍点 id),不放对象 ——
 * 违规清单要能直接进报告、进导出、进工单,不应该拽着一棵对象树。
 */
import type { Vec3 } from '@simulation/contracts'

/** 违规严重度:固定四档,不留给业务包自行扩展 */
export type ViolationSeverity = 'info' | 'minor' | 'major' | 'critical'

export const VIOLATION_SEVERITY_LABELS: Record<ViolationSeverity, string> = {
  info: '提示',
  minor: '轻微',
  major: '严重',
  critical: '致命',
}

/** 排序与比较用的档位数字:越大越严重 */
export const VIOLATION_SEVERITY_RANK: Record<ViolationSeverity, number> = {
  info: 0,
  minor: 1,
  major: 2,
  critical: 3,
}

export interface Violation {
  /** 规则标识:`coverage-gap` / `missed-defect` / … 用于统计与去重,不用于显示 */
  readonly rule: string
  readonly severity: ViolationSeverity
  /** 给人看的一句话:说清「哪里、什么问题」 */
  readonly message: string
  /** 触发点(仿真时间,秒);与时刻无关的规则给 null */
  readonly atS: number | null
  /** 违规对象:`<塔号>/<部位 id>` 这类稳定标识;全局性问题给 null */
  readonly ref: string | null
  /** 位置(世界系);不需要指位置时给 null */
  readonly at: Vec3 | null
}

export interface ViolationInput {
  readonly rule: string
  readonly severity: ViolationSeverity
  readonly message: string
  readonly atS?: number | null
  readonly ref?: string | null
  readonly at?: Vec3 | null
}

export function createViolation(input: ViolationInput): Violation {
  return {
    rule: input.rule,
    severity: input.severity,
    message: input.message,
    atS: input.atS ?? null,
    ref: input.ref ?? null,
    at: input.at ?? null,
  }
}

/** 最严重的那一档;一条都没有则为 null —— 「没有违规」与「违规未知」不能混为一谈 */
export function worstSeverity(violations: ReadonlyArray<Violation>): ViolationSeverity | null {
  let worst: ViolationSeverity | null = null
  for (const violation of violations) {
    if (worst === null || VIOLATION_SEVERITY_RANK[violation.severity] > VIOLATION_SEVERITY_RANK[worst]) {
      worst = violation.severity
    }
  }
  return worst
}

export function countBySeverity(violations: ReadonlyArray<Violation>): Record<ViolationSeverity, number> {
  const counts: Record<ViolationSeverity, number> = { info: 0, minor: 0, major: 0, critical: 0 }
  for (const violation of violations) counts[violation.severity] += 1
  return counts
}

/** 按严重度从重到轻排序,同级保持输入顺序(稳定排序),报告与界面共用同一口径 */
export function sortBySeverity(violations: ReadonlyArray<Violation>): Violation[] {
  return violations
    .slice()
    .sort((a, b) => VIOLATION_SEVERITY_RANK[b.severity] - VIOLATION_SEVERITY_RANK[a.severity])
}

/** 是否够格「不通过」:只有 major / critical 才算 —— 提示与轻微只降分,不否决 */
export function hasBlockingViolation(violations: ReadonlyArray<Violation>): boolean {
  return violations.some((violation) => VIOLATION_SEVERITY_RANK[violation.severity] >= VIOLATION_SEVERITY_RANK.major)
}
