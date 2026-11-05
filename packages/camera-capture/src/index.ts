import type {
  DatasetCameraIntrinsics,
  DatasetCameraPose,
  DatasetFrame,
  NeuralDatasetManifest,
} from '@simulation/contracts'
import { createDatasetManifest, DATASET_COORDINATE_FRAME } from '@simulation/contracts'

export interface CaptureShot {
  readonly dataUrl: string
  readonly width: number
  readonly height: number
}

export interface CaptureCameraState {
  readonly pose: DatasetCameraPose
  readonly intrinsics: DatasetCameraIntrinsics
}

export interface CaptureProvider {
  requestPhoto(): Promise<CaptureShot | null>
  getCaptureCamera(): CaptureCameraState | null
}

export interface DatasetFrameUpload {
  readonly frameId: string
  readonly imageDataUrl: string
  readonly width: number
  readonly height: number
  readonly simulationTime: number
  readonly capturedAt: string
  readonly cameraPose: CaptureCameraState['pose']
  readonly cameraIntrinsics: CaptureCameraState['intrinsics']
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface DatasetRegistrationClient {
  createDataset(input: {
    datasetId: string
    name: string
    sceneId: string
    sceneVersion?: string
    metadata?: Readonly<Record<string, unknown>>
  }): Promise<void>
  uploadFrame(datasetId: string, frame: DatasetFrameUpload): Promise<{ imageUri: string }>
}

export interface Fetcher {
  (input: string, init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
  }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
}

export interface CaptureDatasetOptions {
  readonly datasetId: string
  readonly name: string
  readonly sceneId: string
  readonly sceneVersion?: string
  readonly camera: DatasetCameraIntrinsics
  readonly simulationTime?: () => number
  readonly now?: () => string
  readonly createFrameId?: () => string
}

export interface CaptureDatasetSession {
  readonly datasetId: string
  readonly sceneId: string
  readonly manifest: NeuralDatasetManifest
}

/**
 * 把渲染器的虚拟拍照能力接成持久化数据集。
 * requestPhoto() 和 getCaptureCamera() 必须来自同一个渲染器实例，
 * 这样图片与相机位姿不会出现跨帧错配。
 */
export class CaptureService {
  private readonly provider: CaptureProvider
  private readonly client: DatasetRegistrationClient
  private session: CaptureDatasetSession | null = null
  private simulationTime: () => number = () => 0
  private now: () => string = () => new Date().toISOString()
  private createFrameId: () => string = () => `frame-${Math.random().toString(36).slice(2, 10)}`

  constructor(provider: CaptureProvider, client: DatasetRegistrationClient) {
    this.provider = provider
    this.client = client
  }

  async createSession(options: CaptureDatasetOptions): Promise<CaptureDatasetSession> {
    this.simulationTime = options.simulationTime ?? (() => 0)
    this.now = options.now ?? (() => new Date().toISOString())
    this.createFrameId = options.createFrameId ?? (() => `frame-${Math.random().toString(36).slice(2, 10)}`)
    await this.client.createDataset({
      datasetId: options.datasetId,
      name: options.name,
      sceneId: options.sceneId,
      sceneVersion: options.sceneVersion,
    })
    const manifest = createDatasetManifest({
      datasetId: options.datasetId,
      sceneId: options.sceneId,
      sceneVersion: options.sceneVersion,
      camera: options.camera,
    })
    this.session = { datasetId: options.datasetId, sceneId: options.sceneId, manifest }
    return this.session
  }

  get activeSession(): CaptureDatasetSession | null {
    return this.session
  }

  async captureFrame(metadata?: Readonly<Record<string, unknown>>): Promise<DatasetFrame | null> {
    if (!this.session) throw new Error('capture session has not been created')
    const shot = await this.provider.requestPhoto()
    if (!shot) return null
    const camera = this.provider.getCaptureCamera()
    if (!camera) throw new Error('capture camera state is not ready')

    const frameId = this.createFrameId()
    const capturedAt = this.now()
    const simulationTime = this.simulationTime()
    const uploaded = await this.client.uploadFrame(this.session.datasetId, {
      frameId,
      imageDataUrl: shot.dataUrl,
      width: shot.width,
      height: shot.height,
      simulationTime,
      capturedAt,
      cameraPose: camera.pose,
      cameraIntrinsics: camera.intrinsics,
      metadata,
    })
    const frame: DatasetFrame = {
      frameId,
      imageUri: uploaded.imageUri,
      imageMimeType: 'image/png',
      width: shot.width,
      height: shot.height,
      simulationTime,
      capturedAt,
      cameraPose: {
        positionM: camera.pose.positionM,
        quaternionXyzw: camera.pose.quaternionXyzw,
        coordinateFrame: DATASET_COORDINATE_FRAME,
      },
      cameraIntrinsics: {
        width: camera.intrinsics.width,
        height: camera.intrinsics.height,
        fx: camera.intrinsics.fx,
        fy: camera.intrinsics.fy,
        cx: camera.intrinsics.cx,
        cy: camera.intrinsics.cy,
        distortion: camera.intrinsics.distortion,
      },
      metadata,
    }
    this.session = {
      ...this.session,
      manifest: { ...this.session.manifest, frames: [...this.session.manifest.frames, frame] },
    }
    return frame
  }
}

export class NeuralRenderHttpClient implements DatasetRegistrationClient {
  constructor(private readonly baseUrl: string, private readonly fetcher: Fetcher) {}

  async createDataset(input: {
    datasetId: string
    name: string
    sceneId: string
    sceneVersion?: string
    metadata?: Readonly<Record<string, unknown>>
  }): Promise<void> {
    const response = await this.fetcher(`${this.baseUrl}/api/v1/datasets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!response.ok && response.status !== 409) throw new Error(`dataset creation failed: ${response.status}`)
  }

  async uploadFrame(datasetId: string, frame: DatasetFrameUpload): Promise<{ imageUri: string }> {
    const response = await this.fetcher(`${this.baseUrl}/api/v1/datasets/${datasetId}/frames`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(frame),
    })
    if (!response.ok) throw new Error(`dataset frame upload failed: ${response.status}`)
    return (await response.json()) as { imageUri: string }
  }
}
