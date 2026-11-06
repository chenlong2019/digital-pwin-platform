import type { PointCloudSceneOptions } from '@simulation/three-adapter'

export const BUILDING_SCENE_ID = 'campus-building-a-lod0-v1'
export const buildingPointCloud: PointCloudSceneOptions = {
  indexUrl: `${import.meta.env.BASE_URL}scenes/campus-building-a/index.json`,
  detailBaseUrl: '',
  surfaceCoverage: true,
  bounds: { min: [-117, -0.1, -46], max: [-91, 37, -14] },
}
