/**
 * 输电线路 —— 一段走廊 + 它下面的杆塔序列,以及平台默认的那条线(§39)。
 *
 * 这份数据的定位很明确:**它是资产台账,不是场景数据,也不是检测结果**。
 *   杆塔坐标 / 横担层高 / 挂点位置 —— 资产的客观几何,巡检航线由它推导出来;
 *   `defects` —— 资产上真实存在的缺陷(地面真值),见 `power-tower.ts`。
 *
 * 因此本包只依赖 `contracts`:线路台账不认识 Sandbox、不认识 Task、更不认识渲染。
 * 「把台账变成场景障碍物」是装配层的事(`grid-scenario.ts`),不在这里。
 */
import { headingToVector } from '@simulation/contracts'
import type { PartDefect, PowerTower } from './power-tower'
import type { TowerType } from './power-asset-type'

/** 一条输电线路(一段直线走廊;真实线路的转角、跨越留待后续扩展) */
export interface PowerLine {
  readonly id: string
  readonly label: string
  readonly voltageKv: number
  /** 线路走向(罗盘方位角,度):杆塔编号增大方向 */
  readonly bearingDeg: number
  readonly towers: ReadonlyArray<PowerTower>
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
export function gridInspectionLine(): PowerLine {
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
