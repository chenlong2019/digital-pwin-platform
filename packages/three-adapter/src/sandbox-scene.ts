/**
 * SandboxScene —— 沙盒的「容器」层:渲染器 / 相机 / 全局光照 / 阴影 / 缩放。
 *
 * 场景内容(地面、网格、返航点、障碍物、航迹)已交回 `DroneWorld` —— 旧项目 firstapp
 * 的 drone-world.ts 就是这份职责,而且新版的测距雷达要靠它的 `coneCast` 做视场检测,
 * 拆成两份会让「可视化障碍物」和「雷达量到的障碍物」各说各话。
 *
 * 与旧项目的差异:
 *   ① WebGLRenderer 取代 WebGPURenderer(README §84 规定图形基础是 WebGL2;
 *      WebGPU 路径没有 shadowMap 这类开关,在受限环境也容易拿不到适配器)。
 *   ② 地面/网格只铺一层 —— 旧版 three-viewer 与 drone-world 各铺一层 4000 米地板,
 *      靠 y 偏移错开避免 z-fighting,合并后不再需要这种规避。
 *
 * 本文件只认中性位姿与场景数据,不认识任何仿真遥测。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { SceneObstacle } from './drone-world'
import { DroneWorld } from './drone-world'

export type CameraMode = 'orbit' | 'follow' | 'fpv'

export const CAMERA_MODE_LIST: ReadonlyArray<{ key: CameraMode; label: string }> = [
  { key: 'orbit', label: '观察者' },
  { key: 'follow', label: '跟随' },
  { key: 'fpv', label: '机载' },
]

export interface SandboxSceneOptions {
  readonly container: HTMLElement
  /** 障碍物(几何 + 颜色),由应用层从 Scenario 映射得到 */
  readonly obstacles?: ReadonlyArray<SceneObstacle>
  readonly background?: string
}

export interface CameraUpdateContext {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly headingDeg: number
  readonly deltaSeconds: number
  /** 云台世界变换:机载取景、拍照、录像三处共用同一份;云台不可用时为 null */
  readonly gimbalTransform: THREE.Object3D | null
  /** 设备变焦倍数(云台取景用) */
  readonly zoom: number
}

const FOLLOW_DISTANCE = 7.5
const FOLLOW_HEIGHT = 2.8
const SHADOW_HALF_EXTENT = 42
/**
 * 机载镜头自云台中心沿光轴前移的距离(米)。
 *
 * 云台中心在镜筒内部,直接放相机镜头会把云台外壳拍进画面;前移量与
 * 旧项目 firstapp 的 GIMBAL_CAMERA_OFFSET 保持一致 —— 两边取的必须是同一个取景点,
 * 否则机载视角与拍照出来的构图会差一点。
 */
const GIMBAL_CAMERA_OFFSET = 0.12
/** 拍照等待渲染的兜底时限(毫秒),超时按失败处理 */
const PHOTO_TIMEOUT_MS = 2000
/** 相机位姿快照:取景帧渲染完必须还原,否则轨道视角会被永久拽到云台位置 */
interface CameraRestore {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  zoom: number
}
/** 屏录参数:帧率 / 码率 / 分片间隔 */
const RECORD_FPS = 30
const RECORD_BITRATE = 8_000_000
const RECORD_TIMESLICE_MS = 500
/** 录制收尾兜底时限(毫秒):部分环境可能不派发 onstop */
const RECORD_STOP_TIMEOUT_MS = 1500
/** 录像容器候选:优先 VP9,退回 VP8/webm,再交给浏览器默认 */
const RECORD_MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

/** 单张照片(云台取景) */
export interface PhotoShot {
  /** PNG data URL,可直接给 <img> 或触发下载 */
  readonly dataUrl: string
  readonly width: number
  readonly height: number
}

function pickRecordMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined
  return RECORD_MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime))
}

export class SandboxScene {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  readonly controls: OrbitControls
  /** 场景内容(地面 / 网格 / 返航点 / 障碍物 / 航迹 / 视场检测) */
  readonly world: DroneWorld

