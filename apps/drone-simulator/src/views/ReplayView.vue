<script setup lang="ts">
/**
 * ReplayView —— 飞行回放与数据看板(README §22 · §58 · §77)。
 *
 * 这个页面**不跑仿真**。它消费沙盒页抓下来的一份记录快照,在采样点之间插值
 * 重建位姿 —— 所以放出来的画面与当初看到的一致(§77),而不是「同 seed 再跑一遍」
 * 那种近似重现。原始会话早关了也不影响。
 *
 * 复用边界值得记一笔:三维部分就是沙盒页那一整套 ThreeRenderAdapter + DroneView + 场景。
 * 唯一换掉的是「快照从哪来」—— 实时仿真换成 ReplayController。于是环视、跟随、
 * 机载三种镜头和轨迹线一行都没改,回放照样能用。
 *
 * 能力边界也写在这里(免得看画面的人误会):记录器只采位置与航向,
 * 所以回放**只还原位姿** —— 机臂保持展开、灯是灭的,那些状态当初没被记下来。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import type { TaskResult, TaskSnapshot } from '@simulation/contracts'
import { CAMERA_MODE_LIST, DroneView, ThreeRenderAdapter } from '@simulation/three-adapter'
import type { CameraMode } from '@simulation/three-adapter'
import {
  ReplayController,
  buildReplaySeries,
  primaryTrack,
  projectReplayAgent,
  replayToRenderSnapshot,
  summarizePoints,
} from '@simulation/replay'
import type { ReplaySnapshot } from '@simulation/replay'
import { buildTaskResult, exportTaskResult, summarizeTaskResult } from '@simulation/result'
import type { ResultFormat, TaskResultReport } from '@simulation/result'
import { useReplayStore } from '../simulation/replay-store'
import { scenarioToSceneObstacles } from '../simulation/scene-mapping'
import { downloadBlob, timestampTag } from '../utils/download'
import { formatClock, formatHeading, formatMeters, formatNumber, formatSpeed } from '../utils/format'

/** HUD 采样间隔 —— 与沙盒页一致,10 Hz 足够看,不必每帧刷 Vue */
const HUD_SECONDS = 0.1
/** 单帧最多推进多少秒,防止切回标签页时一次跳一大段 */
const MAX_FRAME_DELTA = 0.25

/** 曲线画布。用 viewBox 归一化,外层靠 CSS 拉伸 */
const CHART_W = 320
const CHART_H = 84
/** 折线最多画多少段 —— 两万个点直接塞进 SVG 会卡,降采样后肉眼看不出差别 */
const CHART_POINTS = 180
/** 事件列表最多显示多少条 */
const EVENT_WINDOW = 40

const { latest } = useReplayStore()
const entry = computed(() => latest.value)

// ————————————————————————————— 派生数据(全是纯函数产物) —————————————————————————————

const track = computed(() => (entry.value ? primaryTrack(entry.value.data) : null))
const points = computed(() => track.value?.points ?? [])
const series = computed(() => buildReplaySeries(points.value))

const statistics = computed(() => {
  const current = entry.value
  if (!current) return null
  return summarizePoints(points.value, current.data.events, current.data.commands)
})

/**
 * 复盘报告。
 *
 * 有任务快照就用真的(保存那一刻抓的),没有就合成一个「回放」任务 ——
 * 两种情况下统计都来自同一批记录数据,所以数字口径一致。
 */
const report = computed<TaskResultReport | null>(() => {
  const current = entry.value
  if (!current) return null

  const task: TaskSnapshot = current.task ?? {
    id: current.data.sessionId,
    type: 'replay',
    label: `${current.data.label} · 回放`,
    status: 'completed',
    agentId: track.value?.agentId ?? null,
    progress: { completed: 1, total: 1, stage: '历史回放' },
    result: null,
  }
  const outcome: TaskResult = current.taskResult ?? {
    taskId: task.id,
    status: 'completed',
    duration: statistics.value?.duration ?? current.data.duration,
    metrics: {},
    message: '历史回放:指标由记录数据算出',
  }

  return buildTaskResult({
    task,
    outcome,
    tracks: current.data.tracks,
    events: current.data.events,
    commands: current.data.commands,
    sampleHz: current.data.sampleHz,
  })
})

const summary = computed(() => (report.value ? summarizeTaskResult(report.value) : null))

const savedAtText = computed(() => {
  const current = entry.value
  if (!current) return ''
  return new Date(current.savedAt).toLocaleString('zh-CN', { hour12: false })
})

