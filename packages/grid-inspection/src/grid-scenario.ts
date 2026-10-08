/**
 * 电网巡检场景 —— 把线路台账变成沙盒里的世界(README §7:Scenario --load--> Sandbox)。
 *
 * 这一层只做**一件事**:资产几何 → 障碍物定义。不做渲染映射(那是应用层的
 * `scene-mapping`)、不做航线规划(那是 `inspection-route`)。所以同一份线路台账
 * 既能喂给 Sandbox 做避障判定,也能喂给渲染层画出来,而两边用的是同一批坐标。
 *
 * 杆塔被拆成**塔身 + 塔头 + 各层横担**三类实体障碍物,理由很实际:
 * 一个包住整个塔的方盒会把横担外的空气也变成禁区,无人机在塔边悬停时会被
 * 避障逻辑反复推开 —— 那样拍到的画面永远在抖。拆成薄片之后,只有真正的
 * 构件是实体,悬停点位都落在可飞空间里。
 *
 * ⚠️ `ObstacleDefinition` 只有轴对齐盒(AABB),所以横担只在**线路走向与坐标轴
 * 平行**时生成;斜向线路会退化成省略横担(见 `armAxis`)。这是当前平台的已知边界,
 * 不是这里的取舍 —— 要支持斜向走廊得给 Sandbox 加旋转盒,属于契约层的扩展。
 */
import type { ObstacleDefinition, Scenario } from '@simulation/sandbox-core'
import type { GridLine, TowerAsset } from './grid-assets'
import { gridInspectionLine } from './grid-assets'

/** 塔身根开(米):方形塔腿的外接尺寸 */
const TOWER_BODY_WIDTH_M = 3.4
/** 塔头尺寸(米) */
const TOWER_HEAD_WIDTH_M = 2.4
/** 横担盒的厚度与高度(米):薄片,只挡住构件本身 */
const ARM_THICKNESS_M = 0.7
const ARM_HEIGHT_M = 0.6
/** 塔头相对最高横担的抬升(米) */
const TOWER_HEAD_RISE_M = 1.6
/** 最低横担以下算塔身 */
const TOWER_BODY_TOP_EXTRA_M = 0.6

/**
 * 起飞场地 —— 线路侧后方的一片空地。
 *
 * 单列出来是因为它必须**同时**被场景(agent 出生点)与航线(home)使用:
 * 两处写两个数就会让「转场里程」从一开始就偏掉。
 */
export interface LaunchSite {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly headingDeg: number
}

export function gridLaunchSite(): LaunchSite {
  // 线路中心线在 x = 0,首塔在原点以南 40 米;起飞场地放在东侧 34 米、再往南 30 米 ——
  // 距最近塔 45 米,起降不会刮到杆塔,也与任何拍点保持 30 米以上
  return { x: 34, y: 0, z: 70, headingDeg: 180 }
}

/** 塔的全高(米):最高横担再往上一个塔头 */
export function towerTopAltitudeM(tower: TowerAsset): number {
  const levels = tower.armLevelsM
  const top = levels[levels.length - 1] ?? tower.bodyHeightM
  return top + TOWER_HEAD_RISE_M
}

/**
 * 横担的展开轴。
 *
 * 横担垂直于线路走向,所以线路南北向 → 横担沿 x;线路东西向 → 横担沿 z;
 * 斜向返回 null(退化为省略横担)。见文件头的已知边界说明。
 */
function armAxis(line: GridLine): 'x' | 'z' | null {
  const bearing = ((line.bearingDeg % 180) + 180) % 180
  if (bearing < 1 || bearing > 179) return 'x'
  if (Math.abs(bearing - 90) < 1) return 'z'
  return null
}

