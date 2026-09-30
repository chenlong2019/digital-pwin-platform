/**
 * ThreeRenderAdapter —— 实现平台 RenderAdapter 契约(README §64)。
 *
 * 数据流严格单向:
 *   SimulationSnapshot → (project: 应用层注入的投影函数) → AgentRenderView → 三维场景
 *
 * 适配器本身不认识任何领域遥测,所以:
 *   · 换渲染器(Cesium)不影响仿真
 *   · 换领域(车/船/机器人)不影响渲染,只要提供新的投影函数
 *
 * 挂载在机体上的三个「设备」在这里接线:
 *   · DroneRig    机臂 / 桨叶 / 云台   —— 位姿与机械状态
 *   · DroneLights 状态灯 / 电量灯 / 辅助灯 —— 灯语由领域层给定,这里只画
 *   · DroneRadar  前视双镜头 + 上视双孔 —— 视场检测,只读读数不影响飞控
 * 三者的读数都是「传感器测量」,与仿真内核的 AABB 避障各自独立。
 *
 * 单机限制:当前只驱动一个机体模型。「简单场景」阶段够用;
 * 多 Agent 需要把 DroneView 改成实例池,契约无需改动。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type {
  AgentId,
  AgentRenderView,
  AgentViewProjector,
  EnvironmentSnapshot,
  RenderAdapter,
  RenderSelection,
  SimulationSnapshot,
} from '@simulation/contracts'
import type { RigPartReport } from './drone-rig'
import type { DroneLightsSnapshot, StatusLightKey } from './drone-lights'
import type { BatteryLightMode, AuxLightMode } from './drone-lights'
import type { RadarAim, RadarSnapshot } from './drone-radar'
import { DroneRadar } from './drone-radar'
import type { CameraMode, PhotoShot, SceneObstacle } from './sandbox-scene'
import { CAMERA_MODE_LIST, SandboxScene } from './sandbox-scene'
import type { DroneViewOptions } from './drone-view'
import { DroneView } from './drone-view'

export interface ThreeRenderAdapterOptions {
  readonly container: HTMLElement
  /** 应用层注入:把通用 AgentSnapshot 投影成渲染视图 */
  readonly project: AgentViewProjector
  readonly model?: DroneViewOptions
  readonly obstacles?: ReadonlyArray<SceneObstacle>
  readonly background?: string
  readonly initialCameraTarget?: { x: number; y: number; z: number }
}

export class ThreeRenderAdapter implements RenderAdapter {
  private readonly options: ThreeRenderAdapterOptions
  private readonly loader = new GLTFLoader()
  private readonly views = new Map<AgentId, AgentRenderView>()
  private readonly gimbalScratch = new THREE.Object3D()
  private sandboxScene: SandboxScene | null = null
  private drone: DroneView | null = null
  private radar: DroneRadar | null = null
  private environment: EnvironmentSnapshot | null = null
  private selected: ReadonlyArray<AgentId> = []
  private loadError: unknown = null
  /** 雷达射线可视化开关:雷达实例可能晚于页面初始化创建,先缓存再补上;默认不显示 */
  private radarBeamsVisible = false

  constructor(options: ThreeRenderAdapterOptions) {
    this.options = options
  }

  get isReady(): boolean {
    return this.sandboxScene !== null && this.drone !== null
  }

  get error(): unknown {
    return this.loadError
  }

  get scene(): SandboxScene | null {
    return this.sandboxScene
  }

  get environmentSnapshot(): EnvironmentSnapshot | null {
    return this.environment
  }

  get selection(): ReadonlyArray<AgentId> {
    return this.selected
  }

