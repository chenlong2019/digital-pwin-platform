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
import { headingToVector } from '@simulation/contracts'
import type { GridLine, InspectionPart, PartKind, TowerAsset } from './grid-assets'
import { PART_KIND_LABELS, deriveInspectionParts } from './grid-assets'

/** 悬停点相对目标部位抬高的余量(米):略高一点、带个俯角,画面更像巡检实拍 */
const HOVER_RISE_M = 1.5
/** 全航线统一的镜头倍率 —— 检测器的成像质量模型必须用同一个值,否则报告对不上账 */
export const DEFAULT_LENS_ZOOM = 2
export const DEFAULT_DWELL_SECONDS = 2.4
/** 爬升段高度(米):要高于最高的塔头,否则转场会撞塔 */
export const DEFAULT_CRUISE_ALTITUDE_M = 32

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
}

export interface InspectionRoute {
  readonly id: string
  readonly label: string
  readonly line: GridLine
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
export function planInspectionRoute(line: GridLine, options: PlanRouteOptions = {}): InspectionRoute {
  const home = options.home ?? { x: 0, y: 0, z: 0 }
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
      const direction = headingToVector(line.bearingDeg + recipe.viewAzimuthDeg)
      const hover: Vec3 = {
        x: round2(tower.x + direction.x * recipe.viewDistanceM),
        y: round2(Math.max(...parts.map((part) => part.target.y)) + HOVER_RISE_M),
        z: round2(tower.z + direction.z * recipe.viewDistanceM),
      }
      shots.push({
        id: `${tower.id}/S${shotIndex}`,
        towerId: tower.id,
        towerLabel: tower.label,
        label: `${tower.label} · ${describeShot(parts, recipe.viewAzimuthDeg, recipe.viewDistanceM)}`,
        parts,
        hover,
        aim,
        // 从悬停位看向杆塔的方向:悬停点由方位角定义,期望航向就是它的反向
        headingDeg: round2((line.bearingDeg + recipe.viewAzimuthDeg + 180) % 360),
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
    transitLengthM: round2(transitLength(home, shots)),
  }
}

/** 按拍摄配方分组,保持首次出现顺序 */
function groupParts(tower: TowerAsset, line: GridLine): InspectionPart[][] {
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