  private readonly container: HTMLElement
  private readonly keyLight: THREE.DirectionalLight
  private readonly shadowTarget = new THREE.Object3D()
  private readonly resizeObserver: ResizeObserver
  private readonly axes: THREE.AxesHelper
  private cameraTarget = new THREE.Vector3(0, 0, 0)
  private readonly followPosition = new THREE.Vector3()
  private readonly followLookAt = new THREE.Vector3()
  private readonly forwardVector = new THREE.Vector3()
  private readonly cameraDirection = new THREE.Vector3()
  private mode: CameraMode = 'orbit'
  /** 进入机载取景前的用户缩放,退出时归还(设备变焦不得顶掉轨道视角的滚轮缩放) */
  private savedZoom: number | null = null
  /** 最近一次由外部喂进来的取景源(云台世界变换 + 变焦),拍照时复用 */
  private captureTransform: THREE.Object3D | null = null
  private captureZoom = 1
  /** 待取景的拍照请求:render 前摆相机、render 后同任务内拷屏并还原 */
  private photoRequest: {
    resolve: (shot: PhotoShot | null) => void
    timer: number
    restore: CameraRestore | null
  } | null = null
  /** 屏录:状态来源在领域层(快照里的 recording),这里只负责真正的 MediaRecorder */
  private recorder: MediaRecorder | null = null
  private recordChunks: Blob[] = []
  private recordStream: MediaStream | null = null
  /** 手动抓帧轨道(captureStream(0)):录什么由 render 里搬进录制画布的那一帧云台取景决定 */
  private captureTrack: CanvasCaptureMediaStreamTrack | null = null
  /** 录制专用离屏画布的上下文:每帧只往里搬一帧云台取景,主画布上的用户视角永远不会混进录像 */
  private recordContext: CanvasRenderingContext2D | null = null

