/**
 * 检查点结果 —— 「一个检查点算不算有效采集」(产品规格 §5.1 / §5.2)。
 *
 * 这里刻意与 `InspectionOutcome`(命中 / 误报 / 漏检 / 正确排除)**分开**:
 *
 *   · `InspectionOutcome` 是**对账口径** —— 它拿结论与地面真值比,只有仿真里才有真值。
 *   · `PointStatus` 是**作业口径** —— 只看「这次采集本身成不成立」:到没到、多远、
 *     航向对不对、云台偏不偏、证据够不够、关联全不全。真实系统里也拿得到,可以
 *     直接交给现场。规格 §5.2 要的是后者;把两者混起来,报告就会看起来比现场强。
 *
 * 六条检查逐条独立给出结论(§5.1「每项条件都应能独立解释失败原因」),所以界面上
 * 能直说「是航向偏了 18°,不是没拍到」,而不是笼统一个「失败」。
 *
 * 纯函数:同一份记录 + 同一条航线,结果必然相同。
 */
import type { InspectionRouteFacts, InspectionRouteShotFacts } from '../report/inspection-route-facts'
import type { InspectionRecord } from './inspection-point-result'

// ————————————————————————————— 状态 —————————————————————————————

/**
 * 检查点状态(§5.2)。
 *
 * `pending / approaching / inspecting` 是**过程中**的状态,由任务执行时给出;
 * 报告与结果页只关心四个终态 —— 见 `POINT_FINAL_STATUSES`。
 */
export type PointStatus =
  | 'pending'
  | 'approaching'
  | 'inspecting'
  | 'passed'
  | 'warning'
  | 'failed'
  | 'skipped'

export const POINT_STATUS_LABELS: Record<PointStatus, string> = {
  pending: '待执行',
  approaching: '接近中',
  inspecting: '采集中',
  passed: '通过',
  warning: '警告',
  failed: '失败',
  skipped: '跳过',
}

/** 终态:报告与结果页只统计这四个(§5.3「结果中还必须给出四类统计」) */
export const POINT_FINAL_STATUSES = ['passed', 'warning', 'failed', 'skipped'] as const

export type PointFinalStatus = (typeof POINT_FINAL_STATUSES)[number]

// ————————————————————————————— 逐条件检查 —————————————————————————————

export type PointCheckKind = 'arrival' | 'distance' | 'heading' | 'gimbal' | 'capture' | 'link'

export const POINT_CHECK_LABELS: Record<PointCheckKind, string> = {
  arrival: '到达拍点',
  distance: '拍摄距离',
  heading: '机身航向',
  gimbal: '云台方向',
  capture: '采集数量',
  link: '证据关联',
}

/** 一条检查的结论 —— `detail` 是人话,界面与报告直接显示它 */
export interface PointCheck {
  readonly kind: PointCheckKind
  readonly label: string
  readonly ok: boolean
  readonly detail: string
}

// ————————————————————————————— 结果 —————————————————————————————

export interface InspectionPointResult {
  readonly pointId: string
  readonly label: string
  readonly towerId: string
  readonly towerLabel: string
  /** 是否启用(禁用的点状态必为 `skipped`) */
  readonly enabled: boolean
  readonly status: PointStatus
  readonly checks: ReadonlyArray<PointCheck>
  /** 本检查点产出的证据 id(= 部位全局 id),可追溯到资产与部件(§7.2) */
  readonly captureIds: ReadonlyArray<string>
  /** 未通过的原因短句;通过时为空 */
  readonly problems: ReadonlyArray<string>
}

function fmt(value: number, digits = 1): string {
  return value.toFixed(digits)
}

/**
 * 判一个检查点。
 *
 * 状态规则(刻意简单,免得「失败」变成一个说不清的东西):
 *   · 未启用            → `skipped`(计划内取舍)
 *   · 没有任何记录       → `skipped`(任务没走到这个点:中止 / 还没轮到)
 *   · 有记录但无有效证据 → `failed`(记录里带着原因:转场超时 / 对准超时)
 *   · 六条检查有不过的   → `failed`
 *   · 全过但有疑似       → `warning`(疑似不判失败,但必须有人复核)
 *   · 全过且无疑似       → `passed`
 */
