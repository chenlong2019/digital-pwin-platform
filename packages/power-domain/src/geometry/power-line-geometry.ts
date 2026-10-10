/**
 * 线路几何 —— 由台账**推导**出来的两类量:检查部位 与 导线段(§37 `geometry/`)。
 *
 * 它们都是纯函数,所以「同一基塔永远推出一模一样的部位清单」是可断言的:
 * 报告里的「总部位数」因此可复现,覆盖率也才有意义。部位 id 稳定(不依赖数组
 * 下标顺序之外的任何东西),所以资产台账里的真值可以直接按 id 写。
 *
 * 几何只吃台账,不认识 Sandbox 也不认识渲染:换 Cesium 时这一段一字不改。
 */
import type { Vec3 } from '@simulation/contracts'
import { headingToVector } from '@simulation/contracts'
import { INSULATOR_STRING_M } from '../insulator'
import type { PartKind } from '../power-asset-type'
import type { PowerLine } from '../power-line'
import type { PowerTower } from '../power-tower'

// ————————————————————————————— 检查部位 —————————————————————————————

/**
 * 检查部位 —— **由杆塔几何推导**出来的拍摄对象(不是手写的清单)。
 *
 * `criticalSizeM` 是「要看清的最小特征尺寸」:绝缘子破一小片就得贴近或长焦,
 * 而塔基护坡的面积性缺陷从远处就能看出来。检测器用它把「距离 + 变焦」换算成
 * 成像质量,所以这个数直接决定该部位最多能隔多远拍 —— 摆在这儿,不埋在检测器里。
 *
 * `view*` 三项是**拍摄配方**:从塔的哪个方向、多远去拍。航线规划据此组拍点。
 */
export interface InspectionPart {
  readonly id: string
  readonly label: string
  readonly kind: PartKind
  /** 云台要对准的点(世界系) */
  readonly target: Vec3
  /**
   * 拍摄方位:相对线路走向的偏移角(度)。
   * 0 = 从大号侧顺线看,180 = 从小号侧顺线看,90 / 270 = 从线路两侧正对。
   */
  readonly viewAzimuthDeg: number
  /** 拍摄距离(米) */
  readonly viewDistanceM: number
  /** 该部位要看清的最小特征尺寸(米) */
  readonly criticalSizeM: number
}

/**
 * 各部位的拍摄配方。
 *
 * 每一行都是一句可读的现场经验:「抬头从线路侧 18 米看塔头与两侧横担」、
 * 「顺线 14 米看上层绝缘子」。航线规划只做分组与几何,不替这里做决定。
 */
