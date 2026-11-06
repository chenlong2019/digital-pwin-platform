import type { Scenario } from '@simulation/sandbox-core'
import type { PointCloudSceneOptions } from '@simulation/three-adapter'
import type { Waypoint } from '@simulation/task-core'
import layout from './campus-layout.json'

export const CAMPUS_SCENE_ID = 'campus-road-points-v2-spacing-fix'

export const campusPointCloud: PointCloudSceneOptions = {
  indexUrl: `${import.meta.env.BASE_URL}scenes/campus-road/index.json`,
  detailBaseUrl:
    import.meta.env.VITE_CAMPUS_POINT_CLOUD_URL ??
    'http://49.235.216.125/pointcloud/campus-road-points-v2-spacing-fix',
  bounds: layout.bounds,
  pointBudget: 2_500_000,
  cachePointBudget: 5_000_000,
}

export function campusScenario(): Scenario {
  return {
    id: CAMPUS_SCENE_ID,
    label: '园区点云',
    description: '284 × 238 米园区点云，南侧道路起飞；建筑与绿化使用点云生成的简化避障范围。',
    seed: 20261106,
    wind: { speed: 0, directionDeg: 0 },
    weather: 'clear',
    timeOfDay: 10,
    geofence: { minX: -140, maxX: 140, minZ: -222, maxZ: 12, maxAltitude: 160 },
    obstacles: layout.obstacles,
    agents: [
      { kind: 'drone', id: 'drone-01', label: 'Mini 4 Pro', x: 0, y: 0, z: 0, headingDeg: 0 },
    ],
    tasks: [],
  }
}

/** Introductory route along the open road, at a launch-relative altitude. */
export const campusWaypoints: ReadonlyArray<Waypoint> = [
  { id: 'campus-east', label: '南侧道路 · 东段', x: 35, z: 0, altitude: 8 },
  { id: 'campus-west', label: '南侧道路 · 西段', x: -35, z: 0, altitude: 8 },
  { id: 'campus-home', label: '返回起飞点', x: 0, z: 0, altitude: 8 },
]
