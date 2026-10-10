/**
 * 任务预检查(产品规格 §3.2「任务校验」/ §13.4「可用性」)。
 *
 * 一条硬要求:**不能只给出「校验失败」**。所以这里产出的不是布尔值,而是一张
 * 可操作的清单 —— 每条都带
 *
 *   · `field`   —— 问题落在哪个字段 / 哪个检查点(`T03/S2` 这种可直接定位的 id)
 *   · `message` —— 说清是什么问题(带上实际数值,不是「参数不合法」)
 *   · `fix`     —— 告诉用户怎么改
 *
 * `error` 拦住任务(§5.3:只有通过校验的任务才能进入 Ready),`warning` 放行但要提示。
 * 纯函数:同一份航线 + 同一份方案,校验结果必然相同,所以它能被单测钉住。
 */
import type { Vec3 } from '@simulation/contracts'
import type { InspectionRoute } from './inspection-route'
import { towerTopAltitudeM } from './grid-scenario'

/** 塔顶净空余量(米):巡航高度必须比最高的塔头再高出这么多,否则转场会撞塔 */
export const CRUISE_CLEARANCE_M = 8
/** 起飞点离任何杆塔的最小水平距离(米):太近了起降会刮到塔 */
export const MIN_LAUNCH_CLEARANCE_M = 20
/** 镜头倍率的合法上限(与相机模型的可实现范围一致) */
export const MAX_LENS_ZOOM = 10
/** 单拍点采集时长的下限(秒):太短了画面抖一下就没得救 */
export const MIN_DWELL_SECONDS = 0.5

export type MissionIssueSeverity = 'error' | 'warning'

export interface MissionIssue {
  readonly severity: MissionIssueSeverity
  /** 机器可读的问题码,界面按它分组 */
  readonly code: string
  /** 问题落在哪里:字段名或检查点 id */
  readonly field: string
  readonly message: string
  /** 怎么改 —— 校验的意义全在这一行 */
  readonly fix: string
}

