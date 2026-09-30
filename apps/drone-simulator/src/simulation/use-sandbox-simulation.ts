/**
 * useSandboxSimulation —— 应用层与仿真平台之间**唯一**的粘合点。
 *
 * 三条纪律(README §24 / §64 / §82):
 *   ① 组件永远拿不到 Sim / Runtime / State,只能读这里暴露的只读视图
 *   ② 组件永远不直接改状态,只能调这里的方法 —— 每个都落成一条 Command
 *   ③ 渲染适配器由视口注入,仿真不知道自己在被 three 画
 *
 * 另外这里做了两件与「手感」相关的事,值得留意:
 *   · 固定 60 Hz 仿真由 rAF 驱动,但 **HUD 只以 10 Hz 刷新**。
 *     60 fps 去驱动 Vue 的响应式是纯浪费,而且会让 DevTools 根本看不过来。
 */
import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import type { ComputedRef, Ref, ShallowRef } from 'vue'
import type {
  AgentId,
  AgentViewProjector,
  Command,
  EnvironmentSnapshot,
  MoveCommandPayload,
  RuntimeStatus,
  SimEvent,
  SimulationSnapshot,
  TaskId,
  TaskResult,
  TaskSnapshot,
  WeatherKind,
} from '@simulation/contracts'
import { PLATFORM_COMMAND } from '@simulation/contracts'
import type { CameraMode, RigPartReport } from '@simulation/three-adapter'
import type {
  AuxLightMode,
  BatteryLightMode,
  DroneLightsSnapshot,
  PhotoShot,
  RadarAim,
  RadarSnapshot,
  StatusLightKey,
} from '@simulation/three-adapter'
import type { DroneSnapshot } from '@simulation/drone-agent'
import { DRONE_COMMAND, readDroneTelemetry } from '@simulation/drone-agent'
import { SimulationDomainAPI } from '@simulation/domain-api'
import type { Scenario } from '@simulation/sandbox-core'
import { defaultScenario } from '@simulation/sandbox-core'
import type { Waypoint } from '@simulation/task-core'
import { defaultWaypoints } from '@simulation/task-core'
import { scenarioToSceneObstacles } from './scene-mapping'

/** HUD 刷新间隔(秒)—— 仿真跑 60 Hz,界面没必要 */
const HUD_REFRESH_SECONDS = 0.1
/** 单帧最多投入的真实时间:切标签页回来时不要瞬间补几千个 tick */
const MAX_FRAME_DELTA = 0.25
/** 界面保留的日志条数 */
const LOG_WINDOW = 120

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

export interface UseSandboxSimulationOptions {
  readonly scenario?: Scenario
  readonly label?: string
  /** 构造后立即启动仿真,默认 true */
  readonly autoStart?: boolean
  readonly timeScale?: number
}

export interface SandboxSimulation {
  readonly scenario: Scenario
  readonly sessionLabel: string
  readonly droneId: AgentId
  readonly obstacles: ReturnType<typeof scenarioToSceneObstacles>
  /** AgentSnapshot → AgentRenderView 的投影函数,由领域包提供,视口只需转交给渲染适配器 */
  readonly projector: AgentViewProjector

  readonly metrics: ShallowRef<SandboxMetrics>
  readonly telemetry: ShallowRef<DroneSnapshot | null>
  /** 环境快照 —— 界面显示「沙盒里实际生效的值」,而不是自己刚拖的滑块 */
  readonly environment: ShallowRef<EnvironmentSnapshot | null>
  readonly task: ShallowRef<TaskSnapshot | null>
  readonly taskResult: ComputedRef<TaskResult | null>
  readonly events: ShallowRef<ReadonlyArray<SimEvent>>
  readonly commands: ShallowRef<ReadonlyArray<Command>>
  readonly rendererInfo: ShallowRef<RendererInfo>
  /** 测距雷达最新读数(前视双镜头 + 上视双孔),跟随 HUD 以 10 Hz 取自渲染器 */
  readonly radar: ShallowRef<RadarSnapshot | null>
  /** 灯光状态(灯语 / 电量灯珠 / 辅助灯),同样 10 Hz 采样 */
  readonly lights: ShallowRef<DroneLightsSnapshot | null>