  async initialize(): Promise<void> {
    const scene = new SandboxScene({
      container: this.options.container,
      obstacles: this.options.obstacles,
      background: this.options.background,
    })
    this.sandboxScene = scene
    const target = this.options.initialCameraTarget
    scene.resetCamera(target?.x ?? 0, target?.y ?? 1.2, target?.z ?? 0)

    try {
      const drone = await DroneView.load(this.loader, scene.scene, this.options.model ?? {})
      this.drone = drone
      scene.scene.add(drone.model)
      scene.setHome(0, 0)

      // 前视测距雷达:起点/方向取自模型自带的前向视觉玻璃节点,上电后工作
      const radar = new DroneRadar(scene.scene)
      radar.bindSensors(drone.model)
      radar.setVisible(this.radarBeamsVisible)
      this.radar = radar
    } catch (error) {
      // 模型载不进来也不该让整个沙盒挂掉:场景仍可交互,只报错
      this.loadError = error
      console.error('[three-adapter] 无人机模型载入失败,场景继续可用', error)
    }
  }

  updateSnapshot(snapshot: SimulationSnapshot): void {
    this.environment = snapshot.environment
    this.views.clear()
    for (const agent of snapshot.agents) {
      const view = this.options.project(agent)
      if (view) this.views.set(view.agentId, view)
    }
  }

  updateSelection(selection: RenderSelection): void {
    this.selected = selection.agentIds
  }

  render(deltaSeconds: number): void {
    const scene = this.sandboxScene
    if (!scene) return

    const view = this.primaryView()
    if (view) {
      this.drone?.apply(view, deltaSeconds)
      scene.setShadowFocus(view.pose.x, view.pose.z)
      scene.pushTrail(view.pose.x, (this.drone?.groundOffsetY ?? 0) + view.pose.y, view.pose.z)
    }

    // 测距雷达:视场随机体姿态转动,读数是「传感器测量」,与飞控避障互不影响
    if (this.radar && this.drone) {
      this.radar.update(this.drone.model, scene.world, deltaSeconds, view?.powered === true)
    }

    // 云台变换每帧都取,不再只给机载视角用 —— 机载取景、拍照、录像三处共用同一份:
    // 真机只有一个云台相机,所以拍照与录像在任何视角下都必须是云台拍的
    // (旧项目 firstapp 的 onBeforeRender 就是无条件把相机摆到云台上的)
    const gimbalReady = this.drone?.getGimbalTransform(this.gimbalScratch) === true
    scene.updateCamera({
      x: view?.pose.x ?? 0,
      y: (this.drone?.groundOffsetY ?? 0) + (view?.pose.y ?? 0),
      z: view?.pose.z ?? 0,
      headingDeg: view?.pose.headingDeg ?? 0,
      deltaSeconds,
      gimbalTransform: gimbalReady ? this.gimbalScratch : null,
      // 设备变焦由领域层给(快照里的 cameraZoom),渲染层不自己记这个状态
      zoom: view?.rig?.cameraZoom ?? 1,
    })
    scene.render()
  }

  /** 按 agentId 排序取第一个,保证多 Agent 时渲染目标确定 */
  private primaryView(): AgentRenderView | null {
    let best: AgentRenderView | null = null
    for (const view of this.views.values()) {
      if (!best || view.agentId < best.agentId) best = view
    }
    return best
  }

  // ————————————————————————————— 视图便捷方法 —————————————————————————————

  setCameraMode(mode: CameraMode): void {
    this.sandboxScene?.setCameraMode(mode)
  }

  getCameraMode(): CameraMode {
    return this.sandboxScene?.cameraMode ?? 'orbit'
  }

  resetCamera(): void {
    const view = this.primaryView()
    this.sandboxScene?.resetCamera(
      view?.pose.x ?? 0,
      (this.drone?.groundOffsetY ?? 0) + (view?.pose.y ?? 0),
      view?.pose.z ?? 0,
    )
  }

  clearTrail(): void {
    this.sandboxScene?.clearTrail()
  }

  // ————————————————————————————— 拍照与屏录 —————————————————————————————

