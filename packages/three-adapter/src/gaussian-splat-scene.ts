import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { SparkRenderer, SplatFileType, SplatMesh } from '@sparkjsdev/spark'
import { applyGaussianTestCamera } from './gaussian-camera'
import type { GaussianTestCamera } from './gaussian-camera'

export interface GaussianViewerStats {
  readonly fps: number
  readonly width: number
  readonly height: number
  readonly gaussians: number
}
export interface GaussianViewerCallbacks {
  readonly onStats?: (stats: GaussianViewerStats) => void
  readonly onError?: (message: string) => void
}

/** Real anisotropic splats, sorted and alpha-composited inside a THREE.Scene. */
export class GaussianSplatScene {
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(58, 1, 0.1, 4000)
  private readonly renderer: THREE.WebGLRenderer
  private readonly spark: SparkRenderer
  private readonly controls: OrbitControls
  private readonly observer: ResizeObserver
  private readonly abort = new AbortController()
  private readonly center = new THREE.Vector3()
  private readonly home = new THREE.Vector3()
  private mesh: SplatMesh | null = null
  private radius = 100
  private count = 0
  private disposed = false
  private frameCount = 0
  private sampleStart = performance.now()
  private lastFrame = performance.now()

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: GaussianViewerCallbacks = {},
  ) {
    this.scene.background = new THREE.Color('#0a141b')
    this.renderer = new THREE.WebGLRenderer({ antialias: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.domElement.setAttribute('aria-label', '交互式三维高斯模型')
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost)
    this.container.appendChild(this.renderer.domElement)
    this.spark = new SparkRenderer({
      renderer: this.renderer,
      enableLod: false,
      sortRadial: false,
      maxStdDev: 3,
      preBlurAmount: 0.3,
      blurAmount: 0,
      accumExtSplats: true,
    })
    this.scene.add(this.spark)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.autoRotateSpeed = 0.6
    this.controls.minDistance = 1
    this.controls.maxDistance = 2000
    this.camera.position.set(300, 200, 300)
    this.controls.update()
    this.observer = new ResizeObserver(this.resize)
    this.observer.observe(container)
    this.resize()
    this.renderer.setAnimationLoop(this.animate)
  }

  private onContextLost = (event: Event): void => {
    event.preventDefault()
    this.renderer.setAnimationLoop(null)
    this.callbacks.onError?.('三维显示连接中断，请点击重新加载。')
  }

  private resize = (): void => {
    if (this.disposed) return
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  private animate = (): void => {
    if (this.disposed || document.hidden) return
    try {
      const now = performance.now()
      this.controls.update(Math.min(0.05, (now - this.lastFrame) / 1000))
      this.lastFrame = now
      this.renderer.render(this.scene, this.camera)
      this.frameCount++
      if (now - this.sampleStart >= 750) {
        const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
        this.callbacks.onStats?.({
          fps: (this.frameCount * 1000) / (now - this.sampleStart),
          width: size.x,
          height: size.y,
          gaussians: this.count,
        })
        this.sampleStart = now
        this.frameCount = 0
      }
    } catch (error) {
      this.renderer.setAnimationLoop(null)
      this.callbacks.onError?.(error instanceof Error ? error.message : '三维显示失败')
    }
  }

  async load(url: string): Promise<number> {
    const response = await fetch(url, {
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(60000)]),
    })
    if (!response.ok) throw new Error(`高斯模型加载失败（${response.status}）`)
    const fileBytes = await response.arrayBuffer()
    if (this.disposed) throw new DOMException('Viewer closed', 'AbortError')
    const mesh = new SplatMesh({
      fileBytes,
      fileType: SplatFileType.PLY,
      extSplats: true,
      lod: false,
      enableLod: false,
      raycastable: false,
    })
    // The decoder runs asynchronously. Dispose its output even if the user
    // navigates away before initialization finishes.
    try {
      await mesh.initialized
      if (this.disposed) throw new DOMException('Viewer closed', 'AbortError')
      const bounds = mesh.getBoundingBox()
      const count = mesh.numSplats
      if (
        !count ||
        bounds.isEmpty() ||
        ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)
      )
        throw new Error('高斯模型为空或坐标无效')
      this.mesh = mesh
      this.count = count
      bounds.getCenter(this.center)
      this.radius = Math.max(1, bounds.getBoundingSphere(new THREE.Sphere()).radius)
      const angle = Math.min(
        (58 * Math.PI) / 180,
        2 * Math.atan(Math.tan((29 * Math.PI) / 180) * this.camera.aspect),
      )
      const distance = (this.radius / Math.sin(angle / 2)) * 1.08
      this.home
        .copy(this.center)
        .add(new THREE.Vector3(0.8, 0.65, 1).normalize().multiplyScalar(distance))
      this.camera.far = Math.max(4000, distance * 10)
      this.controls.maxDistance = distance * 4
      this.scene.add(mesh)
      this.reset()
      await this.spark.update({ scene: this.scene, camera: this.camera })
      return count
    } catch (error) {
      if (this.mesh === mesh) this.mesh = null
      this.scene.remove(mesh)
      mesh.dispose()
      throw error
    }
  }

  reset(): void {
    this.clearMotion()
    this.camera.up.set(0, 1, 0)
    this.camera.fov = 58
    this.camera.position.copy(this.home)
    this.controls.target.copy(this.center)
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  top(): void {
    this.clearMotion()
    this.camera.up.set(0, 0, -1)
    this.camera.fov = 58
    this.camera.position
      .copy(this.center)
      .add(new THREE.Vector3(0, this.home.distanceTo(this.center), 0.001))
    this.controls.target.copy(this.center)
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  setTestCamera(view: GaussianTestCamera): void {
    this.clearMotion()
    const forward = applyGaussianTestCamera(this.camera, view)
    this.controls.target
      .copy(this.camera.position)
      .addScaledVector(forward, Math.max(this.radius, this.camera.position.distanceTo(this.center)))
    this.controls.update()
  }

  setAutoRotate(value: boolean): void {
    this.controls.autoRotate = value
  }

  private clearMotion(): void {
    // Finish and clear damping before assigning a saved camera, otherwise a
    // recent drag continues moving the newly selected test view.
    const autoRotate = this.controls.autoRotate
    this.controls.autoRotate = false
    this.controls.enableDamping = false
    this.controls.update(0)
    this.controls.enableDamping = true
    this.controls.autoRotate = autoRotate
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
    this.renderer.setAnimationLoop(null)
    this.observer.disconnect()
    this.controls.dispose()
    this.spark.dispose()
    this.mesh?.dispose()
    this.mesh = null
    this.scene.clear()
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost)
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}
