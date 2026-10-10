/**
 * 巡检航线规划 —— 把「资产几何」变成「可执行的拍摄序列」。
 *
 * 这是 README §11 里那个一直缺位的 **Route**:`AgentTrack` 是「飞过哪」(记录器采的),
 * `Route` 是「计划怎么飞」(任务要执行的)。两者的区别在这里第一次有了实体:
 * 航线由杆塔台账推导,与任何一次实际飞行无关 —— 换个飞手、换台机器,航线是同一条;
 * 而轨迹每次都不同。
 *
 * 规划只做三件事,不掺任何控制律:
 *   ① 按拍摄配方把部位**分组**成拍点(同一方向同一距离的部位共用一次悬停)
 *   ② 把拍点算成世界坐标(悬停位 + 对准位 + 期望航向)
 *   ③ 估算转场里程与采集时长,给任务和界面一个可显示、可断言的规模
 *
 * 于是「一基塔几个拍点」是可以推演、可以单测的量,而不是飞完才知道。
 */
import type { Vec3 } from '@simulation/contracts'
import { distance3, headingToVector } from '@simulation/contracts'
import type { PowerLine, InspectionPart, PartKind, PowerTower } from '@simulation/power-domain'
import { PART_KIND_LABELS, deriveInspectionParts } from '@simulation/power-domain'

/** 悬停点相对目标部位抬高的余量(米):略高一点、带个俯角,画面更像巡检实拍 */
const HOVER_RISE_M = 1.5
/** 全航线统一的镜头倍率 —— 检测器的成像质量模型必须用同一个值,否则报告对不上账 */
export const DEFAULT_LENS_ZOOM = 2
export const DEFAULT_DWELL_SECONDS = 2.4
/** 爬升段高度(米):要高于最高的塔头,否则转场会撞塔 */
export const DEFAULT_CRUISE_ALTITUDE_M = 32

/**
 * 检查点的**有效条件**(产品规格 §5.1)。
 *
 * 一个检查点不能只因为无人机路过附近就算成功 —— 到达、距离、航向、云台、
 * 采集数量、证据关联,每一项都要能**独立解释失败原因**。所以这四个阈值不写死在
 * 评价侧,而是随航线一起定下来:评价侧逐条对照,报告里就是六条可读的检查行。
 */
export interface InspectionRequirement {
  /** 期望拍摄距离范围(米):[下限, 上限] */
  readonly distanceRangeM: readonly [number, number]
  /** 机身航向容差(度) */
  readonly headingToleranceDeg: number
  /** 云台/光轴偏心容差(度) */
  readonly gimbalToleranceDeg: number
  /** 所需采集证据数量(张) */
  readonly captureCount: number
}

/** 距离余量(米):悬停保持本身就有 ±1.5 m 的容差,再留一点测量余量 */
const DISTANCE_TOLERANCE_M = 2.5
/** 航向容差(度):比任务的对准判定(默认 8°)略松,留出悬停期间的漂移 */
const HEADING_TOLERANCE_DEG = 10
/**
 * 云台偏心容差(度)。
 *
 * 取 25° 而不是更小的值,是因为**一个拍点要同时拍下同侧的一组部位**:相机对准的是
 * 这组部位的质心,组内离质心最远的那个部位天然就有十几度的偏心。取太紧会把
 * 「正常的一站多拍」判成失败,那就不是校验而是噪声。广角端半视场约 41°,
 * 25° 仍在画面内,所以这个数既真实又留了余量。
 */
const GIMBAL_TOLERANCE_DEG = 25

/** 航线里的一个部位(已带塔号前缀的全局 id) */
export interface RoutePart {
  /** 全局唯一:`<塔号>/<部位 id>`,例如 `T02/ins-1-a` */
  readonly id: string
  /** 塔内唯一的部位 id(资产真值按它写) */
  readonly partId: string
  readonly towerId: string
  readonly towerLabel: string
  readonly label: string
  readonly kind: PartKind
  /** 世界系对准点 */
  readonly target: Vec3
  readonly criticalSizeM: number
}