  /** 拍一张云台取景的照片(与机载视角同一取景,含变焦) */
  requestPhoto(): Promise<PhotoShot | null> {
    return this.sandboxScene?.requestPhoto() ?? Promise.resolve(null)
  }

  get isRecording(): boolean {
    return this.sandboxScene?.isRecording ?? false
  }

  /** 开始屏录;返回 false = 当前环境不支持 */
  startRecording(): boolean {
    return this.sandboxScene?.startRecording() ?? false
  }

  /** 结束屏录并交出成片(webm Blob);落盘由应用层负责 */
  stopRecording(): Promise<Blob | null> {
    return this.sandboxScene?.stopRecording() ?? Promise.resolve(null)
  }

  setObstaclesVisible(visible: boolean): void {
    this.sandboxScene?.setObstaclesVisible(visible)
  }

  setAxesVisible(visible: boolean): void {
    this.sandboxScene?.setAxesVisible(visible)
  }

  // ————————————————————————————— 测距雷达 —————————————————————————————

  /** 最新读数:前视双镜头 + 上视双孔。未载入模型时给一份「未探测」的快照。 */
  getRadarSnapshot(): RadarSnapshot {
    return (
      this.radar?.getSnapshot() ?? {
        detecting: false,
        left: null,
        right: null,
        range: 18,
        upLeft: null,
        upRight: null,
        upRange: 15,
        aim: this.radarAimFallback,
      }
    )
  }

  private radarAimFallback: RadarAim = 'forward'

  /** 切换镜头瞄准:forward = 转向正前方/正上方;sensor = 沿镜头(玻璃面)朝向 */
  setRadarAim(aim: RadarAim): void {
    this.radarAimFallback = aim
    this.radar?.setAim(aim)
  }

  /** 切换雷达射线可视化(前视 + 上视,读数不受影响) */
  setRadarBeamsVisible(visible: boolean): void {
    this.radarBeamsVisible = visible
    this.radar?.setVisible(visible)
  }

  isRadarBeamsVisible(): boolean {
    return this.radar?.isBeamsVisible() ?? this.radarBeamsVisible
  }

  get radarBound(): boolean {
    return this.radar?.isBoundToSensors() ?? false
  }

  // ————————————————————————————— 灯光 —————————————————————————————

  getLightsSnapshot(): DroneLightsSnapshot | null {
    return this.drone?.getLightsSnapshot() ?? null
  }

  /** 手动锁定灯语(null = 交还给飞行状态) */
  setStatusLightOverride(key: StatusLightKey | null): void {
    this.drone?.setStatusLightOverride(key)
  }

  get statusLightOverride(): StatusLightKey | null {
    return this.drone?.statusLightOverride ?? null
  }

  setBatteryLightMode(mode: BatteryLightMode): void {
    this.drone?.setBatteryLightMode(mode)
  }

  setAuxLightMode(mode: AuxLightMode): void {
    this.drone?.setAuxLightMode(mode)
  }

  /** 切换底部辅助灯的锥形光束显隐(不影响辅助灯照明) */
  setAuxBeamVisible(visible: boolean): void {
    this.drone?.setAuxBeamVisible(visible)
  }

  isAuxBeamVisible(): boolean {
    return this.drone?.lights.isBeamVisible() ?? false
  }

  // ————————————————————————————— 模型自检 —————————————————————————————

  getRigReport(): ReadonlyArray<RigPartReport> {
    return this.drone?.getRigReport() ?? []
  }

  get modelHealthText(): string {
    return this.drone?.modelHealthText ?? '模型尚未载入'
  }

  dispose(): void {
    this.radar?.destroy()
    this.radar = null
    this.drone?.dispose()
    this.drone = null
    this.sandboxScene?.dispose()
    this.sandboxScene = null
    this.views.clear()
    this.environment = null
    this.selected = []
  }
}

export { CAMERA_MODE_LIST }
export type { CameraMode, PhotoShot, SceneObstacle }