// ————————————————————————————— 回放状态 —————————————————————————————

const container = ref<HTMLDivElement | null>(null)
const view = shallowRef<ReplaySnapshot | null>(null)
const playing = ref(false)
const speed = ref(1)
const currentTime = ref(0)
const progress = ref(0)
const cameraMode = ref<CameraMode>('orbit')
const modelHealth = ref('')

const SPEEDS = [0.5, 1, 2, 4]

let adapter: ThreeRenderAdapter | null = null
let controller: ReplayController | null = null
let frameId = 0
let lastFrameTime = 0
let hudAccumulator = HUD_SECONDS
let disposed = false

const duration = computed(() => entry.value?.data.duration ?? 0)

/** 到当前时刻为止发生的事件,最近的在上 */
const visibleEvents = computed(() => {
  const list = view.value?.events ?? []
  return list.slice(-EVENT_WINDOW).reverse()
})

const statCards = computed(() => {
  const stats = statistics.value
  if (!stats) return []
  return [
    { label: '总时长', value: formatClock(stats.duration) },
    { label: '航程', value: formatMeters(stats.distanceFlown) },
    { label: '最高', value: formatMeters(stats.maxAltitude) },
    { label: '最低', value: formatMeters(stats.minAltitude) },
    { label: '最大水平速度', value: formatSpeed(stats.maxSpeed) },
    { label: '最大下降率', value: formatSpeed(stats.maxDescentRate) },
    { label: '事件 / 指令', value: `${stats.events} / ${stats.commands}` },
    { label: '采样点', value: `${stats.points}` },
  ]
})

// ————————————————————————————— 曲线 —————————————————————————————

/** 等距抽稀,首末一定保留 */
function downsample<T>(items: ReadonlyArray<T>, limit: number): T[] {
  if (items.length <= limit) return [...items]
  const step = (items.length - 1) / (limit - 1)
  const picked: T[] = []
  for (let i = 0; i < limit; i += 1) {
    const item = items[Math.round(i * step)]
    if (item !== undefined) picked.push(item)
  }
  return picked
}

/**
 * 折线点串。
 * 峰值做分母;峰值为 0(整段没动)时用 1 兜底,免得除以零后所有点都跑到正无穷。
 */
