/**
 * 会话类型 —— 无人机会话与汽车会话**共用**的那部分。
 *
 * 抽出来的理由:视口组件(SimulationViewport)其实只关心「有没有渲染器、跑没跑、
 * 场景叫什么、投影函数是谁」这几件事,和载具无关。把这份能力定义成
 * `SimulationSessionView` 后,两种会话可以注入同一个 key,视口一行都不用改。
 *
 * 反过来,无人机专属的雷达/云台/灯光读数**不在**这里 —— 那些挂在
 * SandboxSimulation 上,由无人机自己那套面板消费。
 */
import type { Ref, ShallowRef } from 'vue'
import type {
  AgentViewProjector,
  RuntimeStatus,
  SimulationSnapshot,
  TaskId,
} from '@simulation/contracts'
import type { Scenario } from '@simulation/sandbox-core'
import type {
  BodyViewFactory,
  CameraMode,
  DroneLightsSnapshot,
  PhotoShot,
  RadarAim,
  RadarSnapshot,
  RigPartReport,
  SceneObstacle,
  SceneWire,
} from '@simulation/three-adapter'
import type { AuxLightMode, BatteryLightMode, StatusLightKey } from '@simulation/three-adapter'

/** 会话运行指标 —— 两种载具完全一致 */
export interface SandboxMetrics {
  readonly status: RuntimeStatus
  readonly tick: number
  readonly simulationTime: number
  readonly realTime: number
  readonly fps: number
  /** 本帧执行的固定步数,正常应是 1(60 Hz 固定步长下的理想值) */
  readonly stepsPerFrame: number
  /** 因为掉帧被丢弃的步数(README §75 要求这个值长期为 0) */
  readonly droppedSteps: number
  readonly timeScale: number
  readonly agents: number
  readonly tasks: number
  readonly eventsEmitted: number
  readonly trackPoints: number
}

export type RendererState = 'loading' | 'ready' | 'error'

export interface RendererInfo {
  readonly state: RendererState
  readonly modelHealth: string
  readonly parts: ReadonlyArray<RigPartReport>
}

/**
 * 视口注册进来的渲染器。契约方法之外,three-adapter 的扩展能力一律用**可选方法**描述,
 * 这样本文件不需要认识 three,换成 Cesium 适配器时这段代码一个字都不用改。
 * 也正因为都是可选的,换载具后无人机专属能力(雷达/灯光/云台)自动消失而不会报错。
 */
export interface SandboxRenderer {
  readonly isReady?: boolean
  readonly modelHealthText?: string
  updateSnapshot(snapshot: SimulationSnapshot): void
  render(deltaSeconds: number): void
  dispose(): void
  setCameraMode?(mode: CameraMode): void
  resetCamera?(): void
  clearTrail?(): void
  setObstaclesVisible?(visible: boolean): void
  setAxesVisible?(visible: boolean): void
  /** 导线等纯视觉折线的显隐(可选能力;没有导线的场景不会用到) */
  setWiresVisible?(visible: boolean): void
  getRigReport?(): ReadonlyArray<RigPartReport>
  // —— 挂载在机体上的传感器与灯光(可选能力;换成 Cesium 适配器时可以没有) ——
  getRadarSnapshot?(): RadarSnapshot
  setRadarAim?(aim: RadarAim): void
  setRadarBeamsVisible?(visible: boolean): void
  getLightsSnapshot?(): DroneLightsSnapshot | null
  setStatusLightOverride?(key: StatusLightKey | null): void
  setBatteryLightMode?(mode: BatteryLightMode): void
  setAuxLightMode?(mode: AuxLightMode): void
  setAuxBeamVisible?(visible: boolean): void
  // —— 相机(云台取景) ——
  requestPhoto?(): Promise<PhotoShot | null>
  readonly isRecording?: boolean
  startRecording?(): boolean
  stopRecording?(): Promise<Blob | null>
}

/** 录像成片:由应用层交给界面落盘(渲染层不直接触发下载) */
export interface RecordingResult {
  readonly blob: Blob
  /** 录像时长(秒),取自仿真侧的计时 */
  readonly seconds: number
}

/**
 * 行业任务插件 —— 让通用会话不必认识任何行业包(README §3.3)。
 *
 * 「那些行业包里的任务怎么创建、交付物怎么取」是使用方的知识,不该长在会话里:
 * 会话只留两个口子,页面把本行业的做法包成插件塞进来。于是同一份会话代码
 * 既能跑航点任务,也能跑电网巡检,而它一行都不认识 `grid-inspection`。
 *
 * 交付物用 `unknown`:会话只负责转交,由插件的提供方(它当然认识自己那套类型)收窄。
 */
export interface IndustryTaskPlugin {
  /** 创建一个本行业的任务;返回任务 id,失败返回 null */
  create(): TaskId | null
  /** 取任务的交付物(巡检报告之类);任务不存在时返回 null */
  artifact(taskId: TaskId, generatedAt: string): unknown
}

/**
 * 会话的**通用**能力 —— 无人机 / 汽车 / 将来的船都满足它。
 * 视口组件只依赖这个接口,所以它不需要知道页面跑的是哪种载具。
 */
export interface SimulationSessionView {
  readonly scenario: Scenario
  readonly sessionLabel: string
  readonly projector: AgentViewProjector
  readonly obstacles: ReadonlyArray<SceneObstacle>
  /**
   * 纯视觉折线(电网巡检的导线)。
   *
   * 放在通用会话而不是领域会话里,是因为视口只认「场景有哪些元素」:
   * 它把 obstacles 与 wires 一起交给渲染适配器,不需要知道这是哪个行业。
   */
  readonly wires?: ReadonlyArray<SceneWire>
  /**
   * 机体可视化工厂 —— 视口据此决定加载哪种模型。
   * 不提供 = 无人机(适配器的默认),所以无人机会话不需要写这一项。
   */
  readonly bodyFactory?: BodyViewFactory
  /** 初始相机注视点;不提供 = 视口的默认 */
  readonly cameraTarget?: { x: number; y: number; z: number }

  readonly metrics: ShallowRef<SandboxMetrics>
  readonly rendererInfo: ShallowRef<RendererInfo>

  readonly cameraMode: Ref<CameraMode>
  readonly obstaclesVisible: Ref<boolean>
  readonly axesVisible: Ref<boolean>

  attachRenderer(renderer: SandboxRenderer | null): void
  refreshRendererInfo(): void
  notifyRendererError(message: string): void

  toggleRun(): void
  start(): void
  pause(): void
  resume(): void
  setTimeScale(scale: number): void

  setCameraMode(mode: CameraMode): void
  resetCamera(): void
  clearTrail(): void
  setObstaclesVisible(visible: boolean): void
  setAxesVisible(visible: boolean): void

  dispose(): void
}
