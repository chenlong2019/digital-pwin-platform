/**
 * useVehicleSimulation —— 轮式载具会话,与 useSandboxSimulation 同构。
 *
 * 为什么不直接复用同一个 composable:无人机会话里绝大部分是无人机专属逻辑
 * (云台 / 雷达 / 桨叶 / 航点任务 / 拍照录像),真正通用的只有「rAF 循环 + 快照订阅 +
 * HUD 采样」这不到 50 行。强行参数化会让每个方法里都长出 `if (是无人机)` 分支。
 *
 * 真正该共用的那部分已经抽成 session-types.ts 的 `SimulationSessionView` ——
 * 视口组件、相机模式、场景/障碍物这些都因此零改动复用,边界比把两个领域焊在一起干净。
 *
 * 三条纪律与无人机会话完全一致(README §24 / §64 / §82):
 *   ① 组件永远拿不到 Sim / Runtime / State,只能读这里暴露的只读视图
 *   ② 组件永远不直接改状态,只能调这里的方法 —— 每个都落成一条 Command
 *   ③ 渲染适配器由视口注入,仿真不知道自己在被 three 画
 */
import { onScopeDispose, ref, shallowRef } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import type {
  AgentId,
  Command,
  EnvironmentSnapshot,
  MoveCommandPayload,
  SimEvent,
  WeatherKind,
} from '@simulation/contracts'
import { PLATFORM_COMMAND } from '@simulation/contracts'
import type { Scenario } from '@simulation/sandbox-core'
import { vehicleScenario } from '@simulation/sandbox-core'
import { createVehicleSandboxSession } from '@simulation/domain-api'
import type { CameraMode } from '@simulation/three-adapter'
import { CAR_MODEL_URL, CarView } from '@simulation/three-adapter'
import type { GearPosition, VehicleLightPattern, VehicleSnapshot } from '@simulation/vehicle-agent'
import { VEHICLE_COMMAND, readVehicleTelemetry } from '@simulation/vehicle-agent'
import { scenarioToSceneObstacles } from './scene-mapping'
import type {
  RendererInfo,
  SandboxMetrics,
  SandboxRenderer,
  SimulationSessionView,
} from './session-types'

/** HUD 刷新间隔(秒)—— 仿真跑 60 Hz,界面没必要 */
const HUD_REFRESH_SECONDS = 0.1
/** 单帧最多投入的真实时间:切标签页回来时不要瞬间补几千个 tick */
const MAX_FRAME_DELTA = 0.25
/** 界面保留的日志条数 */
const LOG_WINDOW = 120

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

export interface UseVehicleSimulationOptions {
  readonly scenario?: Scenario
  readonly label?: string
  /** 构造后立即启动仿真,默认 true */
  readonly autoStart?: boolean
  readonly timeScale?: number
  /** 出厂车门全开(展示用) */
  readonly doorsOpen?: boolean
}

export interface VehicleSimulation extends SimulationSessionView {
  readonly vehicleId: AgentId
  readonly telemetry: ShallowRef<VehicleSnapshot | null>
  readonly environment: ShallowRef<EnvironmentSnapshot | null>
  readonly events: ShallowRef<ReadonlyArray<SimEvent>>
  readonly commands: ShallowRef<ReadonlyArray<Command>>

  /** 通用下发入口 —— 类型与载荷由调用方负责(内部只做形状校验) */
  sendCommand(type: string, payload?: unknown): Command | null
  /** 平台级移动:forward → 油门/倒车,right → 转向 */
  sendMove(payload: MoveCommandPayload): Command | null
  setGear(gear: GearPosition): Command | null
  setDoor(target: 'FL' | 'FR' | 'RL' | 'RR' | 'all', open: number): Command | null
  setMirror(target: 'L' | 'R' | 'all', folded: number): Command | null
  setLights(pattern: VehicleLightPattern): Command | null
  setDrive(throttle: number, brake?: number): Command | null
  resetVehicle(): Command | null
  forceBattery(percent: number): Command | null

  /** 环境 —— 与载具无关,沙盒通用能力 */
  setWind(speed: number, directionDeg: number): void
  setWeather(weather: WeatherKind): void
}