function polyline(values: ReadonlyArray<number>, peak: number): string {
  if (values.length === 0) return ''
  const scaleX = values.length > 1 ? CHART_W / (values.length - 1) : 0
  const ceiling = peak > 0 ? peak : 1
  return values
    .map((value, index) => {
      const x = index * scaleX
      const y = CHART_H - (Math.max(0, value) / ceiling) * CHART_H
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

const altitudeLine = computed(() =>
  polyline(downsample(series.value.map((item) => item.altitude), CHART_POINTS), statistics.value?.maxAltitude ?? 0),
)

const speedLine = computed(() =>
  polyline(downsample(series.value.map((item) => item.speed), CHART_POINTS), statistics.value?.maxSpeed ?? 0),
)

const cursorX = computed(() => progress.value * CHART_W)

// ————————————————————————————— 控制 —————————————————————————————

/** 把控制器的状态搬进响应式 ref —— 只在需要刷新的时刻调用,而不是每帧 */
function syncNow(): void {
  if (!controller) return
  const snapshot = controller.snapshot
  view.value = snapshot
  playing.value = snapshot.playing
  speed.value = snapshot.speed
  currentTime.value = snapshot.time
  progress.value = snapshot.progress
}

function togglePlay(): void {
  controller?.toggle()
  syncNow()
}

function setSpeed(value: number): void {
  controller?.setSpeed(value)
  syncNow()
}

/**
 * 跳到某一时刻。
 *
 * 先清轨迹再跳 —— 轨迹线是渲染适配器「每帧把当前位置追加」画出来的,
 * 往回拖时不清就会画出一条穿回去的乱线。
 */
function seek(time: number): void {
  adapter?.clearTrail()
  controller?.seek(time)
  syncNow()
}

function onScrub(event: Event): void {
  const target = event.target as HTMLInputElement
  seek(Number(target.value))
}

function selectCamera(mode: CameraMode): void {
  adapter?.setCameraMode(mode)
  cameraMode.value = mode
}

function seekToEvent(time: number): void {
  seek(time)
}

function exportReport(format: ResultFormat): void {
  const current = report.value
  if (!current) return
  const text = exportTaskResult(current, format)
  const extension = format === 'markdown' ? 'md' : format
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `飞行报告_${timestampTag()}.${extension}`)
}

function levelLabel(level: string): string {
  switch (level) {
    case 'warn':
      return '警告'
    case 'error':
      return '错误'
    case 'success':
      return '完成'
    default:
      return '信息'
  }
}

// ————————————————————————————— 帧循环 —————————————————————————————

function frame(timestamp: number): void {
  frameId = window.requestAnimationFrame(frame)
  const delta = lastFrameTime === 0 ? 0 : Math.min((timestamp - lastFrameTime) / 1000, MAX_FRAME_DELTA)
  lastFrameTime = timestamp

  controller?.update(delta)

  const snapshot = controller?.snapshot ?? null
  if (snapshot && adapter) {
    // 回放快照 → 适配器认的快照。适配器因此完全不知道「这是回放」
    adapter.updateSnapshot(replayToRenderSnapshot(snapshot))
  }
  adapter?.render(delta)

  hudAccumulator += delta
  if (hudAccumulator >= HUD_SECONDS && snapshot) {
    hudAccumulator = 0
    view.value = snapshot
    playing.value = snapshot.playing
    speed.value = snapshot.speed
    currentTime.value = snapshot.time
    progress.value = snapshot.progress
  }
}

async function mount(): Promise<void> {
  const host = container.value
  const current = entry.value
  if (!host || !current) return

  // 控制器先建 —— 它不碰 WebGL,建好就能播放与拖动。
  // 机体模型还要下载几秒,那几秒里时间轴如果是死的,用户会以为页面卡住了。
  controller = new ReplayController(current.data, { speed: 1 })
  syncNow()

  const next = new ThreeRenderAdapter({
    container: host,
    // 回放自己的投影函数:只投影位姿,签名与领域包的一致,适配器分不出来
    project: projectReplayAgent,
    // 机体在回放里固定为展开态 —— 记录数据没有机臂状态,展开是飞行时的必然
    body: (context) => DroneView.load(context.loader, context.scene, { initialArmFold: 0 }),
    obstacles: scenarioToSceneObstacles(current.scenario),
    initialCameraTarget: { x: 0, y: 1.2, z: 0 },
  })
  adapter = next

  try {
    await next.initialize()
    if (disposed) return
    modelHealth.value = next.error ? `机体模型载入失败:${String(next.error)}` : next.modelHealthText
  } catch (error) {
    if (!disposed) modelHealth.value = `场景初始化失败:${String(error)}`
  }
}

onMounted(() => {
  void mount()
  frameId = window.requestAnimationFrame(frame)
})

onBeforeUnmount(() => {
  disposed = true
  if (frameId !== 0) window.cancelAnimationFrame(frameId)
  frameId = 0
  controller?.dispose()
  controller = null
  adapter?.dispose()
  adapter = null
})
</script>

<template>
  <div class="replay">
    <header class="replay__bar">
      <div class="replay__heading">
        <h1 class="replay__title">飞行回放</h1>
        <span v-if="entry" class="tag">{{ entry.data.label }}</span>
      </div>

      <div v-if="entry" class="replay__meta mono">
        <span>场景 {{ entry.data.scenarioId }}</span>
        <span>seed {{ entry.data.seed }}</span>
        <span>时长 {{ formatClock(statistics?.duration) }}</span>
        <span>采样 {{ formatNumber(entry.data.sampleHz, 0) }} Hz</span>
        <span>保存于 {{ savedAtText }}</span>
      </div>

      <nav class="replay__nav">
        <RouterLink class="replay__link" to="/">无人机沙盒</RouterLink>
        <RouterLink class="replay__link" to="/car">汽车沙盒</RouterLink>
      </nav>
    </header>

    <p v-if="!entry" class="replay__empty">
      还没有飞行记录。去
      <RouterLink class="replay__inline-link" to="/">无人机沙盒</RouterLink>
      飞一段,然后在「遥测」面板底部点「保存本次飞行 → 回放」。
    </p>

    <div v-else class="replay__grid">
      <main class="replay__stage">
        <div class="replay__viewport">
          <div ref="container" class="replay__canvas" />
          <div class="replay__camera" role="group" aria-label="相机模式">
            <button
              v-for="item in CAMERA_MODE_LIST"
              :key="item.key"
              type="button"
              :class="{ active: cameraMode === item.key }"
              :data-testid="`replay-camera-${item.key}`"
              @click="selectCamera(item.key)"
            >
              {{ item.label }}
            </button>
          </div>
          <p v-if="modelHealth" class="replay__model mono">{{ modelHealth }}</p>
        </div>

        <!-- 时间轴:回放的唯一驱动入口 -->
        <div class="timeline" data-testid="replay-timeline">
          <button class="primary timeline__play" type="button" data-testid="replay-play" @click="togglePlay">
            {{ playing ? '暂停' : '播放' }}
          </button>

          <span class="timeline__clock mono" data-testid="replay-clock">
            {{ formatClock(currentTime) }} / {{ formatClock(duration) }}
          </span>

          <input
            class="timeline__range"
            type="range"
            min="0"
            :max="duration"
            step="0.05"
            :value="currentTime"
            data-testid="replay-range"
            aria-label="回放进度"
            @input="onScrub"
          >

          <div class="timeline__speeds" role="group" aria-label="播放倍速">
            <button
              v-for="item in SPEEDS"
              :key="item"
              type="button"
              :class="{ active: speed === item }"
              :data-testid="`replay-speed-${item}`"
              @click="setSpeed(item)"
            >
              {{ item }}×
            </button>
          </div>
        </div>
      </main>

      <aside class="replay__side">
        <!-- 统计 -->
        <section class="card">
          <h2 class="card__title">本次飞行</h2>
          <div class="stats" data-testid="replay-stats">
            <div v-for="item in statCards" :key="item.label" class="stat">
              <span class="stat__label">{{ item.label }}</span>
              <span class="stat__value mono">{{ item.value }}</span>
            </div>
          </div>
        </section>

        <!-- 曲线 -->
        <section class="card">
          <h2 class="card__title">高度 / 速度</h2>

          <figure class="chart">
            <figcaption>
              <span>高度</span>
              <span class="mono">峰值 {{ formatMeters(statistics?.maxAltitude) }}</span>
            </figcaption>
            <svg class="chart__svg" :viewBox="`0 0 ${CHART_W} ${CHART_H}`" preserveAspectRatio="none" role="img" aria-label="高度曲线">
              <polyline class="chart__line chart__line--alt" :points="altitudeLine" vector-effect="non-scaling-stroke" />
              <line class="chart__cursor" :x1="cursorX" y1="0" :x2="cursorX" :y2="CHART_H" vector-effect="non-scaling-stroke" />
            </svg>
          </figure>

          <figure class="chart">
            <figcaption>
              <span>水平速度</span>
              <span class="mono">峰值 {{ formatSpeed(statistics?.maxSpeed) }}</span>
            </figcaption>
            <svg class="chart__svg" :viewBox="`0 0 ${CHART_W} ${CHART_H}`" preserveAspectRatio="none" role="img" aria-label="速度曲线">
              <polyline class="chart__line chart__line--speed" :points="speedLine" vector-effect="non-scaling-stroke" />
              <line class="chart__cursor" :x1="cursorX" y1="0" :x2="cursorX" :y2="CHART_H" vector-effect="non-scaling-stroke" />
            </svg>
          </figure>
        </section>

        <!-- 事件时间线 -->
        <section class="card">
          <h2 class="card__title">
            事件时间线
            <span class="mono card__count">{{ view?.events.length ?? 0 }} / {{ entry.data.events.length }}</span>
          </h2>
          <ul class="events" data-testid="replay-events">
            <li v-for="item in visibleEvents" :key="item.eventId">
              <button type="button" class="events__row" @click="seekToEvent(item.simulationTime)">
                <span class="events__time mono">{{ formatClock(item.simulationTime) }}</span>
                <span class="events__level" :class="`events__level--${item.level}`">{{ levelLabel(item.level) }}</span>
                <span class="events__text">{{ item.message ?? item.type }}</span>
              </button>
            </li>
            <li v-if="visibleEvents.length === 0" class="hint">此刻还没有事件发生</li>
          </ul>
        </section>

        <!-- 此刻状态 -->
        <section class="card">
          <h2 class="card__title">此刻</h2>
          <dl class="now">
            <div class="now__row">
              <dt>时刻</dt>
              <dd class="mono">{{ currentTime.toFixed(2) }} s</dd>
            </div>
            <div v-for="agent in view?.agents ?? []" :key="agent.agentId" class="now__row">
              <dt>{{ agent.label }}</dt>
              <dd class="mono">
                E {{ agent.position.x.toFixed(1) }} · 高 {{ agent.position.y.toFixed(1) }} ·
                南 {{ agent.position.z.toFixed(1) }} · 朝向 {{ formatHeading(agent.headingDeg) }}
              </dd>
            </div>
            <div class="now__row">
              <dt>最近指令</dt>
              <dd class="mono">{{ view?.command?.type ?? '—' }}</dd>
            </div>
          </dl>
        </section>

        <!-- 导出 -->
        <section class="card">
          <h2 class="card__title">导出结果</h2>
          <div class="exports">
            <button type="button" data-testid="export-json" @click="exportReport('json')">JSON</button>
            <button type="button" data-testid="export-markdown" @click="exportReport('markdown')">Markdown</button>
            <button type="button" data-testid="export-csv" @click="exportReport('csv')">CSV</button>
          </div>
          <p v-if="summary" class="hint">{{ summary.headline }}</p>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.replay {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  padding: 12px 14px;
}

.replay__bar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-soft);
}