const VIEW_RECIPES: Record<PartKind, { azimuthDeg: number; distanceM: number; criticalSizeM: number }> = {
  // 塔头与横担:线路侧正对,一站看全塔头 + 两侧横担
  towerHead: { azimuthDeg: 90, distanceM: 18, criticalSizeM: 0.35 },
  arm: { azimuthDeg: 90, distanceM: 18, criticalSizeM: 0.3 },
  // 绝缘子:顺线看。上、下两层从相反的两侧看,避免相互遮挡
  insulator: { azimuthDeg: 0, distanceM: 14, criticalSizeM: 0.12 },
  // 塔身与塔基:另一侧线路侧,稍远一点带俯角
  towerBody: { azimuthDeg: 270, distanceM: 14, criticalSizeM: 0.4 },
  foundation: { azimuthDeg: 270, distanceM: 14, criticalSizeM: 0.6 },
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 由杆塔几何推导全部检查部位。
 *
 * 纯函数:同一基塔永远推出一模一样的部位清单 —— 报告里的「总部位数」因此可复现,
 * 覆盖率也才有意义。部位 id 稳定(不依赖数组下标顺序之外的任何东西),
 * 所以资产台账里的真值可以直接按 id 写。
 */
export function deriveInspectionParts(tower: PowerTower, line: PowerLine): InspectionPart[] {
  const side = headingToVector(line.bearingDeg + 90)
  const parts: InspectionPart[] = []

  const push = (id: string, label: string, kind: PartKind, target: Vec3, azimuthOverride?: number): void => {
    const recipe = VIEW_RECIPES[kind]
    parts.push({
      id,
      label,
      kind,
      target: { x: round2(target.x), y: round2(target.y), z: round2(target.z) },
      viewAzimuthDeg: azimuthOverride ?? recipe.azimuthDeg,
      viewDistanceM: recipe.distanceM,
      criticalSizeM: recipe.criticalSizeM,
    })
  }

  const levels = tower.armLevelsM
  const topLevel = levels[levels.length - 1] ?? tower.bodyHeightM

  // 塔头:最高的横担再往上一点
  push('towerHead', '塔头', 'towerHead', { x: tower.x, y: topLevel + 1.2, z: tower.z })

  levels.forEach((level, index) => {
    const order = index + 1
    // 横担:塔中心两侧各一段,取半宽的 55% 处作为观察点(避开塔身遮挡)
    for (const sign of [1, -1] as const) {
      const tag = sign > 0 ? 'b' : 'a'
      push(
        `arm-${order}-${tag}`,
        `第 ${order} 层横担${sign > 0 ? '右' : '左'}侧`,
        'arm',
        {
          x: tower.x + side.x * tower.armHalfSpanM * 0.55 * sign,
          y: level,
          z: tower.z + side.z * tower.armHalfSpanM * 0.55 * sign,
        },
      )
      // 绝缘子串:挂在横担端部,竖直向下,对准串的中部
      push(
        `ins-${order}-${tag}`,
        `第 ${order} 层横担${sign > 0 ? '右' : '左'}侧绝缘子串`,
        'insulator',
        {
          x: tower.x + side.x * tower.armHalfSpanM * sign,
          y: level - INSULATOR_STRING_M / 2,
          z: tower.z + side.z * tower.armHalfSpanM * sign,
        },
        // 上层从大号侧看、下层从小号侧看:同一侧看两层会互相遮挡
        order % 2 === 1 ? 0 : 180,
      )
    }
  })

  push('towerBody', '塔身', 'towerBody', { x: tower.x, y: tower.bodyHeightM * 0.55, z: tower.z })
  push('foundation', '塔基', 'foundation', { x: tower.x, y: 0.35, z: tower.z })

  return parts
}

// ————————————————————————————— 导线段 —————————————————————————————

/**
 * 一段导线(相邻两基塔之间,同一横担层同一侧)。
 *
 * 只给两端挂点与弧垂 —— 悬链线怎么采样是**画法**,由渲染侧决定(`SceneWire`)。
 * 这与障碍物一致:资产数据与可视化分开,换 Cesium 时这段数据一字不改。
 */
export interface ConductorSpan {
  readonly id: string
  readonly label: string
  /** 横担层序号(1 起) */
  readonly levelIndex: number
  /** 挂点侧:靠近编号增大方向的塔为 'a' */
  readonly side: 'a' | 'b'
  readonly from: Vec3
  readonly to: Vec3
  /** 弧垂(米):两端等高时线中点下垂的距离 */
  readonly sagM: number
}

/** 弧垂取档距的 3.5% —— 220 kV 常规档距的量级,可视化足够 */
const SAG_RATIO = 0.035

/** 由线路导出全部导线段(相邻塔同层同侧相连) */
export function conductorSpans(line: PowerLine): ConductorSpan[] {
  const side = headingToVector(line.bearingDeg + 90)
  const spans: ConductorSpan[] = []

  for (let index = 0; index < line.towers.length - 1; index += 1) {
    const from = line.towers[index]
    const to = line.towers[index + 1]
    if (!from || !to) continue
    const levelCount = Math.min(from.armLevelsM.length, to.armLevelsM.length)

    for (let level = 0; level < levelCount; level += 1) {
      const fromLevel = from.armLevelsM[level]
      const toLevel = to.armLevelsM[level]
      if (fromLevel === undefined || toLevel === undefined) continue

      for (const sign of [1, -1] as const) {
        const tag: 'a' | 'b' = sign > 0 ? 'a' : 'b'
        const fromPoint: Vec3 = {
          x: from.x + side.x * from.armHalfSpanM * sign,
          y: fromLevel - INSULATOR_STRING_M,
          z: from.z + side.z * from.armHalfSpanM * sign,
        }
        const toPoint: Vec3 = {
          x: to.x + side.x * to.armHalfSpanM * sign,
          y: toLevel - INSULATOR_STRING_M,
          z: to.z + side.z * to.armHalfSpanM * sign,
        }
        const span = Math.hypot(toPoint.x - fromPoint.x, toPoint.z - fromPoint.z)
        spans.push({
          id: `${from.id}-${to.id}-L${level + 1}-${tag}`,
          label: `${from.label}—${to.label} 第 ${level + 1} 层${sign > 0 ? '右' : '左'}侧导线`,
          levelIndex: level + 1,
          side: tag,
          from: fromPoint,
          to: toPoint,
          sagM: round2(span * SAG_RATIO),
        })
      }
    }
  }
  return spans
}