/** 一个拍点:一次悬停 + 一次采集,可能同时覆盖多个部位 */
export interface RouteShot {
  readonly id: string
  readonly towerId: string
  readonly towerLabel: string
  readonly label: string
  readonly parts: ReadonlyArray<RoutePart>
  /** 悬停拍点(世界系;地面为 0,所以 y 就是相对地面高度) */
  readonly hover: Vec3
  /** 载荷对准点(本拍点各部位目标的质心) */
  readonly aim: Vec3
  /** 期望航向(罗盘,度):从悬停位看向杆塔 */
  readonly headingDeg: number
  /** 本检查点的有效条件(§5.1) */
  readonly requirement: InspectionRequirement
  /**
   * 是否执行。禁用的检查点**仍然留在 `parts` 里** —— 它没拍,所以覆盖率必须
   * 小于 100%。把禁用的点从航线里删掉,报告就会把「少拍了一处」显示成「全覆盖」。
   */
  readonly enabled: boolean
}

export interface InspectionRoute {
  readonly id: string
  readonly label: string
  readonly line: PowerLine
  /** 起飞点(世界系) */
  readonly home: Vec3
  readonly shots: ReadonlyArray<RouteShot>
  readonly parts: ReadonlyArray<RoutePart>
  /** 全航线统一镜头倍率 */
  readonly lensZoom: number
  /** 单拍点悬停采集时长(秒) */
  readonly dwellSeconds: number
  /** 爬升段高度(米) */
  readonly cruiseAltitudeM: number
  /** 转场里程(米):home → 各拍点依次相连的折线长度 */
  readonly transitLengthM: number
}

