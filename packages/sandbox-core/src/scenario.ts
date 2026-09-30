/**
 * Scenario —— Sandbox 的可持久化配置(README §7)。
 *   Scenario --load--> Sandbox --runtime--> Session
 * 所以 Scenario ≠ Sandbox。
 */
import type { WeatherKind, WindState } from '@simulation/contracts'

export interface ObstacleDefinition {
  readonly name: string
  readonly label: string
  readonly x: number
  readonly z: number
  readonly width: number
  readonly depth: number
  readonly height: number
  /** 可视化颜色,场景数据的一部分(不是渲染代码) */
  readonly color: number
  /**
   * 底面离地高度(米)。默认 0 = 落地障碍物;>0 = 悬空障碍物(天桥等)。
   * 机体「上方测距」需要悬空件,否则上视雷达永远看不到东西。
   */
  readonly baseY?: number
  /** 是否需要绕开,默认 true */
  readonly solid?: boolean
}

export interface GeofenceDefinition {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  readonly maxAltitude: number
}

/** Agent 初始配置 —— kind 由领域包解释,沙盒不关心具体含义 */
export interface AgentSeed {
  readonly kind: string
  readonly id: string
  readonly label?: string
  readonly x?: number
  readonly y?: number
  readonly z?: number
  readonly headingDeg?: number
  readonly options?: Readonly<Record<string, unknown>>
}

/** Task 初始配置 */
export interface TaskSeed {
  readonly kind: string
  readonly id: string
  readonly label?: string
  readonly agentId?: string
  readonly options?: Readonly<Record<string, unknown>>
}

export interface Scenario {
  readonly id: string
  readonly label: string
  readonly description: string
  /** 确定性种子:同 Seed + 同 Scenario + 同 Command 序列 ⇒ 等价结果 */
  readonly seed: number
  readonly wind: WindState
  readonly weather: WeatherKind
  readonly timeOfDay: number
  readonly geofence: GeofenceDefinition | null
  readonly obstacles: ReadonlyArray<ObstacleDefinition>
  readonly agents: ReadonlyArray<AgentSeed>
  readonly tasks: ReadonlyArray<TaskSeed>
}

/**
 * 默认场景 —— DJI Mini 4 Pro 测试沙盒。
 *
 * 障碍物与旧项目 firstapp 的 `DEFAULT_OBSTACLES` 逐项对齐:两组建筑 + 一根正前方灯杆
 * + 三棵树 + 一道悬空天桥,都在起飞点 30 米内。灯杆用来验证前视双镜头在中线的盲区,
 * 天桥用来验证机体上方的测距,因此这份数据既是渲染数据也是避障判定数据(单一来源)。
 */
export function defaultScenario(): Scenario {
  return {
    id: 'drone-test-sandbox',
    label: '无人机测试沙盒',
    description: '4000 米底板 + 两组建筑/灯杆/三棵树/悬空天桥,默认无风,适合验证起降、航点、避障与测距',
    seed: 20260928,
    wind: { speed: 0, directionDeg: 0 },
    weather: 'clear',
    timeOfDay: 10,
    geofence: { minX: -150, maxX: 150, minZ: -150, maxZ: 150, maxAltitude: 120 },
    obstacles: [
      { name: 'BUILDING_A', label: '建筑 A', x: 16, z: -12, width: 9, depth: 9, height: 13, color: 0x2c3a44 },
      { name: 'BUILDING_B', label: '建筑 B', x: -20, z: 10, width: 11, depth: 15, height: 7, color: 0x2a3740 },
      { name: 'LAMP_POST', label: '灯杆', x: 0, z: -16, width: 0.3, depth: 0.3, height: 8, color: 0x44535f },
      { name: 'SKY_BRIDGE', label: '天桥', x: 0, z: 10.5, width: 18, depth: 6, height: 2, color: 0x3a4a55, baseY: 7.5 },
      { name: 'TREE_1', label: '树 1', x: 9, z: 14, width: 3.2, depth: 3.2, height: 6, color: 0x24443a },
      { name: 'TREE_2', label: '树 2', x: -10, z: -17, width: 2.8, depth: 2.8, height: 4.6, color: 0x21403a },
      { name: 'TREE_3', label: '树 3', x: 24, z: 7, width: 3, depth: 3, height: 5.4, color: 0x24443a },
    ],
    agents: [{ kind: 'drone', id: 'drone-01', label: 'Mini 4 Pro', x: 0, y: 0, z: 0, headingDeg: 0 }],
    tasks: [],
  }
}