  readonly cameraMode: Ref<CameraMode>
  readonly obstaclesVisible: Ref<boolean>
  readonly axesVisible: Ref<boolean>
  readonly radarAim: Ref<RadarAim>
  readonly radarBeamsVisible: Ref<boolean>
  readonly auxBeamVisible: Ref<boolean>
  readonly statusLightOverride: ShallowRef<StatusLightKey | null>

  attachRenderer(renderer: SandboxRenderer | null): void
  refreshRendererInfo(): void
  notifyRendererError(message: string): void

  toggleRun(): void
  start(): void
  pause(): void
  resume(): void
  setTimeScale(scale: number): void

  sendToDrone(type: string, payload?: unknown): Command | null
  sendMove(payload: MoveCommandPayload): Command | null
  setArmFolded(folded: boolean): Command | null
  resetDrone(): Command | null
  forceBattery(percent: number): Command | null

  /** 云台绝对俯仰(度,负 = 俯视;行程 −90°~+60°) */
  setGimbalPitch(pitch: number): Command | null
  /** 云台相对微调(度);偏航行程只有 ±5°,会自动回中 */
  nudgeGimbal(deltaPitch: number, deltaYaw?: number): Command | null
  /** 相机变焦倍数(1~4×),只在机载视角可见 */
  setCameraZoom(zoom: number): Command | null

  /** 拍一张云台取景的照片(与机载视角同一取景,含变焦);相机未就绪时返回 null */
  takePhoto(): Promise<PhotoShot | null>
  /**
   * 开始 / 停止录像;返回 false = 当前环境不支持录像。
   *
   * 顺序是「先问渲染层能不能录,再落领域层的录像状态」—— 反过来的话,
   * 浏览器不支持 MediaRecorder 时会出现「界面说在录、其实一帧都没录」。
   */
  toggleRecording(): Promise<boolean>
  /** 注册成片回调:停止录像时把成片交给界面落盘(渲染层不直接触发下载) */
  setRecordingReadyHandler(handler: ((result: RecordingResult) => void) | null): void

  createWaypointTask(waypoints?: ReadonlyArray<Waypoint>): TaskId | null
  startTask(): Command | null
  pauseTask(): Command | null
  resumeTask(): Command | null
  abortTask(): Command | null

  setWind(speed: number, directionDeg: number): void
  setWeather(weather: WeatherKind): void

  setCameraMode(mode: CameraMode): void
  resetCamera(): void
  clearTrail(): void
  setObstaclesVisible(visible: boolean): void
  setAxesVisible(visible: boolean): void

  setRadarAim(aim: RadarAim): void
  setRadarBeamsVisible(visible: boolean): void
  setAuxBeamVisible(visible: boolean): void
  setStatusLightOverride(key: StatusLightKey | null): void
  setBatteryLightMode(mode: BatteryLightMode): void
  setAuxLightMode(mode: AuxLightMode): void

  dispose(): void
}

const EMPTY_METRICS: SandboxMetrics = {
  status: 'idle',
  tick: 0,
  simulationTime: 0,
  realTime: 0,
  fps: 0,
  stepsPerFrame: 0,
  droppedSteps: 0,
  timeScale: 1,
  agents: 0,
  tasks: 0,
  eventsEmitted: 0,
  trackPoints: 0,
}