export function evaluatePoint(input: {
  readonly shot: InspectionRouteShotFacts
  readonly records: ReadonlyArray<InspectionRecord>
}): InspectionPointResult {
  const { shot, records } = input
  const captures = records.filter((record) => record.detection.verdict !== 'unchecked')
  const captureIds = captures.map((record) => record.partId)
  const base = {
    pointId: shot.id,
    label: shot.label,
    towerId: shot.towerId,
    towerLabel: shot.towerLabel,
    enabled: shot.enabled,
  }

  if (!shot.enabled) {
    return { ...base, status: 'skipped', checks: [], captureIds: [], problems: ['检查点已禁用,未执行'] }
  }
  if (records.length === 0) {
    return { ...base, status: 'skipped', checks: [], captureIds: [], problems: ['任务未执行到该检查点'] }
  }

  const observation = captures.find((record) => record.observation !== null)?.observation ?? null
  const requirement = shot.requirement
  const [minRange, maxRange] = requirement.distanceRangeM
  const checks: PointCheck[] = [
    {
      kind: 'arrival',
      label: POINT_CHECK_LABELS.arrival,
      ok: observation !== null,
      detail: observation ? '已抵达悬停位并完成采集' : '未抵达拍点',
    },
    {
      kind: 'distance',
      label: POINT_CHECK_LABELS.distance,
      ok: observation !== null && observation.rangeM >= minRange && observation.rangeM <= maxRange,
      detail:
        observation === null
          ? '未采集,无法测距'
          : `${fmt(observation.rangeM)} m(要求 ${fmt(minRange)}~${fmt(maxRange)} m)`,
    },
    {
      kind: 'heading',
      label: POINT_CHECK_LABELS.heading,
      ok: observation !== null && Math.abs(observation.headingErrorDeg) <= requirement.headingToleranceDeg,
      detail:
        observation === null
          ? '未采集,机身航向未知'
          : `偏差 ${fmt(Math.abs(observation.headingErrorDeg))}°(容差 ${requirement.headingToleranceDeg}°)`,
    },
    {
      kind: 'gimbal',
      label: POINT_CHECK_LABELS.gimbal,
      ok: observation !== null && Math.abs(observation.offAxisDeg) <= requirement.gimbalToleranceDeg,
      detail:
        observation === null
          ? '未采集,云台方向未知'
          : `光轴偏心 ${fmt(Math.abs(observation.offAxisDeg))}°(容差 ${requirement.gimbalToleranceDeg}°)`,
    },
    {
      kind: 'capture',
      label: POINT_CHECK_LABELS.capture,
      ok: captures.length >= requirement.captureCount,
      detail: `采集 ${captures.length} 张(要求 ${requirement.captureCount} 张)`,
    },
    {
      kind: 'link',
      label: POINT_CHECK_LABELS.link,
      ok: captures.length > 0 && captures.every((record) => record.towerId === shot.towerId && record.partId.length > 0),
      detail:
        captures.length === 0
          ? '没有证据可关联'
          : `已关联 ${captures.length} 条部位证据(${shot.towerLabel})`,
    },
  ]

  const failed = checks.filter((check) => !check.ok)
  const problems: string[] = []
  if (captures.length === 0) {
    // 记录里带着任务写下的原因(转场超时 / 对准超时 / 检查点已禁用)
    for (const record of records) if (record.detection.note) problems.push(record.detection.note)
    if (problems.length === 0) problems.push('未能采集到有效证据')
  } else {
    for (const check of failed) problems.push(`${check.label}不满足:${check.detail}`)
  }

  const status: PointStatus =
    captures.length === 0
      ? 'failed'
      : failed.length > 0
        ? 'failed'
        : captures.some((record) => record.detection.verdict === 'suspect')
          ? 'warning'
          : 'passed'

  return { ...base, status, checks, captureIds, problems: [...new Set(problems)] }
}

/** 逐点判整条航线 —— 报告与结果页都从这里取,不各自写一遍 */
export function derivePointResults(
  route: InspectionRouteFacts,
  records: ReadonlyArray<InspectionRecord>,
): InspectionPointResult[] {
  return route.shots.map((shot) =>
    evaluatePoint({ shot, records: records.filter((record) => record.shotId === shot.id) }),
  )
}

/** 四类终态的点数统计(§5.3) */
export interface PointStatusCounts {
  readonly planned: number
  readonly passed: number
  readonly warning: number
  readonly failed: number
  readonly skipped: number
}

export function summarizePointStatuses(points: ReadonlyArray<InspectionPointResult>): PointStatusCounts {
  const count = (status: PointFinalStatus): number => points.filter((point) => point.status === status).length
  return {
    planned: points.length,
    passed: count('passed'),
    warning: count('warning'),
    failed: count('failed'),
    skipped: count('skipped'),
  }
}
