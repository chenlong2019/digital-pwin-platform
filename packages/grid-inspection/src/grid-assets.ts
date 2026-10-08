/**
 * 输电线路资产模型 —— 电网巡检要看的「世界」。
 *
 * 这份数据的定位很明确:**它是资产台账,不是场景数据,也不是检测结果**。
 *   · 杆塔坐标 / 横担层高 / 挂点位置 —— 资产的客观几何,巡检航线由它推导出来;
 *   · `defects` —— 资产上**真实存在**的缺陷(地面真值)。
 *
 * 真值单独放一层,是这个功能能自证的前提:巡检报告里的「发现缺陷」必须能和
 * 「真的有什么」对账,否则「准确率」只是自己说自己。检测器(见 defect-detector.ts)
 * 只读资产、不写资产,产出的判定与真值对比后才有 `漏检 / 误检` 这些指标。
 *
 * 坐标系沿用平台唯一约定:+X 东、+Y 上、−Z 北;航向 0° = 北、顺时针增加。
 * 因此「沿线路方向」是 `headingToVector(bearingDeg)`,「线路侧」再加 90°。
 *
 * ⚠️ 本文件是**几何与台账**,不引用 vue / three / 渲染层,也不做任何 I/O。
 */
import type { Vec3 } from '@simulation/contracts'
import { headingToVector } from '@simulation/contracts'

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

/** 资产上真实存在的一条缺陷(地面真值) */
export interface PartDefect {
  /** 对应的检查部位 id —— 见 `InspectionPart.id` */
  readonly partId: string
  readonly kind: DefectKind
  readonly severity: DefectSeverity
  /** 现场备注,进报告 */
  readonly note?: string
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

// ————————————————————————————— 杆塔 —————————————————————————————

export type TowerType = 'suspension' | 'tension' | 'terminal'

export const TOWER_TYPE_LABELS: Record<TowerType, string> = {
  suspension: '直线塔',
  tension: '耐张塔',
  terminal: '终端塔',
}

export interface TowerAsset {
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

/** 一条输电线路(一段直线走廊;真实线路的转角、跨越留待后续扩展) */
export interface GridLine {
  readonly id: string
  readonly label: string
  readonly voltageKv: number
  /** 线路走向(罗盘方位角,度):杆塔编号增大方向 */
  readonly bearingDeg: number
  readonly towers: ReadonlyArray<TowerAsset>
}

// ————————————————————————————— 默认线路 —————————————————————————————

/**
 * 塔距 42 米、首塔距原点 40 米。
 *
 * ⚠️ 这是**刻意压缩**的:真实 220 kV 线路档距 300 米以上,按真值摆放,一次六塔巡检
 * 要飞两公里、仿真里几十分钟。当前沙盒要验证的是作业流程与判定链(规划 → 逐塔对准 →
 * 采集 → 判定 → 报告),所以保持「塔距 ≫ 横担半宽 ≫ 绝缘子串长」这个相对关系,
 * 把绝对尺度压到一屏看得见。改回真值只需要动这两个常数,其余代码一行不改。
 */
const TOWER_SPACING_M = 42
/** 首塔相对原点的偏移(米):给出一个不在塔位上的起飞场地 */
const TOWER_START_OFFSET_M = -40

interface TowerSeed {
  readonly id: string
  readonly type: TowerType
  readonly bodyHeightM: number
  readonly armLevelsM: ReadonlyArray<number>
  readonly armHalfSpanM: number
  readonly defects: ReadonlyArray<PartDefect>
}

/**
 * 六基塔的线路 —— 三条缺陷分三种性质铺开,好让报告里的召回/精度指标有意义:
 *   · T02 上层绝缘子破损(major,小部件、近距离)→ 成像质量不足时最容易漏
 *   · T04 塔身锈蚀(minor,大部件、远距离)→ 同样远,但特征大,反而容易看到
 *   · T05 基础沉陷(major,俯视)→ 与 T02 同样严重,命中概率不同
 * 另外 T03 塔头挂了个异物(minor)—— 位置刁钻,用来观察「误检」的影响。
 */
const TOWER_SEEDS: ReadonlyArray<TowerSeed> = [
  {
    id: 'T01',
    type: 'terminal',
    bodyHeightM: 15,
    armLevelsM: [13, 17.5],
    armHalfSpanM: 5.2,
    defects: [],
  },
  {
    id: 'T02',
    type: 'suspension',
    bodyHeightM: 14,
    armLevelsM: [12.5, 17],
    armHalfSpanM: 5.5,
    defects: [
      { partId: 'ins-1-a', kind: 'insulatorBroken', severity: 'major', note: '上层横担左侧绝缘子串第 3 片破损' },
    ],
  },
  {
    id: 'T03',
    type: 'suspension',
    bodyHeightM: 14.5,
    armLevelsM: [13, 17.5],
    armHalfSpanM: 5.5,
    defects: [{ partId: 'towerHead', kind: 'foreignObject', severity: 'minor', note: '塔头挂有异物' }],
  },
  {
    id: 'T04',
    type: 'tension',
    bodyHeightM: 16,
    armLevelsM: [14, 19],
    armHalfSpanM: 6.4,
    defects: [{ partId: 'towerBody', kind: 'towerRust', severity: 'minor', note: '塔身下部塔材锈蚀' }],
  },
  {
    id: 'T05',
    type: 'suspension',
    bodyHeightM: 14,
    armLevelsM: [12.5, 17],
    armHalfSpanM: 5.5,
    defects: [
      { partId: 'foundation', kind: 'foundationSettlement', severity: 'major', note: '塔基护坡塌陷' },
    ],
  },
  {
    id: 'T06',
    type: 'terminal',
    bodyHeightM: 15.5,
    armLevelsM: [13.5, 18],
    armHalfSpanM: 5.2,
    defects: [],
  },
]

/** 平台默认的巡检线路:六基塔、220 kV、南北向 */
export function gridInspectionLine(): GridLine {
  const bearingDeg = 0
  const along = headingToVector(bearingDeg)
  const towers = TOWER_SEEDS.map((seed, index) => {
    const offset = TOWER_START_OFFSET_M + index * TOWER_SPACING_M
    return {
      ...seed,
      label: `${index + 1} 号塔`,
      x: along.x * offset,
      z: along.z * offset,
    }
  })
  return {
    id: 'line-220k-西岭线',
    label: '220 kV 西岭线 · 1–6 号塔',
    voltageKv: 220,
    bearingDeg,
    towers,
  }
}

// ————————————————————————————— 部位推导 —————————————————————————————

/** 绝缘子串长度(米):挂点到导线中心的竖直距离 */
const INSULATOR_STRING_M = 1.3
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
export function deriveInspectionParts(tower: TowerAsset, line: GridLine): InspectionPart[] {
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

/** 部位 id → 该部位的真实缺陷;没有则 null */
export function truthFor(tower: TowerAsset, partId: string): PartDefect | null {
  return tower.defects.find((defect) => defect.partId === partId) ?? null
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
export function conductorSpans(line: GridLine): ConductorSpan[] {
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