export function useVehicleSimulation(options: UseVehicleSimulationOptions = {}): VehicleSimulation {
  const scenario = options.scenario ?? vehicleScenario()

  // 会话:同一个 SimulationDomainAPI,只是装配换成轮式载具
  const session = createVehicleSandboxSession({
    scenario,
    label: options.label ?? '汽车测试沙盒',
    vehicle: { spawnDoorsOpen: options.doorsOpen ?? false },
    timeScale: options.timeScale ?? 1,
    autoStart: false,
  })

  const vehicleId = session.primaryVehicleId()
  if (vehicleId === undefined) {
    throw new Error(`场景 ${scenario.id} 里没有 type === 'vehicle' 的 Agent,无法作为汽车沙盒运行`)
  }

  // ————————————————————————————— 只读视图 —————————————————————————————

  const metrics = shallowRef<SandboxMetrics>(EMPTY_METRICS)
  const telemetry = shallowRef<VehicleSnapshot | null>(null)
  const environment = shallowRef<EnvironmentSnapshot | null>(null)
  const events = shallowRef<ReadonlyArray<SimEvent>>([])
  const commands = shallowRef<ReadonlyArray<Command>>([])
  const rendererInfo = shallowRef<RendererInfo>({ state: 'loading', modelHealth: '', parts: [] })

  const cameraMode = ref<CameraMode>('orbit')
  const obstaclesVisible = ref(true)
  const axesVisible = ref(false)

  // ————————————————————————————— 非响应式内部状态 —————————————————————————————

  let snapshot: ReturnType<typeof session.getSnapshot> | null = null
  let renderer: SandboxRenderer | null = null
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

    const agent = snapshot?.agents.find((item) => item.id === vehicleId)
    telemetry.value = readVehicleTelemetry(agent) ?? null
    environment.value = snapshot?.environment ?? null

    // 注意:.slice() 换来新引用,否则 shallowRef 看不到变化(recorder 返回的是内部活数组)
    events.value = session.getEventLog().slice(-LOG_WINDOW)
    commands.value = session.getCommandLog().slice(-LOG_WINDOW)
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
    // 页面打开即上电 —— 与无人机会话同一理由:首屏不该停在「还没上电」看起来像坏了
    session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: vehicleId, actorId: 'system' })
  }
  refreshHud()

  // ————————————————————————————— 指令 —————————————————————————————

  function sendCommand(type: string, payload?: unknown): Command | null {
    return session.executeCommand({ type, agentId: vehicleId, payload, actorId: 'driver' })
  }

  function sendMove(payload: MoveCommandPayload): Command | null {
    return sendCommand(PLATFORM_COMMAND.move, payload)
  }

  function setGear(gear: GearPosition): Command | null {
    return sendCommand(VEHICLE_COMMAND.setGear, { gear })
  }

  function setDoor(target: 'FL' | 'FR' | 'RL' | 'RR' | 'all', open: number): Command | null {
    return sendCommand(VEHICLE_COMMAND.setDoor, { target, open })
  }

  function setMirror(target: 'L' | 'R' | 'all', folded: number): Command | null {
    return sendCommand(VEHICLE_COMMAND.setMirror, { target, folded })
  }

  function setLights(pattern: VehicleLightPattern): Command | null {
    return sendCommand(VEHICLE_COMMAND.setLights, { pattern })
  }

  function setDrive(throttle: number, brake = 0): Command | null {
    return sendCommand(VEHICLE_COMMAND.setDrive, { throttle, brake })
  }

  /**
   * 整车重置。
   * 与无人机同理:内核 `reset()` 把车打回未上电,而页面打开时是自动上电的,
   * 重置后补一次上电,让状态与首屏一致。
   */
  function resetVehicle(): Command | null {
    const command = sendCommand(PLATFORM_COMMAND.reset)
    sendCommand(PLATFORM_COMMAND.powerOn)
    return command
  }

  function forceBattery(percent: number): Command | null {
    return sendCommand(VEHICLE_COMMAND.forceBattery, { percent })
  }

  // ————————————————————————————— 环境 —————————————————————————————
  // 与载具无关 —— 直接写到 Sandbox 上,不走 Command(与无人机会话同一处理)

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
    vehicleId,
    obstacles: scenarioToSceneObstacles(scenario),
    projector: session.projector,
    // 视口据此加载汽车机体;不写这一项的话它会退回默认的无人机模型
    bodyFactory: (context) => CarView.load({ ...context, url: context.url ?? CAR_MODEL_URL }),
    // 车身只有 1.44 m 高,相机注视点比无人机低一些才框得住整车
    cameraTarget: { x: 0, y: 0.9, z: 0 },

    metrics,
    telemetry,
    environment,
    events,
    commands,
    rendererInfo,

    cameraMode,
    obstaclesVisible,
    axesVisible,

    attachRenderer,
    refreshRendererInfo,
    notifyRendererError,

    toggleRun,
    start,
    pause,
    resume,
    setTimeScale,

    sendCommand,
    sendMove,
    setGear,
    setDoor,
    setMirror,
    setLights,
    setDrive,
    resetVehicle,
    forceBattery,
    setWind,
    setWeather,

    setCameraMode,
    resetCamera,
    clearTrail,
    setObstaclesVisible,
    setAxesVisible,

    dispose,
  }
}