export interface PlanRouteOptions {
  /** 镜头倍率,默认 2× */
  readonly lensZoom?: number
  /** 单拍点采集时长(秒),默认 2.4 */
  readonly dwellSeconds?: number
  /** 爬升段高度(米),默认 32 */
  readonly cruiseAltitudeM?: number
  /** 起飞点,默认世界原点 */
  readonly home?: Vec3
  /**
   * 被禁用的检查点 id(产品规格 §3.2:允许启用、禁用、排序、删除巡检点)。
   * 被禁用的点仍在航线与部位清单里,只是不飞、不采集。
   */
  readonly disabledShotIds?: ReadonlyArray<string>
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 拍点分组键:同一方位、同一距离的部位共用一次悬停 */
function viewKey(part: InspectionPart): string {
  return `${Math.round(part.viewAzimuthDeg)}|${Math.round(part.viewDistanceM)}`
}

/**
 * 规划整条线路的巡检航线。
 *
 * 分组用「首次出现顺序」而不是排序:部位清单本身的顺序就是现场作业顺序
 * (塔头 → 上层横担/绝缘子 → 下层 → 塔身 → 塔基),重排一次反而要额外解释。
 */
export function planInspectionRoute(line: PowerLine, options: PlanRouteOptions = {}): InspectionRoute {
  const home = options.home ?? { x: 0, y: 0, z: 0 }
  const disabled = new Set(options.disabledShotIds ?? [])
  const shots: RouteShot[] = []
  const allParts: RoutePart[] = []

  for (const tower of line.towers) {
    const groups = groupParts(tower, line)

    let shotIndex = 0
    for (const group of groups) {
      shotIndex += 1
      const parts: RoutePart[] = group.map((part) => ({
        id: `${tower.id}/${part.id}`,
        partId: part.id,
        towerId: tower.id,
        towerLabel: tower.label,
        label: part.label,
        kind: part.kind,
        target: part.target,
        criticalSizeM: part.criticalSizeM,
      }))
      allParts.push(...parts)

      const aim = centroid(parts.map((part) => part.target))
      const recipe = group[0]
      if (!recipe) continue
      const shotId = `${tower.id}/S${shotIndex}`
      const direction = headingToVector(line.bearingDeg + recipe.viewAzimuthDeg)
      const hover: Vec3 = {
        x: round2(tower.x + direction.x * recipe.viewDistanceM),
        y: round2(Math.max(...parts.map((part) => part.target.y)) + HOVER_RISE_M),
        z: round2(tower.z + direction.z * recipe.viewDistanceM),
      }
      shots.push({
        id: shotId,
        towerId: tower.id,
        towerLabel: tower.label,
        label: `${tower.label} · ${describeShot(parts, recipe.viewAzimuthDeg, recipe.viewDistanceM)}`,
        parts,
        hover,
        aim,
        // 从悬停位看向杆塔的方向:悬停点由方位角定义,期望航向就是它的反向
        headingDeg: round2((line.bearingDeg + recipe.viewAzimuthDeg + 180) % 360),
        // 有效条件按这一拍的**实际计划几何**现算 —— 悬停位到每个部位的真实距离
        // 才是「该保持在哪」的判据;用配方的名义距离会把同拍点里离塔轴远的部位误判
        requirement: requirementFor(parts, hover),
        enabled: !disabled.has(shotId),
      })
    }
  }

  return {
    id: `route-${line.id}`,
    label: `${line.label} 巡检航线`,
    line,
    home,
    shots,
    parts: allParts,
    lensZoom: options.lensZoom ?? DEFAULT_LENS_ZOOM,
    dwellSeconds: options.dwellSeconds ?? DEFAULT_DWELL_SECONDS,
    cruiseAltitudeM: options.cruiseAltitudeM ?? DEFAULT_CRUISE_ALTITUDE_M,
    // 禁用的检查点不会被飞到,所以不算进预估里程
    transitLengthM: round2(transitLength(home, shots.filter((shot) => shot.enabled))),
  }
}

/**
 * 由这一拍的实际几何生成有效条件(§5.1)。
 *
 * 距离区间取「悬停位到组内各部位的实际距离」再上下放宽 —— 组内部位离悬停位
 * 本来就有远近之差(横担比塔头远几米),一条窄区间会把正常的一站多拍判成失败。
 * 判的是「有没有保持在计划机位」,不是「部位是不是刚好在配方距离上」。
 */
export function requirementFor(parts: ReadonlyArray<RoutePart>, hover: Vec3): InspectionRequirement {
  const ranges = parts.map((part) => distance3(hover, part.target))
  const min = ranges.length > 0 ? Math.min(...ranges) : 0
  const max = ranges.length > 0 ? Math.max(...ranges) : 0
  return {
    distanceRangeM: [
      round2(Math.max(0, min - DISTANCE_TOLERANCE_M)),
      round2(max + DISTANCE_TOLERANCE_M),
    ],
    headingToleranceDeg: HEADING_TOLERANCE_DEG,
    gimbalToleranceDeg: GIMBAL_TOLERANCE_DEG,
    captureCount: 1,
  }
}

/** 按拍摄配方分组,保持首次出现顺序 */
function groupParts(tower: PowerTower, line: PowerLine): InspectionPart[][] {
  const groups = new Map<string, InspectionPart[]>()
  for (const part of deriveInspectionParts(tower, line)) {
    const key = viewKey(part)
    const bucket = groups.get(key)
    if (bucket) bucket.push(part)
    else groups.set(key, [part])
  }
  return [...groups.values()]
}

function centroid(points: ReadonlyArray<Vec3>): Vec3 {
  if (points.length === 0) return { x: 0, y: 0, z: 0 }
  let x = 0
  let y = 0
  let z = 0
  for (const point of points) {
    x += point.x
    y += point.y
    z += point.z
  }
  return { x: round2(x / points.length), y: round2(y / points.length), z: round2(z / points.length) }
}

/** 拍点标签:把「拍什么」和「从哪拍」写在一行里,日志与报告都用它 */
function describeShot(parts: ReadonlyArray<RoutePart>, azimuthDeg: number, distanceM: number): string {
  const kinds = [...new Set(parts.map((part) => part.kind))]
  const what = kinds.map((kind) => PART_KIND_LABELS[kind]).join(' + ')
  return `${what}(${AZIMUTH_LABELS[normalizeAzimuth(azimuthDeg)]} ${distanceM} m)`
}

/** 方位角 → 现场说法 */
function normalizeAzimuth(azimuthDeg: number): 0 | 90 | 180 | 270 {
  const value = ((Math.round(azimuthDeg) % 360) + 360) % 360
  if (value < 45 || value >= 315) return 0
  if (value < 135) return 90
  if (value < 225) return 180
  return 270
}

const AZIMUTH_LABELS: Record<0 | 90 | 180 | 270, string> = {
  0: '大号侧顺线',
  90: '线路右侧',
  180: '小号侧顺线',
  270: '线路左侧',
}

/** 折线里程:home → 各拍点 */
function transitLength(home: Vec3, shots: ReadonlyArray<RouteShot>): number {
  let total = 0
  let previous = home
  for (const shot of shots) {
    total += Math.hypot(shot.hover.x - previous.x, shot.hover.z - previous.z)
    previous = shot.hover
  }
  return total
}