  constructor(options: SandboxSceneOptions) {
    this.container = options.container

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(options.background ?? '#0a141b')

    const width = Math.max(this.container.clientWidth, 1)
    const height = Math.max(this.container.clientHeight, 1)
    this.camera = new THREE.PerspectiveCamera(58, width / height, 0.1, 2000)
    this.camera.position.set(7.5, 4.2, 9.5)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(width, height)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.container.appendChild(this.renderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 2.2
    this.controls.maxDistance = 200
    this.controls.maxPolarAngle = Math.PI * 0.495
    this.controls.target.set(0, 1.2, 0)
    this.controls.update()

    // —— 灯光:半球光 + 跟随飞机的太阳(阴影相机只有 ±42 米,跟着飞就不怕飞出范围) ——
    this.scene.add(new THREE.HemisphereLight('#cfe6ff', '#16222b', 1.5))
    const keyLight = new THREE.DirectionalLight('#fff3e0', 2.4)
    keyLight.position.set(18, 26, 14)
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(2048, 2048)
    keyLight.shadow.bias = -0.0006
    keyLight.shadow.normalBias = 0.02
    const shadowCamera = keyLight.shadow.camera
    shadowCamera.left = -SHADOW_HALF_EXTENT
    shadowCamera.right = SHADOW_HALF_EXTENT
    shadowCamera.top = SHADOW_HALF_EXTENT
    shadowCamera.bottom = -SHADOW_HALF_EXTENT
    shadowCamera.near = 1
    shadowCamera.far = 160
    shadowCamera.updateProjectionMatrix()
    keyLight.target = this.shadowTarget
    this.scene.add(keyLight)
    this.scene.add(this.shadowTarget)
    this.keyLight = keyLight

    // —— 场景内容交给 DroneWorld(地面 / 网格 / 返航点 / 障碍物 / 航迹) ——
    this.world = new DroneWorld(this.scene, [...(options.obstacles ?? [])])

    this.axes = new THREE.AxesHelper(1.6)
    this.axes.position.y = 0.01
    this.axes.visible = false
    this.scene.add(this.axes)

    this.resizeObserver = new ResizeObserver(() => this.onResize())
    this.resizeObserver.observe(this.container)
  }

  // ————————————————————————————— 相机 —————————————————————————————

  get cameraMode(): CameraMode {
    return this.mode
  }

  setCameraMode(mode: CameraMode): void {
    const previous = this.mode
    this.mode = mode
    this.controls.enabled = mode === 'orbit'

    // 变焦只在机载取景下生效:进入时记下观察者视角的缩放,离开时归还
    if (mode === 'fpv' && previous !== 'fpv') this.savedZoom = this.camera.zoom
    if (mode !== 'fpv' && previous === 'fpv') {
      this.applyZoom(this.savedZoom ?? 1)
      this.savedZoom = null
    }

    if (mode !== 'orbit') this.cameraTarget.set(this.camera.position.x, 0, this.camera.position.z)
  }

  /** 只在倍数真的变了才动投影矩阵 —— 每帧重算会让画面持续闪 */
  private applyZoom(zoom: number): void {
    if (Math.abs(this.camera.zoom - zoom) <= 1e-3) return
    this.camera.zoom = zoom
    this.camera.updateProjectionMatrix()
  }

  /**
   * 把相机摆到云台镜片位置并取云台朝向 —— 机载视角与拍照共用这一套。
   *
   * 位置 = 云台中心沿光轴前移 offset(否则云台外壳会入镜),朝向 = 云台光轴。
   * 云台自身已做增稳补偿,所以这里不再叠加机体姿态。
   */
  private applyGimbalPose(
    camera: THREE.PerspectiveCamera,
    transform: THREE.Object3D | null,
    zoom: number,
  ): boolean {
    if (!transform) return false
    transform.updateWorldMatrix(true, false)
    transform.getWorldPosition(camera.position)
    transform.getWorldQuaternion(camera.quaternion)
    this.cameraDirection.set(0, 0, -1).applyQuaternion(camera.quaternion)
    camera.position.addScaledVector(this.cameraDirection, GIMBAL_CAMERA_OFFSET)
    this.applyZoom(zoom)
    return true
  }

  resetCamera(x: number, y: number, z: number): void {
    this.setCameraMode('orbit')
    this.camera.position.set(x + 6, y + 3.5, z + 7)
    this.cameraTarget.set(x, y, z)
    this.controls.target.set(x, y, z)
    this.controls.update()
  }

  /** 每帧更新相机 —— 三种模式共用一个入口,保证画面与遥测看的是同一个位姿 */
  updateCamera(context: CameraUpdateContext): void {
    const delta = context.deltaSeconds
    // 记下取景源:拍照与机载视角共用同一套取景,所以拍照时可以直接复用这一帧的云台变换
    this.captureTransform = context.gimbalTransform
    this.captureZoom = context.zoom

    if (this.mode === 'fpv') {
      // 机载取景 = 云台取景
      this.applyGimbalPose(this.camera, context.gimbalTransform, context.zoom)
      return
    }

    if (this.mode === 'follow') {
      const rad = (context.headingDeg * Math.PI) / 180
      this.forwardVector.set(Math.sin(rad), 0, -Math.cos(rad))
      this.followPosition.set(context.x, context.y, context.z).addScaledVector(this.forwardVector, -FOLLOW_DISTANCE)
      this.followPosition.y += FOLLOW_HEIGHT
      this.camera.position.lerp(this.followPosition, Math.min(1, delta * 4))
      this.followLookAt.set(context.x, context.y + 0.6, context.z)
      this.camera.lookAt(this.followLookAt)
      return
    }

    // 观察者:轨道控制器接管,但控制点平滑跟住飞机,避免飞出视野后找不回来
    this.followLookAt.set(context.x, context.y, context.z)
    this.cameraTarget.lerp(this.followLookAt, Math.min(1, delta * 2.2))
    this.forwardVector.subVectors(this.cameraTarget, this.controls.target)
    this.controls.target.add(this.forwardVector)
    this.camera.position.add(this.forwardVector)
  }

  /** 太阳与阴影范围跟着飞机走 */
  setShadowFocus(x: number, z: number): void {
    this.keyLight.position.set(x + 18, 26, z + 14)
    this.shadowTarget.position.set(x, 0, z)
    this.shadowTarget.updateMatrixWorld()
    this.keyLight.updateMatrixWorld()
  }

  // ————————————————————————————— 场景辅助(转发给 DroneWorld) —————————————————————————————

  setHome(x: number, z: number): void {
    this.world.setHome(x, z)
  }

  setObstaclesVisible(visible: boolean): void {
    this.world.setObstaclesVisible(visible)
  }

  /** 记录航迹:每移动 0.25 米落一个点,避免长航线把缓冲撑爆 */
  pushTrail(x: number, y: number, z: number): void {
    this.world.pushTrail(x, y, z)
  }

  clearTrail(): void {
    this.world.clearTrail()
  }

  setAxesVisible(visible: boolean): void {
    this.axes.visible = visible
  }

  render(): void {
    // 轨道控制器只在观察者视角接管:它的 update() 每帧都会 lookAt(target),
    // 在机载 / 跟随模式下会把刚摆好的云台朝向强行拽回去(旧项目 firstapp 的同一处教训)
    if (this.mode === 'orbit') this.controls.update()

    // 录像:先交一帧云台取景给录制器(用户视角另渲)
    this.captureRecordingFrame()

    // 拍照:渲染前换相机位姿 → 渲染 → 同任务内拷屏并还原(见 requestPhoto)
    const request = this.photoRequest
    if (request) this.frameForCapture(request)

    this.renderer.render(this.scene, this.camera)

    if (request) this.finishCapture(request)
  }

  // ————————————————————————————— 取景帧 —————————————————————————————

  /** 记下当前相机位姿,供取景帧渲染完还原 */
  private snapshotCamera(): CameraRestore {
    return {
      position: this.camera.position.clone(),
      quaternion: this.camera.quaternion.clone(),
      zoom: this.camera.zoom,
    }
  }

  /** 把相机位姿还回去 —— 取景帧渲染完必须调用 */
  private restoreCamera(restore: CameraRestore): void {
    this.camera.position.copy(restore.position)
    this.camera.quaternion.copy(restore.quaternion)
    this.applyZoom(restore.zoom)
    this.camera.updateMatrixWorld(true)
  }

  /**
   * 录制帧 —— 交给录制器的画面恒为云台取景,与用户此刻在哪个视角无关。
   *
   * 真机只有一个云台相机,所以录制内容就该是它拍的;而用户盯着的画面可能是
   * 观察者视角,两者不是一回事。做法是每帧走一遍**和拍照完全相同**的取景路径
   * (摆相机 → 渲染 → 同一任务内把这一帧搬进录制画布),再还原相机位姿。
   *
   * 录制流挂在独立的离屏画布上而不是主画布:主画布随后还要渲染用户视角,而画布
   * 捕获是按"绘制之后"抓帧的,直接抓主画布会把用户视角录进去。离屏画布的内容
   * 只有云台取景,污染不了。
   */
  private captureRecordingFrame(): void {
    const track = this.captureTrack
    const context = this.recordContext
    if (!track || !context) return
    const source = this.renderer.domElement
    // 尺寸跟住主画布,窗口变化时录像不留黑边
    if (context.canvas.width !== source.width || context.canvas.height !== source.height) {
      context.canvas.width = source.width
      context.canvas.height = source.height
    }
    if (this.mode === 'fpv') {
      // 相机此刻就在云台上:这一帧渲出来直接搬走
      this.renderer.render(this.scene, this.camera)
      context.drawImage(source, 0, 0)
      track.requestFrame()
      return
    }
    const restore = this.snapshotCamera()
    if (!this.applyGimbalPose(this.camera, this.captureTransform, this.captureZoom)) return
    this.camera.updateMatrixWorld(true)
    this.renderer.render(this.scene, this.camera)
    context.drawImage(source, 0, 0)
    track.requestFrame()
    this.restoreCamera(restore)
  }

  // ————————————————————————————— 拍照 —————————————————————————————

  /**
   * 拍一张「云台取景」的 PNG(与机载视角同一取景,含变焦)。
   *
   * 实现是「渲染前换相机位姿 → 渲染后同一任务内拷屏」:不依赖离屏渲染目标,
   * 各种后端行为一致,而且拷屏与渲染在同一个任务里完成,画面不会闪帧。
   * 上一张尚未取回时返回 null,避免连拍踩踏。
   */
  requestPhoto(): Promise<PhotoShot | null> {
    if (this.photoRequest) return Promise.resolve(null)
    return new Promise<PhotoShot | null>((resolve) => {
      const request: NonNullable<SandboxScene['photoRequest']> = { resolve, timer: 0, restore: null }
      request.timer = window.setTimeout(() => {
        if (this.photoRequest !== request) return
        this.photoRequest = null
        resolve(null)
      }, PHOTO_TIMEOUT_MS)
      this.photoRequest = request
    })
  }

  /** 取景帧:记下原位姿,再把相机摆到云台上面 */
  private frameForCapture(request: NonNullable<SandboxScene['photoRequest']>): void {
    // 位姿必须还原 —— 否则轨道视角会被永久拽到云台位置
    request.restore = this.snapshotCamera()
    if (!this.applyGimbalPose(this.camera, this.captureTransform, this.captureZoom)) {
      // 云台还不可用(模型没载完):退回当前视角取景,至少不拍空
      this.applyZoom(this.captureZoom)
    }
    this.camera.updateMatrixWorld(true)
  }

  /** 与渲染同一任务内拷屏,然后把相机位姿还回去 */
  private finishCapture(request: NonNullable<SandboxScene['photoRequest']>): void {
    this.photoRequest = null
    window.clearTimeout(request.timer)
    const shot = this.grabCanvas()
    if (request.restore) this.restoreCamera(request.restore)
    request.resolve(shot)
  }

  /** 把当前画布内容拷进离屏 canvas(同一任务内执行,拿到的是刚渲染的那一帧) */
  private grabCanvas(): PhotoShot | null {
    const source = this.renderer.domElement
    if (!source.width || !source.height) return null
    const target = document.createElement('canvas')
    target.width = source.width
    target.height = source.height
    const context = target.getContext('2d')
    if (!context) return null
    context.drawImage(source, 0, 0)
    return { dataUrl: target.toDataURL('image/png'), width: target.width, height: target.height }
  }

  // ————————————————————————————— 屏录 —————————————————————————————

  get isRecording(): boolean {
    return this.recorder !== null
  }

  /** 开始屏录(录云台取景,与用户当前视角无关)。返回 false = 当前环境不支持 */
  startRecording(): boolean {
    if (this.recorder) return true
    const canvas = this.renderer.domElement
    if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') return false

    // 录制源用独立离屏画布:每帧只往里搬一帧云台取景,主画布上用户视角的渲染
    // 永远不会污染录制流(画布捕获按"绘制之后"抓帧,直接抓主画布会录到用户视角)。
    const recordCanvas = document.createElement('canvas')
    recordCanvas.width = canvas.width || 1
    recordCanvas.height = canvas.height || 1
    const recordContext = recordCanvas.getContext('2d')
    if (!recordContext) return false

    let recorder: MediaRecorder
    let stream: MediaStream
    try {
      // captureStream(0) = 手动抓帧:录的是什么由 render() 里搬进这张画布的云台帧决定。
      stream = recordCanvas.captureStream(0)
      const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined
      if (track && typeof track.requestFrame === 'function') {
        this.captureTrack = track
      } else {
        // 少数环境不支持手动抓帧:退回按帧率自动采样这张画布(内容仍是云台取景)
        stream.getTracks().forEach((item) => item.stop())
        stream = recordCanvas.captureStream(RECORD_FPS)
        this.captureTrack = null
      }
      const mime = pickRecordMime()
      recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: RECORD_BITRATE })
        : new MediaRecorder(stream)
    } catch {
      this.captureTrack = null
      return false
    }

