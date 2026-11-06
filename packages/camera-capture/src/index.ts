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
  validateDataset(datasetId: string): Promise<DatasetValidationResult>
  finalizeDataset(datasetId: string): Promise<void>
}

export interface DatasetValidationResult {
  readonly dataset_id: string
  readonly valid: boolean
  readonly frame_count: number
  readonly issues: ReadonlyArray<{
    code: string
    severity: 'error' | 'warning'
    message: string
    frame_id?: string
  }>
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

export interface AutoCaptureOptions {
  /** 仿真时间间隔，单位毫秒；0 表示关闭时间触发。 */
  readonly intervalMs?: number
  /** 飞行距离间隔，单位米；0 表示关闭距离触发。 */
  readonly distanceM?: number
  readonly metadata?: Readonly<Record<string, unknown>> | (() => Readonly<Record<string, unknown>>)
  readonly onFrame?: (frame: DatasetFrame) => void
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
  private autoTimer: ReturnType<typeof setInterval> | null = null
  private autoOptions: AutoCaptureOptions | null = null
  private autoLastCapturedAt = 0
  private autoLastPosition: DatasetCameraPose['positionM'] | null = null
  private autoBusy = false

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

  get isAutoCapturing(): boolean {
    return this.autoTimer !== null
  }

  startAutoCapture(options: AutoCaptureOptions = {}): boolean {
    if (!this.session) return false
    const intervalMs = Math.max(0, options.intervalMs ?? 0)
    const distanceM = Math.max(0, options.distanceM ?? 0)
    if (intervalMs <= 0 && distanceM <= 0) return false
    this.stopAutoCapture()
    this.autoOptions = { ...options, intervalMs, distanceM }
    this.autoLastCapturedAt = 0
    this.autoLastPosition = null
    this.autoTimer = setInterval(() => void this.tickAutoCapture(), 200)
    void this.tickAutoCapture(true)
    return true
  }

  stopAutoCapture(): void {
    if (this.autoTimer !== null) clearInterval(this.autoTimer)
    this.autoTimer = null
    this.autoOptions = null
    this.autoLastPosition = null
    this.autoBusy = false
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

  private async tickAutoCapture(force = false): Promise<void> {
    const options = this.autoOptions
    if (!options || this.autoBusy || !this.session) return
    const camera = this.provider.getCaptureCamera()
    if (!camera) return
    const now = Date.now()
    const elapsed = now - this.autoLastCapturedAt
    const position = camera.pose.positionM
    const moved = this.autoLastPosition
      ? Math.hypot(
          position.x - this.autoLastPosition.x,
          position.y - this.autoLastPosition.y,
          position.z - this.autoLastPosition.z,
        )
      : Number.POSITIVE_INFINITY
    const dueByTime = (options.intervalMs ?? 0) > 0 && elapsed >= (options.intervalMs ?? 0)
    const dueByDistance = (options.distanceM ?? 0) > 0 && moved >= (options.distanceM ?? 0)
    if (!force && !dueByTime && !dueByDistance) return

    this.autoBusy = true
    try {
      const metadata = typeof options.metadata === 'function' ? options.metadata() : options.metadata
      const frame = await this.captureFrame(metadata)
      if (frame) {
        this.autoLastCapturedAt = Date.now()
        this.autoLastPosition = { ...position }
        options.onFrame?.(frame)
      }
    } finally {
      this.autoBusy = false
    }
  }

  validateDataset(): Promise<DatasetValidationResult> {
    if (!this.session) return Promise.reject(new Error('capture session has not been created'))
    return this.client.validateDataset(this.session.datasetId)
  }

  async finalizeDataset(): Promise<void> {
    if (!this.session) throw new Error('capture session has not been created')
    await this.client.finalizeDataset(this.session.datasetId)
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
    const sceneResponse = await this.fetcher(`${this.baseUrl}/api/v1/scenes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scene_id: input.sceneId, name: input.sceneId }),
    })
    if (!sceneResponse.ok && sceneResponse.status !== 409) throw new Error(`scene registration failed: ${sceneResponse.status}`)
    const response = await this.fetcher(`${this.baseUrl}/api/v1/datasets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataset_id: input.datasetId, name: input.name, scene_id: input.sceneId, scene_version: input.sceneVersion, metadata: input.metadata }),
    })
    if (!response.ok) throw new Error(`dataset creation failed: ${response.status}`)
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

  async validateDataset(datasetId: string): Promise<DatasetValidationResult> {
    const response = await this.fetcher(`${this.baseUrl}/api/v1/datasets/${datasetId}/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (!response.ok) throw new Error(`dataset validation failed: ${response.status}`)
    return (await response.json()) as DatasetValidationResult
  }

  async finalizeDataset(datasetId: string): Promise<void> {
    const response = await this.fetcher(`${this.baseUrl}/api/v1/datasets/${datasetId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (!response.ok) throw new Error(`dataset finalize failed: ${response.status}`)
  }
}