export interface ValidateMissionInput {
  /** 待校验的航线(由台账 + 作业方案推导) */
  readonly route: InspectionRoute
  /** 起飞点。传 `null` 表示尚未设置 */
  readonly home?: Vec3 | null
  /** 机型高度上限(米);不传则不校验 */
  readonly maxAltitudeM?: number
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 塔顶高度(米):与场景装配共用同一个函数,避免两处几何各写一遍 */
const towerTop = towerTopAltitudeM

/** 预检查。返回的清单已按「先 error、后 warning」排好 */
export function validateMission(input: ValidateMissionInput): MissionIssue[] {
  const { route } = input
  const issues: MissionIssue[] = []
  const line = route.line

  // ① 资产是否存在
  if (line.towers.length === 0) {
    issues.push({
      severity: 'error',
      code: 'no-assets',
      field: '线路台账',
      message: `${line.label} 名下一座杆塔都没有`,
      fix: '在场景/资产模式里给这条线路补上杆塔资产,或改选别的线路',
    })
  }

  // ② 巡检点是否有效
  if (route.shots.length === 0) {
    issues.push({
      severity: 'error',
      code: 'no-points',
      field: '检查点清单',
      message: '这条航线一个检查点都没有',
      fix: '选择线路与检查模板后重新生成检查点',
    })
  }
  for (const shot of route.shots) {
    if (shot.parts.length > 0) continue
    issues.push({
      severity: 'error',
      code: 'empty-point',
      field: shot.id,
      message: `${shot.label} 没有关联任何待检部位`,
      fix: '为该检查点补上目标部件,或把它删除',
    })
  }

  // ③ 路线是否完整:巡航高度必须越过最高的塔头
  const highestTop = line.towers.reduce((top, tower) => Math.max(top, towerTop(tower)), 0)
  if (route.shots.length > 0 && route.cruiseAltitudeM < highestTop + CRUISE_CLEARANCE_M) {
    issues.push({
      severity: 'error',
      code: 'cruise-too-low',
      field: '巡航线.cruiseAltitudeM',
      message: `转场高度 ${route.cruiseAltitudeM} m,低于最高塔头 ${round1(highestTop)} m + 净空 ${CRUISE_CLEARANCE_M} m`,
      fix: `把转场高度提到 ${round1(highestTop + CRUISE_CLEARANCE_M)} m 以上`,
    })
  }
  if (input.maxAltitudeM !== undefined && route.cruiseAltitudeM > input.maxAltitudeM) {
    issues.push({
      severity: 'error',
      code: 'cruise-over-limit',
      field: '巡航线.cruiseAltitudeM',
      message: `转场高度 ${route.cruiseAltitudeM} m 超过机型限高 ${input.maxAltitudeM} m`,
      fix: '降低转场高度,或换用限高更高的机型',
    })
  }

  // ④ 起降点是否设置(§3.2 明确要求)
  const home = input.home === undefined ? route.home : input.home
  if (!home) {
    issues.push({
      severity: 'error',
      code: 'no-home',
      field: '巡航线.home',
      message: '尚未设置起飞点',
      fix: '在场景里指定一块起降场地作为起飞点',
    })
  } else {
    let nearest = Number.POSITIVE_INFINITY
    let nearestLabel = ''
    for (const tower of line.towers) {
      const distance = Math.hypot(home.x - tower.x, home.z - tower.z)
      if (distance < nearest) {
        nearest = distance
        nearestLabel = tower.label
      }
    }
    if (Number.isFinite(nearest) && nearest < MIN_LAUNCH_CLEARANCE_M) {
      issues.push({
        severity: 'warning',
        code: 'home-too-close',
        field: '巡航线.home',
        message: `起飞点离 ${nearestLabel} 只有 ${round1(nearest)} m(建议 ≥ ${MIN_LAUNCH_CLEARANCE_M} m)`,
        fix: '把起降点往线路外侧挪一挪,避免起降时刮到杆塔',
      })
    }
  }

  // ⑤ 采集配置是否满足要求
  if (route.lensZoom <= 0 || route.lensZoom > MAX_LENS_ZOOM) {
    issues.push({
      severity: 'error',
      code: 'bad-lens-zoom',
      field: '作业方案.lensZoom',
      message: `镜头倍率 ${route.lensZoom}× 超出相机可实现范围(0, ${MAX_LENS_ZOOM}]`,
      fix: `把镜头倍率调回 0~${MAX_LENS_ZOOM}× 之间`,
    })
  }
  if (route.dwellSeconds < MIN_DWELL_SECONDS) {
    issues.push({
      severity: 'error',
      code: 'dwell-too-short',
      field: '作业方案.dwellSeconds',
      message: `单拍点采集时长 ${route.dwellSeconds} s 过短`,
      fix: `把采集时长提到 ${MIN_DWELL_SECONDS} s 以上,否则画面抖一下这拍就废了`,
    })
  }
  for (const shot of route.shots) {
    const requirement = shot.requirement
    if (requirement.captureCount < 1) {
      issues.push({
        severity: 'error',
        code: 'bad-capture-count',
        field: shot.id,
        message: `${shot.label} 要求的采集数量是 ${requirement.captureCount} 张`,
        fix: '把该检查点的采集数量设为至少 1 张,否则它永远无法通过',
      })
    }
    const [minRange, maxRange] = requirement.distanceRangeM
    if (!(minRange > 0) || !(maxRange > minRange)) {
      issues.push({
        severity: 'error',
        code: 'bad-distance-range',
        field: shot.id,
        message: `${shot.label} 的拍摄距离区间 ${minRange}~${maxRange} m 不合法`,
        fix: '把距离区间的下限设为正数,且小于上限',
      })
    }
  }

  // ⑥ 禁用的检查点:放行,但必须让用户知道代价
  const disabled = route.shots.filter((shot) => !shot.enabled)
  if (disabled.length > 0) {
    const reachable = route.shots.length - disabled.length
    const best = route.shots.length === 0 ? 0 : Math.round((reachable / route.shots.length) * 100)
    issues.push({
      severity: 'warning',
      code: 'points-disabled',
      field: '检查点清单',
      message: `已禁用 ${disabled.length} 个检查点(${disabled.map((shot) => shot.id).join('、')}),最高覆盖率只能到 ${best}%`,
      fix: '确认这是有意的;否则重新启用这些检查点',
    })
  }

  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
}

/** 校验是否允许开跑(§5.3:只有通过校验的任务才能进入 Ready) */
export function canRunMission(issues: ReadonlyArray<MissionIssue>): boolean {
  return !issues.some((issue) => issue.severity === 'error')
}