    this.recordContext = recordContext
    this.recordChunks = []
    this.recordStream = stream
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.recordChunks.push(event.data)
    }
    recorder.start(RECORD_TIMESLICE_MS)
    this.recorder = recorder
    return true
  }

  /** 结束屏录并交出成片(未在录制时返回 null);落盘由调用方负责 */
  stopRecording(): Promise<Blob | null> {
    const recorder = this.recorder
    if (!recorder) return Promise.resolve(null)
    this.recorder = null
    return new Promise<Blob | null>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        const chunks = this.recordChunks
        this.recordChunks = []
        this.recordStream?.getTracks().forEach((track) => track.stop())
        this.recordStream = null
        this.captureTrack = null
        this.recordContext = null
        resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType || 'video/webm' }) : null)
      }
      // 部分环境可能不派发 onstop,兜底收尾
      const timer = window.setTimeout(finish, RECORD_STOP_TIMEOUT_MS)
      recorder.onstop = finish
      try {
        recorder.stop()
      } catch {
        finish()
      }
    })
  }

  // ————————————————————————————— 生命周期 —————————————————————————————

  private onResize(): void {
    const width = Math.max(this.container.clientWidth, 1)
    const height = Math.max(this.container.clientHeight, 1)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  dispose(): void {
    // 录像中直接收摊(页面卸载不触发下载);未取回的拍照请求也要解掉,免得调用方一直等
    if (this.recorder) {
      try {
        this.recorder.stop()
      } catch {
        /* 已经停了 */
      }
      this.recorder = null
    }
    this.recordStream?.getTracks().forEach((track) => track.stop())
    this.recordStream = null
    this.captureTrack = null
    this.recordContext = null
    this.recordChunks = []
    if (this.photoRequest) {
      window.clearTimeout(this.photoRequest.timer)
      this.photoRequest.resolve(null)
      this.photoRequest = null
    }

    this.resizeObserver.disconnect()
    this.controls.dispose()
    this.world.destroy()
    this.scene.remove(this.axes)
    this.axes.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}

export type { SceneObstacle }