function towerObstacles(tower: TowerAsset, line: GridLine): ObstacleDefinition[] {
  const levels = tower.armLevelsM
  const top = towerTopAltitudeM(tower)
  const lowestLevel = levels[0] ?? tower.bodyHeightM
  const bodyTop = lowestLevel - TOWER_BODY_TOP_EXTRA_M
  const obstacles: ObstacleDefinition[] = [
    {
      name: `${tower.id}_BODY`,
      label: `${tower.label} 塔身`,
      x: tower.x,
      z: tower.z,
      width: TOWER_BODY_WIDTH_M,
      depth: TOWER_BODY_WIDTH_M,
      height: Math.max(bodyTop, 1),
      color: 0x5b6b74,
      solid: true,
    },
    {
      name: `${tower.id}_HEAD`,
      label: `${tower.label} 塔头`,
      x: tower.x,
      z: tower.z,
      width: TOWER_HEAD_WIDTH_M,
      depth: TOWER_HEAD_WIDTH_M,
      height: top - Math.max(bodyTop, 1),
      color: 0x6a7c86,
      baseY: Math.max(bodyTop, 1),
      solid: true,
    },
  ]

  const axis = armAxis(line)
  if (axis) {
    levels.forEach((level, index) => {
      const span = tower.armHalfSpanM * 2
      obstacles.push({
        name: `${tower.id}_ARM${index + 1}`,
        label: `${tower.label} 第 ${index + 1} 层横担`,
        x: tower.x,
        z: tower.z,
        width: axis === 'x' ? span : ARM_THICKNESS_M,
        depth: axis === 'x' ? ARM_THICKNESS_M : span,
        height: ARM_HEIGHT_M,
        color: 0x7d8d95,
        baseY: level - ARM_HEIGHT_M / 2,
        solid: true,
      })
    })
  }

  return obstacles
}

export interface GridScenarioOptions {
  readonly line?: GridLine
  readonly id?: string
  readonly label?: string
  /** 是否把杆塔构件做成实体障碍物(默认 true);false = 只保留变电站等场景件 */
  readonly towersSolid?: boolean
}

/**
 * 电网巡检场景:输电走廊 + 变电站 + 无人机出生点。
 *
 * 时间设在上午 10 点、无风无雨 —— 这是巡检的**基准工况**,先把航线与判定链跑通,
 * 再让风与雾去干扰(那是 ScenePanel 里的事,不改场景)。
 */
export function gridInspectionScenario(options: GridScenarioOptions = {}): Scenario {
  const line = options.line ?? gridInspectionLine()
  const launch = gridLaunchSite()
  const towersSolid = options.towersSolid ?? true

  const obstacles: ObstacleDefinition[] = []
  if (towersSolid) {
    for (const tower of line.towers) {
      obstacles.push(...towerObstacles(tower, line))
    }
  }

  // 末端变电站:给巡检一个「线路尽头」的实景参照,也让报告里的里程有个落点
  const lastTower = line.towers[line.towers.length - 1]
  if (lastTower) {
    obstacles.push({
      name: 'SUBSTATION',
      label: '末端变电站',
      x: lastTower.x,
      z: lastTower.z - 46,
      width: 22,
      depth: 16,
      height: 6,
      color: 0x3d4c55,
      solid: true,
    })
  }

  return {
    id: options.id ?? 'grid-inspection-corridor',
    label: options.label ?? `${line.label} 巡检走廊`,
    description: `${line.voltageKv} kV 输电走廊:${line.towers.length} 基杆塔(塔身/塔头/横担为实体障碍物)+ 末端变电站,适合验证航线规划、逐塔对准采集与巡检报告`,
    seed: 20261008,
    wind: { speed: 0, directionDeg: 0 },
    weather: 'clear',
    timeOfDay: 10,
    geofence: { minX: -140, maxX: 140, minZ: -260, maxZ: 160, maxAltitude: 120 },
    obstacles,
    agents: [
      {
        kind: 'drone',
        id: 'drone-01',
        label: '巡检机 01',
        x: launch.x,
        y: launch.y,
        z: launch.z,
        headingDeg: launch.headingDeg,
      },
    ],
    tasks: [],
  }
}