export function useSandboxSimulation(options: UseSandboxSimulationOptions = {}): SandboxSimulation {
  const scenario = options.scenario ?? defaultScenario()

  // ① 会话:唯一入口。注意 factoryFolded: false —— 机臂出厂已展开,
  //    这样「一键起飞」不会被检查单挡住;机臂折叠仍可用下方按钮复现。
  const session = new SimulationDomainAPI({
    scenario,
    label: options.label ?? '无人机测试沙盒',
    drone: { factoryFolded: false },
    timeScale: options.timeScale ?? 1,
    autoStart: false,
  })

  const droneId = session.primaryDroneId()
  if (droneId === undefined) {
    throw new Error(`场景 ${scenario.id} 里没有 type === 'drone' 的 Agent,无法作为无人机沙盒运行`)
  }

  // ————————————————————————————— 只读视图 —————————————————————————————

  const metrics = shallowRef<SandboxMetrics>(EMPTY_METRICS)
  const telemetry = shallowRef<DroneSnapshot | null>(null)
  const environment = shallowRef<EnvironmentSnapshot | null>(null)
  const task = shallowRef<TaskSnapshot | null>(null)
  const events = shallowRef<ReadonlyArray<SimEvent>>([])
  const commands = shallowRef<ReadonlyArray<Command>>([])
  const rendererInfo = shallowRef<RendererInfo>({ state: 'loading', modelHealth: '', parts: [] })
  const radar = shallowRef<RadarSnapshot | null>(null)
  const lights = shallowRef<DroneLightsSnapshot | null>(null)

  const cameraMode = ref<CameraMode>('orbit')
  const obstaclesVisible = ref(true)
  const axesVisible = ref(false)
  const radarAim = ref<RadarAim>('forward')
  const radarBeamsVisible = ref(false)
  const auxBeamVisible = ref(false)
  const statusLightOverride = shallowRef<StatusLightKey | null>(null)

  const taskResult = computed<TaskResult | null>(() => task.value?.result ?? null)

  // ————————————————————————————— 非响应式内部状态 —————————————————————————————

  let snapshot: SimulationSnapshot | null = null
  let renderer: SandboxRenderer | null = null
  /** 上一次 HUD 采样时领域层是否在录像:用来识别"领域层自己把录像停了" */
  let domainWasRecording = false
  let activeTaskId: TaskId | null = null
  let frameId = 0
  let lastFrameTime = 0
  let hudAccumulator = HUD_REFRESH_SECONDS
  let smoothedFps = 0
  let stepsThisFrame = 0
  let disposed = false

  const detachSnapshot = session.onSnapshot((next) => {
    snapshot = next
    renderer?.updateSnapshot(next)
  })

  function refreshHud(): void {
    const stats = session.stats
    const recorderStats = session.recorderStats

    metrics.value = {
      status: stats.status,
      tick: stats.ticks,
      simulationTime: stats.simulationTime,
      realTime: stats.realTime,
      fps: Math.round(smoothedFps),
      stepsPerFrame: stepsThisFrame,
      droppedSteps: stats.droppedSteps,
      timeScale: stats.timeScale,
      agents: stats.agents,
      tasks: stats.tasks,
      eventsEmitted: stats.eventsEmitted,
      trackPoints: recorderStats.samples,
    }

    const agent = snapshot?.agents.find((item) => item.id === droneId)
    telemetry.value = readDroneTelemetry(agent) ?? null
    environment.value = snapshot?.environment ?? null

    // 录像对账:录像的**状态**在领域层,录制器却在渲染层。领域层会自己把录像停掉
    // (返航降落后的自动收尾、重置等),这时必须补一次收尾 —— 否则界面显示"录像已结束",
    // 而渲染层的录制器还在录,成片永远拿不到(这正是"返航后录像没保存")。
    //
    // 判据必须是"领域层**从在录变成没录**",而不是"渲染层在录但领域层没录":
    // 命令要下一 tick 才生效,点下开始录像的那一瞬间正好就是后者,那样会把刚开
    // 的录像立刻掐掉。正常手动停止走 toggleRecording()(录制器先停),也不会命中。
    const domainRecording = telemetry.value?.recording ?? false
    if (renderer?.isRecording && domainWasRecording && !domainRecording) {
      // 领域层停止时不清零计时,这里取到的就是最终时长
      const seconds = telemetry.value?.recordSeconds ?? 0
      void renderer.stopRecording?.().then((blob) => {
        if (blob) recordingReadyHandler?.({ blob, seconds })
      })
    }
    domainWasRecording = domainRecording

    const tasks = snapshot?.tasks ?? []
    task.value = tasks.find((item) => item.id === activeTaskId) ?? tasks[0] ?? null

    // 注意:.slice() 换来新引用,否则 shallowRef 看不到变化(recorder 返回的是内部活数组)
    events.value = session.getEventLog().slice(-LOG_WINDOW)
    commands.value = session.getCommandLog().slice(-LOG_WINDOW)

    // 传感器与灯光:读数只存在于渲染器里(它们挂在机体模型上),所以在这里采样,
    // 频率跟 HUD 一致(10 Hz)—— 旧项目就是 100ms 轮询,没必要每帧刷 Vue。
    radar.value = renderer?.getRadarSnapshot?.() ?? null
    lights.value = renderer?.getLightsSnapshot?.() ?? null
  }

  function frame(timestamp: number): void {
    frameId = window.requestAnimationFrame(frame)
    const delta = lastFrameTime === 0 ? 0 : Math.min((timestamp - lastFrameTime) / 1000, MAX_FRAME_DELTA)
    lastFrameTime = timestamp

    if (delta > 0) smoothedFps = smoothedFps === 0 ? 1 / delta : smoothedFps * 0.9 + (1 / delta) * 0.1

    // 仿真推进(暂停时返回 0)与渲染分开:暂停后画面仍可自由环视
    stepsThisFrame = session.advance(delta)
    renderer?.render(delta)

    hudAccumulator += delta
    if (hudAccumulator >= HUD_REFRESH_SECONDS) {
      hudAccumulator = 0
      refreshHud()
    }
  }

  function ensureLoop(): void {
    if (frameId !== 0 || disposed) return
    lastFrameTime = 0
    frameId = window.requestAnimationFrame(frame)
  }

  ensureLoop()
  if (options.autoStart !== false) {
    session.start()
    // 页面打开即上电。
    // 真机流程是「展开机臂 → 开机自检 → 预热搜星 → 起飞」,这里已经把「展开机臂」
    // 免掉了(见上面 factoryFolded),如果连开机也要手点一次,首屏就会停在
    // 「未上电 + 一键起飞不可用」,看起来像坏了。自动上电后首屏能直接起飞,
    // 而自检 → 预热 → 搜星的灯语序列仍然完整播一遍。
    // 「关机 / 开机自检」两个按钮保留,用来手动回放这套序列。
    session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId, actorId: 'system' })
  }
  refreshHud()

  // ————————————————————————————— 指令 —————————————————————————————

  function sendToDrone(type: string, payload?: unknown): Command | null {
    return session.executeCommand({ type, agentId: droneId, payload, actorId: 'pilot' })
  }

  function sendMove(payload: MoveCommandPayload): Command | null {
    return sendToDrone(PLATFORM_COMMAND.move, payload)
  }

  function setArmFolded(folded: boolean): Command | null {
    return sendToDrone(DRONE_COMMAND.setArmFold, { fold: folded ? 1 : 0 })
  }

  /**
   * 整体重置。
   * 内核的 `reset()` 会把机体打回「未上电」(真机复位就是这样),
   * 但页面打开时是自动上电的,重置后如果不上电,一键起飞又会变灰。
   * 所以这里补一次上电,让重置后的状态与首屏一致。
   */
  function resetDrone(): Command | null {
    const command = sendToDrone(PLATFORM_COMMAND.reset)
    sendToDrone(PLATFORM_COMMAND.powerOn)
    return command
  }

  function forceBattery(percent: number): Command | null {
    return sendToDrone(DRONE_COMMAND.forceBattery, { percent })
  }

  // ————————————————————————————— 云台与相机 —————————————————————————————
  //
  // 云台姿态与变焦都是**设备状态**(存在 Agent 身上,不在界面上),所以一律走 Command;
  // 界面只读快照回显。这样拖滑杆、按快捷键、AI 调用改云台的效果完全一致 ——
  // 而且是可回放、可审计的(指令日志里会留下每一条)。

  function setGimbalPitch(pitch: number): Command | null {
    return sendToDrone(DRONE_COMMAND.setGimbalPitch, { pitch })
  }

  function nudgeGimbal(deltaPitch: number, deltaYaw = 0): Command | null {
    return sendToDrone(DRONE_COMMAND.nudgeGimbal, { deltaPitch, deltaYaw })
  }

  function setCameraZoom(zoom: number): Command | null {
    return sendToDrone(DRONE_COMMAND.setZoom, { zoom })
  }

  // ————————————————————————————— 相机:拍照与录像 —————————————————————————————
  //
  // 取景在渲染层(那是相机的画法),但**状态**在领域层(snapshot 的 recording / photoCount)。
  // 所以这里两件事都要做:先确认渲染层有对应的能力,再把状态交给命令 ——
  // 两边都成功才算数,否则界面会显示一个不存在的状态。

  let recordingReadyHandler: ((result: RecordingResult) => void) | null = null

  async function takePhoto(): Promise<PhotoShot | null> {
    const shot = (await renderer?.requestPhoto?.()) ?? null
    // 只有真拿到照片才计入领域层:计数器 +1、写一条事件
    if (shot) {
      sendToDrone(DRONE_COMMAND.takePhoto)
      refreshHud()
    }
    return shot
  }

  async function toggleRecording(): Promise<boolean> {
    if (telemetry.value?.recording) {
      // 先取时长再停:领域层的收尾(重置计时)发生在命令下发之后
      const seconds = telemetry.value.recordSeconds
      const blob = (await renderer?.stopRecording?.()) ?? null
      sendToDrone(DRONE_COMMAND.toggleRecording)
      if (blob) recordingReadyHandler?.({ blob, seconds })
      refreshHud()
      return true
    }
    if (!(renderer?.startRecording?.() ?? false)) return false
    sendToDrone(DRONE_COMMAND.toggleRecording)
    refreshHud()
    return true
  }

  function setRecordingReadyHandler(handler: ((result: RecordingResult) => void) | null): void {
    recordingReadyHandler = handler
  }

  // ————————————————————————————— 任务 —————————————————————————————

  function createWaypointTask(waypoints?: ReadonlyArray<Waypoint>): TaskId | null {
    const id = session.createWaypointTask({
      agentId: droneId,
      label: `航点任务 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
      waypoints: waypoints ?? defaultWaypoints(),
      holdSeconds: 2,
      landAtEnd: true,
    })
    activeTaskId = id
    refreshHud()
    return id
  }

  function currentTaskId(): TaskId | null {
    return activeTaskId ?? session.getTaskSnapshots()[0]?.id ?? null
  }

  function startTask(): Command | null {
    const id = currentTaskId()
    return id === null ? null : session.startTask(id)
  }

  function pauseTask(): Command | null {
    const id = currentTaskId()
    return id === null ? null : session.pauseTask(id)
  }

  function resumeTask(): Command | null {
    const id = currentTaskId()
    return id === null ? null : session.resumeTask(id)
  }

  function abortTask(): Command | null {
    const id = currentTaskId()
    return id === null ? null : session.abortTask(id, '操作员中止')
  }

  // ————————————————————————————— 环境 —————————————————————————————

  function setWind(speed: number, directionDeg: number): void {
    session.setWind(speed, directionDeg)
  }

  function setWeather(weather: WeatherKind): void {
    session.setWeather(weather)
  }

  // ————————————————————————————— 视图 —————————————————————————————

  function applyViewOptions(): void {
    renderer?.setCameraMode?.(cameraMode.value)
    renderer?.setObstaclesVisible?.(obstaclesVisible.value)
    renderer?.setAxesVisible?.(axesVisible.value)
    renderer?.setRadarAim?.(radarAim.value)
    renderer?.setRadarBeamsVisible?.(radarBeamsVisible.value)
    renderer?.setAuxBeamVisible?.(auxBeamVisible.value)
    renderer?.setStatusLightOverride?.(statusLightOverride.value)
  }

  function attachRenderer(next: SandboxRenderer | null): void {
    renderer = next
    if (!next) return
    applyViewOptions()
    if (snapshot) next.updateSnapshot(snapshot)
    refreshRendererInfo()
  }

  function refreshRendererInfo(): void {
    if (!renderer) {
      rendererInfo.value = { state: 'loading', modelHealth: '', parts: [] }
      return
    }
    rendererInfo.value = {
      state: renderer.isReady ? 'ready' : 'loading',
      modelHealth: renderer.modelHealthText ?? '',
      parts: renderer.getRigReport?.() ?? [],
    }
  }

  function notifyRendererError(message: string): void {
    rendererInfo.value = { state: 'error', modelHealth: message, parts: [] }
  }

  function setCameraMode(mode: CameraMode): void {
    cameraMode.value = mode
    renderer?.setCameraMode?.(mode)
  }

  function resetCamera(): void {
    renderer?.resetCamera?.()
  }

  function clearTrail(): void {
    renderer?.clearTrail?.()
  }

  function setObstaclesVisible(visible: boolean): void {
    obstaclesVisible.value = visible
    renderer?.setObstaclesVisible?.(visible)
  }

  function setAxesVisible(visible: boolean): void {
    axesVisible.value = visible
    renderer?.setAxesVisible?.(visible)
  }

  // ————————————————————————————— 传感器与灯光 —————————————————————————————

  function setRadarAim(aim: RadarAim): void {
    radarAim.value = aim
    renderer?.setRadarAim?.(aim)
    refreshHud()
  }

  function setRadarBeamsVisible(visible: boolean): void {
    radarBeamsVisible.value = visible
    renderer?.setRadarBeamsVisible?.(visible)
  }

  function setAuxBeamVisible(visible: boolean): void {
    auxBeamVisible.value = visible
    renderer?.setAuxBeamVisible?.(visible)
  }

  /** 手动锁定灯语(null = 交还给飞行状态) */
  function setStatusLightOverride(key: StatusLightKey | null): void {
    statusLightOverride.value = key
    renderer?.setStatusLightOverride?.(key)
    refreshHud()
  }

  function setBatteryLightMode(mode: BatteryLightMode): void {
    renderer?.setBatteryLightMode?.(mode)
    refreshHud()
  }

  function setAuxLightMode(mode: AuxLightMode): void {
    renderer?.setAuxLightMode?.(mode)
    refreshHud()
  }

  // ————————————————————————————— 生命周期 —————————————————————————————

  function start(): void {
    session.start()
    refreshHud()
  }

  function pause(): void {
    session.pause()
    refreshHud()
  }

  function resume(): void {
    session.resume()
    refreshHud()
  }

  function toggleRun(): void {
    if (session.isRunning) pause()
    else if (session.status === 'paused') resume()
    else start()
  }

  function setTimeScale(scale: number): void {
    session.setTimeScale(scale)
    refreshHud()
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (frameId !== 0) window.cancelAnimationFrame(frameId)
    frameId = 0
    detachSnapshot()
    renderer = null
    session.dispose()
  }

  onScopeDispose(dispose)

  return {
    scenario,
    sessionLabel: session.session.label,
    droneId,
    obstacles: scenarioToSceneObstacles(scenario),
    projector: session.projector,

    metrics,
    telemetry,
    environment,
    task,
    taskResult,
    events,
    commands,
    rendererInfo,
    radar,
    lights,

    cameraMode,
    obstaclesVisible,
    axesVisible,
    radarAim,
    radarBeamsVisible,
    auxBeamVisible,
    statusLightOverride,

    attachRenderer,
    refreshRendererInfo,
    notifyRendererError,

    toggleRun,
    start,
    pause,
    resume,
    setTimeScale,

    sendToDrone,
    sendMove,
    setArmFolded,
    resetDrone,
    forceBattery,

    setGimbalPitch,
    nudgeGimbal,
    setCameraZoom,
    takePhoto,
    toggleRecording,
    setRecordingReadyHandler,

    createWaypointTask,
    startTask,
    pauseTask,
    resumeTask,
    abortTask,

    setWind,
    setWeather,

    setCameraMode,
    resetCamera,
    clearTrail,
    setObstaclesVisible,
    setAxesVisible,

    setRadarAim,
    setRadarBeamsVisible,
    setAuxBeamVisible,
    setStatusLightOverride,
    setBatteryLightMode,
    setAuxLightMode,

    dispose,
  }
}
