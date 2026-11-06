import * as THREE from 'three'
import type { DatasetCameraIntrinsics, DatasetCameraPose } from '@simulation/contracts'
import { PointCloudLayer } from './point-cloud-layer'
import type { PointCloudSceneOptions } from './point-cloud-layer'

export interface MultiViewCamera {
  readonly position: { x: number; y: number; z: number }
  readonly target: { x: number; y: number; z: number }
}

export interface MultiViewPhoto {
  readonly dataUrl: string
  readonly pose: DatasetCameraPose
  readonly intrinsics: DatasetCameraIntrinsics
}

/** Clean, fixed-resolution virtual-camera capture; no drone/HUD/helper geometry. */
export class PointCloudCaptureRenderer {
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly renderer: THREE.WebGLRenderer
  private readonly cloud: PointCloudLayer
  private disposed = false

  constructor(
    container: HTMLElement,
    options: PointCloudSceneOptions,
    readonly width = 256,
    readonly height = 192,
  ) {
    this.scene.background = new THREE.Color('#0a141b')
    this.camera = new THREE.PerspectiveCamera(58, width / height, 0.1, 2000)
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(1024, 768)
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    container.appendChild(this.renderer.domElement)
    // Freeze representation for all train/test views so network-dependent LOD
    // changes cannot become inconsistent supervision.
    this.cloud = new PointCloudLayer(this.scene, { ...options, detailBaseUrl: '' })
  }

  async initialize(): Promise<void> {
    const deadline = performance.now() + 30_000
    while (!this.disposed && performance.now() < deadline) {
      const state = this.cloud.snapshot()
      if (state.state === 'error') throw new Error(state.error)
      if (state.state === 'ready') return
      await new Promise((resolve) => window.setTimeout(resolve, 100))
    }
    throw new Error(this.disposed ? '采集场景已关闭' : '园区概览加载超时')
  }

  sourceIdentity() {
    return this.cloud.sourceIdentity()
  }

  preview(view: MultiViewCamera): void {
    if (this.disposed || this.cloud.snapshot().state !== 'ready')
      throw new Error('采集场景尚未就绪')
    this.camera.position.set(view.position.x, view.position.y, view.position.z)
    this.camera.lookAt(view.target.x, view.target.y, view.target.z)
    this.camera.updateMatrixWorld(true)
    this.renderer.render(this.scene, this.camera)
  }

  capture(view: MultiViewCamera, width = this.width, height = this.height): MultiViewPhoto {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 64 ||
      height < 64 ||
      width > 512 ||
      height > 512
    )
      throw new Error('采集分辨率需在 64–512 像素之间')
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
    this.preview(view)
    const q = this.camera.quaternion
    const projection = this.camera.projectionMatrix.elements
    const photo: MultiViewPhoto = {
      dataUrl: this.renderer.domElement.toDataURL('image/png'),
      pose: {
        positionM: { ...view.position },
        quaternionXyzw: { x: q.x, y: q.y, z: q.z, w: q.w },
        coordinateFrame: 'platform-world',
      },
      intrinsics: {
        width,
        height,
        fx: (projection[0]! * width) / 2,
        fy: (projection[5]! * height) / 2,
        cx: width / 2,
        cy: height / 2,
        distortion: [],
      },
    }
    // Preview has its own drawing resolution; never enlarge the training PNG.
    this.renderer.setSize(1024, 768, false)
    this.camera.aspect = 4 / 3
    this.camera.updateProjectionMatrix()
    this.preview(view)
    return photo
  }

  dispose(): void {
    this.disposed = true
    this.cloud.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