.replay__heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.replay__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.replay__meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-faint);
}

.replay__nav {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.replay__link {
  font-size: 12px;
  color: var(--text-faint);
  text-decoration: none;
  padding: 5px 10px;
  border: 1px solid var(--border-soft);
  border-radius: 7px;
}

.replay__link:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.replay__inline-link {
  color: var(--accent);
}

.replay__empty {
  margin: 40px auto;
  max-width: 520px;
  text-align: center;
  font-size: 13px;
  line-height: 1.9;
  color: var(--text-faint);
}

.replay__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

.replay__stage {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.replay__viewport {
  position: relative;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  overflow: hidden;
  background: #08151b;
}

.replay__canvas {
  width: 100%;
  height: 100%;
}

.replay__camera {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  gap: 5px;
}

.replay__camera button.active {
  color: var(--accent);
  border-color: var(--accent);
}

.replay__model {
  position: absolute;
  left: 10px;
  bottom: 8px;
  margin: 0;
  font-size: 10.5px;
  color: var(--text-faint);
}

/* ————————————— 时间轴 ————————————— */

.timeline {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  background: var(--panel-soft);
}

.timeline__play {
  min-width: 62px;
}

.timeline__clock {
  font-size: 12px;
  color: var(--accent);
  white-space: nowrap;
}

.timeline__range {
  flex: 1;
  min-width: 80px;
  accent-color: var(--accent);
}

.timeline__speeds {
  display: flex;
  gap: 4px;
}

.timeline__speeds button {
  padding: 4px 8px;
  font-size: 11px;
}

.timeline__speeds button.active {
  color: var(--accent);
  border-color: var(--accent);
}

/* ————————————— 侧栏 ————————————— */

.replay__side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  min-height: 0;
  padding-right: 2px;
}

.card {
  padding: 9px 11px;
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  background: var(--panel-soft);
}

.card__title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 0 0 7px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-faint);
  letter-spacing: 0.04em;
}

