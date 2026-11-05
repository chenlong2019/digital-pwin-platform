/**
 * 神经渲染数据集契约。
 * 平台世界系：+X 东、+Y 上、-Z 北，单位米；四元数顺序固定为 xyzw。
 */
export const DATASET_FORMAT = 'simulation-platform/neural-dataset' as const
export const DATASET_FORMAT_VERSION = 1 as const
export const DATASET_COORDINATE_FRAME = 'platform-world' as const

export type DatasetCoordinateFrame = typeof DATASET_COORDINATE_FRAME

export interface DatasetVec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface DatasetQuaternionXYWZ {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly w: number
}

export interface DatasetCameraIntrinsics {
  readonly width: number
  readonly height: number
  readonly fx: number
  readonly fy: number
  readonly cx: number
  readonly cy: number
  readonly distortion?: ReadonlyArray<number>
}

export interface DatasetCameraPose {
  readonly positionM: DatasetVec3
  readonly quaternionXyzw: DatasetQuaternionXYWZ
  readonly coordinateFrame: DatasetCoordinateFrame
}

export interface DatasetFrame {
  readonly frameId: string
  readonly imageUri: string
  readonly imageMimeType: string
  readonly width: number
  readonly height: number
  readonly simulationTime: number
  readonly capturedAt?: string
  readonly cameraPose: DatasetCameraPose
  readonly cameraIntrinsics: DatasetCameraIntrinsics
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface NeuralDatasetManifest {
  readonly format: typeof DATASET_FORMAT
  readonly version: typeof DATASET_FORMAT_VERSION
  readonly datasetId: string
  readonly sceneId: string
  readonly sceneVersion?: string
  readonly coordinateFrame: DatasetCoordinateFrame
  readonly unit: 'meter'
  readonly createdAt: string
  readonly camera: DatasetCameraIntrinsics
  readonly frames: ReadonlyArray<DatasetFrame>
  readonly metadata?: Readonly<Record<string, unknown>>
}

export function createDatasetManifest(input: {
  datasetId: string
  sceneId: string
  sceneVersion?: string
  camera: DatasetCameraIntrinsics
  frames?: ReadonlyArray<DatasetFrame>
  metadata?: Readonly<Record<string, unknown>>
  createdAt?: string
}): NeuralDatasetManifest {
  return {
    format: DATASET_FORMAT,
    version: DATASET_FORMAT_VERSION,
    datasetId: input.datasetId,
    sceneId: input.sceneId,
    sceneVersion: input.sceneVersion,
    coordinateFrame: DATASET_COORDINATE_FRAME,
    unit: 'meter',
    createdAt: input.createdAt ?? new Date().toISOString(),
    camera: input.camera,
    frames: input.frames ?? [],
    metadata: input.metadata,
  }
}
