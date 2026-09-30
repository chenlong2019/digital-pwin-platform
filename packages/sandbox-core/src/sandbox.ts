/**
 * StaticSandbox —— 静态运行世界。
 *
 * 同时实现两个角色:
 *   · SandboxQuery —— Agent 读环境的唯一入口(getTerrainHeight / queryObstacle / raycast / getWind ...)
 *   · Environment  —— Runtime 在 tick 第 ① 步更新的对象
 *
 * 它不负责:Agent Dynamics、Task Execution、用户权限、UI、Replay。
 * 障碍物只有一份数据,避障判定与可视化共用,不会出现「看着撞上了却没刹停」。
 */
import type {
  Environment,
  EnvironmentSnapshot,
  ObstacleBox,
  RaycastHit,
  SandboxQuery,
  Vec3,
  WeatherKind,
  WindState,
} from '@simulation/contracts'
import { pointInsideBox, raycastObstacles } from './raycast'
import type { GeofenceDefinition, ObstacleDefinition, Scenario } from './scenario'

export interface StaticSandboxOptions {
  readonly id?: string
  readonly obstacles?: ReadonlyArray<ObstacleBox>
  readonly wind?: WindState
  readonly weather?: WeatherKind
  readonly timeOfDay?: number
  /** 平地地形高度,默认 0 */
  readonly terrainHeight?: number
  /** 水面深度,默认 0(无水域) */
  readonly waterDepth?: number
  readonly geofence?: GeofenceDefinition | null
}

export function toObstacleBox(definition: ObstacleDefinition): ObstacleBox {
  const baseY = definition.baseY ?? 0
  return {
    name: definition.label,
    minX: definition.x - definition.width / 2,
    maxX: definition.x + definition.width / 2,
    minY: baseY,
    maxY: baseY + definition.height,
    minZ: definition.z - definition.depth / 2,
    maxZ: definition.z + definition.depth / 2,
    solid: definition.solid ?? true,
  }
}

export class StaticSandbox implements SandboxQuery, Environment {
  readonly id: string
  private readonly boxes: ObstacleBox[]
  private readonly terrainHeight: number
  private readonly waterDepth: number
  private wind: WindState
  private weather: WeatherKind
  private timeOfDay: number
  private readonly geofence: GeofenceDefinition | null
  private lastTick = 0

  constructor(options: StaticSandboxOptions = {}) {
    this.id = options.id ?? 'static-sandbox'
    this.boxes = [...(options.obstacles ?? [])]
    this.wind = options.wind ?? { speed: 0, directionDeg: 0 }
    this.weather = options.weather ?? 'clear'
    this.timeOfDay = options.timeOfDay ?? 10
    this.terrainHeight = options.terrainHeight ?? 0
    this.waterDepth = options.waterDepth ?? 0
    this.geofence = options.geofence ?? null
  }

  // ————————————————————————————— SandboxQuery —————————————————————————————

  get obstacles(): ReadonlyArray<ObstacleBox> {
    return this.boxes
  }

  getTerrainHeight(_x: number, _z: number): number {
    return this.terrainHeight
  }

  queryObstacle(x: number, y: number, z: number): ObstacleBox | null {
    for (const box of this.boxes) {
      if (pointInsideBox(x, y, z, box)) return box
    }
    return null
  }

  raycast(origin: Vec3, direction: Vec3, maxDistance: number): RaycastHit | null {
    return raycastObstacles(origin, direction, maxDistance, this.boxes)
  }

  getWind(): WindState {
    return this.wind
  }

  getWeather(): WeatherKind {
    return this.weather
  }

  getWaterDepth(_x: number, _z: number): number {
    return this.waterDepth
  }

  isInsideGeofence(x: number, z: number): boolean {
    if (!this.geofence) return true
    return (
      x >= this.geofence.minX && x <= this.geofence.maxX && z >= this.geofence.minZ && z <= this.geofence.maxZ
    )
  }

  // ————————————————————————————— Environment —————————————————————————————

  update(context: { tick: number; simulationTime: number; deltaTime: number }): void {
    // 静态环境暂无随时间演化的量。保留入口,后续接天气系统时在此推进。
    this.lastTick = context.tick
  }

  getSnapshot(): EnvironmentSnapshot {
    return {
      wind: this.wind,
      weather: this.weather,
      timeOfDay: this.timeOfDay,
      sandboxId: this.id,
    }
  }

  getQuery(): SandboxQuery {
    return this
  }

  dispose(): void {
    this.boxes.length = 0
  }

  // ————————————————————————————— 编辑沙盒 —————————————————————————————

  setWind(wind: WindState): void {
    this.wind = wind
  }

  setWeather(weather: WeatherKind): void {
    this.weather = weather
  }

  setTimeOfDay(hours: number): void {
    this.timeOfDay = Math.max(0, Math.min(24, hours))
  }

  setObstacles(boxes: ReadonlyArray<ObstacleBox>): void {
    this.boxes.length = 0
    this.boxes.push(...boxes)
  }

  get lastUpdatedTick(): number {
    return this.lastTick
  }
}

/** 从 Scenario 装配沙盒 —— Scenario --load--> Sandbox */
export function createSandboxFromScenario(scenario: Scenario): StaticSandbox {
  return new StaticSandbox({
    id: scenario.id,
    obstacles: scenario.obstacles.map(toObstacleBox),
    wind: scenario.wind,
    weather: scenario.weather,
    timeOfDay: scenario.timeOfDay,
    geofence: scenario.geofence,
  })
}