.card__count {
  font-size: 11px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 7px;
  border: 1px solid var(--border-soft);
  border-radius: 7px;
}

.stat__label {
  font-size: 10.5px;
  color: var(--text-faint);
}

.stat__value {
  font-size: 13px;
  color: var(--accent);
}

/* ————————————— 曲线 ————————————— */

.chart {
  margin: 0 0 8px;
}

.chart:last-child {
  margin-bottom: 0;
}

.chart figcaption {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: var(--text-faint);
  margin-bottom: 3px;
}

.chart__svg {
  width: 100%;
  height: 62px;
  display: block;
  background: #08151b;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
}

.chart__line {
  fill: none;
  stroke-width: 1.4;
}

.chart__line--alt {
  stroke: var(--accent);
}

.chart__line--speed {
  stroke: var(--success);
}

.chart__cursor {
  stroke: var(--warn);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}

/* ————————————— 事件 ————————————— */

.events {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 190px;
  overflow-y: auto;
}

.events__row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  text-align: left;
  padding: 3px 5px;
  font-size: 11px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
}

.events__row:hover {
  border-color: var(--border-soft);
  background: var(--panel-raised);
}

.events__time {
  color: var(--text-faint);
  white-space: nowrap;
}

.events__level {
  white-space: nowrap;
}

.events__level--info {
  color: var(--text-faint);
}

.events__level--success {
  color: var(--success);
}

.events__level--warn {
  color: var(--warn);
}

.events__level--error {
  color: var(--danger);
}

.events__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ————————————— 此刻 ————————————— */

.now {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.now__row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
  border-bottom: 1px dashed var(--border-soft);
  padding-bottom: 2px;
}

.now__row dt {
  color: var(--text-faint);
  white-space: nowrap;
}

.now__row dd {
  margin: 0;
  text-align: right;
}

.exports {
  display: flex;
  gap: 5px;
}

.exports button {
  flex: 1;
  padding: 5px 6px;
  font-size: 11px;
}
</style>
