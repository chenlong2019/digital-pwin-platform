<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  captureRequest,
  serviceRequest,
  type CaptureTask,
  type Dataset,
  type HealthResponse,
} from '../capture/api'

const tasks = ref<CaptureTask[]>([])
const datasets = ref<Dataset[]>([])
const health = ref<HealthResponse | null>(null)
const refreshing = ref(false)
const checked = ref(false)
const tasksLoaded = ref(false)
const datasetsLoaded = ref(false)
const tasksUnavailable = ref(false)
const datasetsUnavailable = ref(false)
const checkedAt = ref(Date.now())
const lastUpdated = ref<Date | null>(null)
const offlineNote = ref('')

let disposed = false
let timer: ReturnType<typeof setInterval> | undefined

const taskStatusLabels: Record<CaptureTask['status'], string> = {
  queued: '等待执行',
  running: '采集中',
  paused: '已暂停',
  failed: '执行失败',
  completed: '已完成',
}

const datasetStatusLabels: Record<Dataset['status'], string> = {
  draft: '准备中',
  ready: '可重建',
  training: '训练中',
  completed: '已完成',
  failed: '处理失败',
}

const connected = computed(() => health.value !== null)
const connectionLabel = computed(() =>
  !checked.value ? '正在连接' : connected.value ? '服务在线' : '服务未连接',
)
const activeTaskCount = computed(
  () => tasks.value.filter((task) => task.status === 'running' && !leaseExpired(task)).length,
)
const completedTaskCount = computed(
  () => tasks.value.filter((task) => task.status === 'completed').length,
)
const readyDatasetCount = computed(
  () => datasets.value.filter((dataset) => dataset.status === 'ready').length,
)
const recentTasks = computed(() => tasks.value.slice(0, 5))
const recentDatasets = computed(() => datasets.value.slice(0, 4))

const workflow = computed(() => [
  {
    number: '01',
    title: '规划',
    description: '定义场景、相机和拍摄点',
    state: !tasksLoaded.value ? '等待连接' : tasks.value.length ? '已开始' : '待开始',
    tone: tasks.value.length ? 'done' : 'idle',
  },
  {
    number: '02',
    title: '采集',
    description: '仿真相机按计划生成数据',
    state: !tasksLoaded.value
      ? '等待连接'
      : activeTaskCount.value
        ? '进行中'
        : completedTaskCount.value
          ? '已完成'
          : '等待任务',
    tone: activeTaskCount.value ? 'active' : completedTaskCount.value ? 'done' : 'idle',
  },
  {
    number: '03',
    title: '校验',
    description: '检查图像、位姿和相机参数',
    state: !datasetsLoaded.value
      ? '等待连接'
      : readyDatasetCount.value
        ? `${readyDatasetCount.value} 个已通过`
        : '等待数据',
    tone: readyDatasetCount.value ? 'done' : 'idle',
  },
  {
    number: '04',
    title: '重建',
    description: '训练神经场并生成可渲染场景',
    state: '待接入',
    tone: 'planned',
  },
])

function leaseExpired(task: CaptureTask): boolean {
  return (
    task.status === 'running' &&
    !!task.lease_expires_at &&
    Date.parse(task.lease_expires_at) <= checkedAt.value
  )
}

function executionLabel(task: CaptureTask): string {
  if (leaseExpired(task)) return '等待采集端重连'
  if (task.status === 'completed') return '采集结果已登记'
  if (task.status === 'paused') return '等待继续'
  if (task.status === 'failed') return '可重试'
  return task.worker_id ? '采集端已领取' : '等待采集端领取'
}

function datasetTaskId(dataset: Dataset): string | null {
  const linkedTask = tasks.value.find((task) => task.dataset_id === dataset.dataset_id)
  if (linkedTask) return linkedTask.task_id
  return typeof dataset.metadata.captureTaskId === 'string' ? dataset.metadata.captureTaskId : null
}

function taskProgress(task: CaptureTask): number {
  if (!task.total) return 0
  return Math.min(100, Math.round((task.uploaded / task.total) * 100))
}

function taskStatusTone(status: CaptureTask['status']): string {
  if (status === 'completed') return 'is-success'
  if (status === 'running') return 'is-active'
  if (status === 'failed') return 'is-danger'
  if (status === 'paused') return 'is-warning'
  return 'is-muted'
}

function datasetStatusTone(status: Dataset['status']): string {
  if (status === 'ready' || status === 'completed') return 'is-success'
  if (status === 'training') return 'is-active'
  if (status === 'failed') return 'is-danger'
  return 'is-muted'
}

function datasetFrameLabel(dataset: Dataset): string {
  const task = tasks.value.find((item) => item.dataset_id === dataset.dataset_id)
  if (task) return `${task.uploaded} / ${task.total} 帧`

  const expected = dataset.metadata.expectedFrameCount
  return typeof expected === 'number' ? `计划 ${expected} 帧` : '帧数待确认'
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return '时间未知'
  return date.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    timeZone: 'Asia/Shanghai',
  })
}

function formatUpdated(value: Date | null): string {
  if (!value) return '尚未同步'
  return `最近同步 ${value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })}`
}

async function refresh(): Promise<void> {
  if (refreshing.value || disposed) return
  refreshing.value = true

  const results = await Promise.allSettled([
    serviceRequest<HealthResponse>('/health'),
    captureRequest<CaptureTask[]>('/capture-tasks'),
    captureRequest<Dataset[]>('/datasets'),
  ])

  if (disposed) return

  const healthResult = results[0]
  const tasksResult = results[1]
  const datasetsResult = results[2]
  checked.value = true
  checkedAt.value = Date.now()

  if (healthResult.status === 'fulfilled') {
    health.value = healthResult.value
    offlineNote.value = ''
  } else {
    health.value = null
    offlineNote.value = '神经渲染服务未连接，控制台会在服务启动后自动同步。'
  }

  tasksUnavailable.value = tasksResult.status === 'rejected'
  datasetsUnavailable.value = datasetsResult.status === 'rejected'
  if (tasksResult.status === 'fulfilled') {
    tasks.value = tasksResult.value
    tasksLoaded.value = true
  }
  if (datasetsResult.status === 'fulfilled') {
    datasets.value = datasetsResult.value
    datasetsLoaded.value = true
  }

  if (tasksResult.status === 'fulfilled' && datasetsResult.status === 'fulfilled') {
    lastUpdated.value = new Date()
  }
  refreshing.value = false
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh(), 5000)
})

onScopeDispose(() => {
  disposed = true
  clearInterval(timer)
})
</script>

<template>
  <div class="console-page">
    <aside class="console-sidebar">
      <div class="console-brand">
        <span class="console-brand__mark">NR</span>
        <span class="console-brand__copy">
          <strong>Neural Render</strong>
          <small>仿真工作台</small>
        </span>
      </div>

      <div class="console-nav-label">工作区</div>
      <nav class="console-nav" data-testid="console-nav" aria-label="主导航">
        <RouterLink to="/console" class="nav-item" exact-active-class="nav-item--active">
          <span class="nav-item__icon" aria-hidden="true">⌂</span>
          <span>控制台</span>
        </RouterLink>
        <RouterLink to="/capture-tasks" class="nav-item" active-class="nav-item--active">
          <span class="nav-item__icon" aria-hidden="true">↗</span>
          <span>采集任务</span>
        </RouterLink>
        <RouterLink
          to="/"
          class="nav-item"
          active-class="nav-item--active"
          exact-active-class="nav-item--active"
        >
          <span class="nav-item__icon" aria-hidden="true">◇</span>
          <span>仿真沙盒</span>
        </RouterLink>
        <a href="#datasets" class="nav-item">
          <span class="nav-item__icon" aria-hidden="true">▦</span>
          <span>数据集</span>
        </a>
        <RouterLink to="/replay" class="nav-item" active-class="nav-item--active">
          <span class="nav-item__icon" aria-hidden="true">▷</span>
          <span>回放</span>
        </RouterLink>
      </nav>

      <div class="console-sidebar__bottom">
        <div class="connection-card">
          <span class="status-dot" :class="connected ? 'status-dot--ok' : 'status-dot--off'"></span>
          <div>
            <strong>{{ connectionLabel }}</strong>
            <small>{{ connected ? '采集数据自动同步' : '等待本地服务启动' }}</small>
          </div>
        </div>
        <span class="console-version">控制台原型 · v0.1</span>
      </div>
    </aside>

    <main class="console-main">
      <header class="console-header">
        <div>
          <p class="eyebrow">工作区 / 总览</p>
          <h1>控制台</h1>
          <p class="console-subtitle">从场景规划到神经重建，集中查看当前实验进展。</p>
        </div>
        <div class="console-header__actions">
          <span
            class="service-status"
            :class="connected ? 'service-status--ok' : 'service-status--off'"
            data-testid="service-status"
          >
            <span
              class="status-dot"
              :class="connected ? 'status-dot--ok' : 'status-dot--off'"
            ></span>
            {{ connectionLabel }}
          </span>
          <span class="sync-time">{{ formatUpdated(lastUpdated) }}</span>
          <button
            class="refresh-button"
            type="button"
            aria-label="刷新控制台"
            :disabled="refreshing"
            @click="refresh"
          >
            <span :class="{ spinning: refreshing }">↻</span>
            刷新
          </button>
          <RouterLink class="button button--primary" to="/capture-tasks">新建采集任务</RouterLink>
        </div>
      </header>

      <p v-if="offlineNote" class="offline-note" role="status">{{ offlineNote }}</p>

      <section class="console-hero" aria-labelledby="hero-title">
        <div class="console-hero__copy">
          <span class="hero-kicker">NEURAL RENDER PLATFORM</span>
          <h2 id="hero-title">从一次采集，开始验证。</h2>
          <p>选择场景，设置拍点，检查采集结果。让仿真数据逐步走向神经重建。</p>
          <div class="hero-links">
            <RouterLink class="text-link" to="/capture-tasks"
              >开始一次采集 <span>→</span></RouterLink
            >
            <RouterLink class="text-link text-link--muted" to="/"
              >打开仿真沙盒 <span>→</span></RouterLink
            >
          </div>
        </div>
        <div class="console-hero__diagram" aria-label="平台工作流示意">
          <div class="diagram-node diagram-node--scene">
            <span>01</span><strong>场景</strong><small>可重复仿真</small>
          </div>
          <span class="diagram-arrow">→</span>
          <div class="diagram-node diagram-node--capture">
            <span>02</span><strong>采集</strong><small>Agent 执行</small>
          </div>
          <span class="diagram-arrow">→</span>
          <div class="diagram-node diagram-node--dataset">
            <span>03</span><strong>数据集</strong><small>可恢复登记</small>
          </div>
        </div>
      </section>

      <section class="stats-grid" data-testid="console-stats" aria-label="平台统计">
        <article class="stat-card" data-testid="stat-tasks">
          <span class="stat-card__label">采集任务</span>
          <strong>{{ tasksLoaded ? tasks.length : '—' }}</strong>
          <small>最近记录</small>
        </article>
        <article class="stat-card stat-card--active" data-testid="stat-running">
          <span class="stat-card__label">运行中</span>
          <strong>{{ tasksLoaded ? activeTaskCount : '—' }}</strong>
          <small>正在执行</small>
        </article>
        <article class="stat-card stat-card--success" data-testid="stat-completed">
          <span class="stat-card__label">已完成</span>
          <strong>{{ tasksLoaded ? completedTaskCount : '—' }}</strong>
          <small>采集完成</small>
        </article>
        <article class="stat-card stat-card--info" data-testid="stat-datasets">
          <span class="stat-card__label">数据集</span>
          <strong>{{ datasetsLoaded ? datasets.length : '—' }}</strong>
          <small>{{ datasetsLoaded ? `${readyDatasetCount} 个可重建` : '等待同步' }}</small>
        </article>
      </section>

      <section class="panel-section workflow-section" aria-labelledby="workflow-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">当前工作流</p>
            <h2 id="workflow-title">从计划到重建</h2>
          </div>
          <span class="section-note">{{
            !checked
              ? '连接中'
              : tasksUnavailable || datasetsUnavailable
                ? '等待同步'
                : '每 5 秒同步'
          }}</span>
        </div>
        <div class="workflow-list">
          <div
            v-for="step in workflow"
            :key="step.number"
            class="workflow-step"
            :class="`workflow-step--${step.tone}`"
          >
            <div class="workflow-step__number">{{ step.number }}</div>
            <div class="workflow-step__copy">
              <strong>{{ step.title }}</strong>
              <small>{{ step.description }}</small>
              <span>{{ step.state }}</span>
            </div>
          </div>
        </div>
      </section>

      <div class="content-grid">
        <section class="panel-section list-section" aria-labelledby="tasks-title">
          <div class="section-heading">
            <div>
              <p class="eyebrow">最近活动</p>
              <h2 id="tasks-title">采集任务</h2>
            </div>
            <RouterLink class="section-link" to="/capture-tasks"
              >查看全部 <span>→</span></RouterLink
            >
          </div>

          <p v-if="tasksUnavailable && tasksLoaded" class="section-alert" role="status">
            任务更新失败，暂时保留上次结果。
          </p>
          <div v-if="recentTasks.length" class="task-list">
            <RouterLink
              v-for="task in recentTasks"
              :key="task.task_id"
              class="task-item"
              :to="{ path: '/capture-tasks', query: { task: task.task_id } }"
            >
              <div class="task-item__head">
                <div class="task-item__name">
                  <span
                    class="status-dot"
                    :class="
                      task.status === 'running'
                        ? 'status-dot--active'
                        : task.status === 'completed'
                          ? 'status-dot--ok'
                          : task.status === 'failed'
                            ? 'status-dot--danger'
                            : 'status-dot--idle'
                    "
                  ></span>
                  <strong>{{ task.name }}</strong>
                  <span
                    class="status-pill"
                    :class="leaseExpired(task) ? 'is-warning' : taskStatusTone(task.status)"
                    >{{ leaseExpired(task) ? '待重连' : taskStatusLabels[task.status] }}</span
                  >
                </div>
                <span class="task-item__count">{{ task.uploaded }} / {{ task.total }}</span>
              </div>
              <div class="progress-track" aria-hidden="true">
                <span :style="{ width: `${taskProgress(task)}%` }"></span>
              </div>
              <div class="task-item__meta">
                <span>{{ taskProgress(task) }}% 已上传</span>
                <span>{{ executionLabel(task) }}</span>
              </div>
            </RouterLink>
          </div>
          <div v-else-if="!tasksLoaded" class="empty-state">
            <span class="empty-state__icon" aria-hidden="true">↗</span>
            <strong>{{ tasksUnavailable ? '暂时无法读取任务' : '正在读取任务' }}</strong>
            <span>服务连接后，任务和进度会自动显示。</span>
            <button v-if="tasksUnavailable" type="button" :disabled="refreshing" @click="refresh">
              重新连接
            </button>
          </div>
          <div v-else class="empty-state">
            <span class="empty-state__icon">↗</span>
            <strong>还没有采集任务</strong>
            <span>创建一个拍摄计划，开始验证采集闭环。</span>
            <RouterLink class="button button--secondary" to="/capture-tasks"
              >创建第一个任务</RouterLink
            >
          </div>
        </section>

        <section id="datasets" class="panel-section list-section" aria-labelledby="datasets-title">
          <div class="section-heading">
            <div>
              <p class="eyebrow">采集成果</p>
              <h2 id="datasets-title">数据集</h2>
            </div>
            <span class="section-note">{{
              datasetsLoaded ? `${datasets.length} 个` : '等待同步'
            }}</span>
          </div>

          <p v-if="datasetsUnavailable && datasetsLoaded" class="section-alert" role="status">
            数据集更新失败，暂时保留上次结果。
          </p>
          <div v-if="recentDatasets.length" class="dataset-list">
            <div v-for="dataset in recentDatasets" :key="dataset.dataset_id" class="dataset-item">
              <div class="dataset-item__icon">◌</div>
              <div class="dataset-item__body">
                <div class="dataset-item__head">
                  <strong>{{ dataset.name }}</strong>
                  <span class="status-pill" :class="datasetStatusTone(dataset.status)">{{
                    datasetStatusLabels[dataset.status]
                  }}</span>
                </div>
                <div class="dataset-item__meta">
                  <span>{{ datasetFrameLabel(dataset) }}</span>
                  <span>{{ formatDate(dataset.created_at) }}</span>
                  <RouterLink
                    v-if="datasetTaskId(dataset)"
                    class="section-link"
                    :to="{ path: '/capture-tasks', query: { task: datasetTaskId(dataset) } }"
                    :aria-label="`查看${dataset.name}采集结果`"
                    >查看结果 →</RouterLink
                  >
                </div>
              </div>
            </div>
          </div>
          <div v-else-if="!datasetsLoaded" class="empty-state empty-state--compact">
            <span class="empty-state__icon" aria-hidden="true">▦</span>
            <strong>{{ datasetsUnavailable ? '暂时无法读取数据集' : '正在读取数据集' }}</strong>
            <span>连接服务后可查看图像和相机参数的登记状态。</span>
          </div>
          <div v-else class="empty-state empty-state--compact">
            <span class="empty-state__icon">▦</span>
            <strong>数据集会显示在这里</strong>
            <span>完成一次采集后，图像和相机参数会自动登记。</span>
          </div>
        </section>
      </div>

      <div class="bottom-grid">
        <section class="panel-section quick-section" aria-labelledby="quick-title">
          <div class="section-heading">
            <div>
              <p class="eyebrow">快速入口</p>
              <h2 id="quick-title">继续实验</h2>
            </div>
          </div>
          <div class="quick-actions">
            <RouterLink class="quick-action" to="/">
              <span class="quick-action__icon">◇</span>
              <span><strong>仿真沙盒</strong><small>调整相机与飞行状态</small></span>
              <span class="quick-action__arrow">→</span>
            </RouterLink>
            <RouterLink class="quick-action" to="/replay">
              <span class="quick-action__icon">▷</span>
              <span><strong>飞行回放</strong><small>检查轨迹与遥测记录</small></span>
              <span class="quick-action__arrow">→</span>
            </RouterLink>
          </div>
        </section>

        <section class="panel-section environment-section" aria-labelledby="environment-title">
          <div class="section-heading">
            <div>
              <p class="eyebrow">运行环境</p>
              <h2 id="environment-title">当前连接</h2>
            </div>
            <span class="status-pill" :class="connected ? 'is-success' : 'is-warning'">{{
              connected ? '正常' : '等待中'
            }}</span>
          </div>
          <div class="environment-list">
            <div>
              <span>神经渲染服务</span><strong>{{ connected ? '已连接' : '未连接' }}</strong>
            </div>
            <div><span>神经重建</span><strong>待接入算法</strong></div>
            <div>
              <span>采集执行端</span
              ><strong>{{
                tasksUnavailable || !tasksLoaded
                  ? '状态未确认'
                  : activeTaskCount
                    ? '正在执行任务'
                    : '暂无执行中任务'
              }}</strong>
            </div>
          </div>
        </section>
      </div>
    </main>
  </div>
</template>

<style scoped>
.console-page {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: 224px minmax(0, 1fr);
  background: var(--bg);
  overflow: hidden;
}

.console-sidebar {
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 24px 14px 18px;
  background: #081218;
  border-right: 1px solid var(--border-soft);
  overflow-y: auto;
}

.console-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px 28px;
}

.console-brand__mark {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  color: var(--bg);
  background: var(--accent);
  border-radius: 10px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.04em;
}

.console-brand__copy {
  display: grid;
  gap: 1px;
}

.console-brand__copy strong {
  color: var(--text);
  font-size: 13px;
  letter-spacing: 0.01em;
}

.console-brand__copy small,
.console-version {
  color: var(--text-faint);
  font-size: 10px;
}

.console-nav-label,
.eyebrow,
.hero-kicker {
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
}

.console-nav-label {
  padding: 0 12px 8px;
}

.console-nav {
  display: grid;
  gap: 3px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 12px;
  color: var(--text-dim);
  border: 1px solid transparent;
  border-radius: 8px;
  text-decoration: none;
  font-size: 12px;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.nav-item:hover {
  color: var(--text);
  background: var(--panel-raised);
}

.nav-item--active,
.nav-item--active:hover {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: rgba(111, 240, 208, 0.24);
}

.nav-item__icon {
  width: 17px;
  color: currentColor;
  font-size: 16px;
  line-height: 1;
  text-align: center;
}

.console-sidebar__bottom {
  margin-top: auto;
  display: grid;
  gap: 14px;
  padding: 18px 8px 0;
}

.connection-card {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 11px;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: var(--panel);
}

.connection-card div {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.connection-card strong {
  color: var(--text-dim);
  font-size: 11px;
}

.connection-card small {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  margin-top: 5px;
  display: inline-block;
  border-radius: 50%;
  background: var(--text-faint);
}

.status-dot--ok {
  background: var(--accent);
  box-shadow: 0 0 0 3px rgba(111, 240, 208, 0.1);
}
.status-dot--active {
  background: var(--info);
  box-shadow: 0 0 0 3px rgba(127, 216, 255, 0.1);
}
.status-dot--off {
  background: var(--danger);
  box-shadow: 0 0 0 3px rgba(255, 111, 126, 0.1);
}
.status-dot--danger {
  background: var(--danger);
}
.status-dot--idle {
  background: var(--text-faint);
}

.console-main {
  height: 100%;
  min-height: 0;
  width: min(1420px, 100%);
  margin: 0 auto;
  padding: 28px clamp(22px, 3vw, 40px) 36px;
  overflow: auto;
}

.console-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
  margin-bottom: 26px;
}

.console-header h1 {
  margin-top: 5px;
  font-size: 28px;
  letter-spacing: -0.03em;
}

.console-subtitle {
  margin: 7px 0 0;
  color: var(--text-dim);
  font-size: 13px;
}

.console-header__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 9px;
  flex-wrap: wrap;
}

.service-status,
.sync-time,
.refresh-button {
  color: var(--text-dim);
  font-size: 11px;
}

.service-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
}

.service-status .status-dot {
  margin-top: 0;
}
.service-status--ok {
  color: var(--accent);
  border-color: rgba(111, 240, 208, 0.25);
}
.service-status--off {
  color: var(--danger);
  border-color: rgba(255, 111, 126, 0.25);
}
.sync-time {
  color: var(--text-faint);
}

.refresh-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
}

.refresh-button span {
  display: inline-block;
  font-size: 16px;
  line-height: 1;
}

.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 32px;
  padding: 7px 13px;
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text);
  font-size: 11px;
  text-decoration: none;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.button--primary {
  color: var(--bg);
  background: var(--accent);
  border-color: var(--accent);
  font-weight: 700;
}

.button--primary:hover {
  background: #9af8e3;
  border-color: #9af8e3;
}
.button--secondary {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: rgba(111, 240, 208, 0.28);
}
.button--secondary:hover {
  background: rgba(111, 240, 208, 0.22);
}

.offline-note {
  margin: -9px 0 18px;
  padding: 9px 12px;
  color: var(--warn);
  background: rgba(255, 196, 107, 0.08);
  border: 1px solid rgba(255, 196, 107, 0.17);
  border-radius: 7px;
  font-size: 11px;
}

.console-hero {
  min-height: 170px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 30px;
  padding: 24px 26px;
  background:
    radial-gradient(circle at 86% 45%, rgba(111, 240, 208, 0.12), transparent 32%),
    linear-gradient(115deg, #0d242b, #0b181f 65%);
  border: 1px solid rgba(111, 240, 208, 0.16);
  border-radius: 12px;
  overflow: hidden;
}

.console-hero__copy {
  max-width: 570px;
}
.hero-kicker {
  color: var(--accent);
  letter-spacing: 0.18em;
}
.console-hero h2 {
  margin: 9px 0 9px;
  font-size: clamp(22px, 2.5vw, 28px);
  line-height: 1.3;
  letter-spacing: -0.025em;
}
.console-hero p {
  max-width: 510px;
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
}
.hero-links {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-top: 22px;
}
.text-link {
  color: var(--accent);
  font-size: 12px;
  text-decoration: none;
}
.text-link span {
  margin-left: 5px;
  transition: margin 0.15s ease;
}
.text-link:hover span {
  margin-left: 9px;
}
.text-link--muted {
  color: var(--text-dim);
}

.console-hero__diagram {
  min-width: 400px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.diagram-node {
  width: 108px;
  min-height: 102px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  padding: 13px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: rgba(6, 13, 18, 0.56);
}

.diagram-node span {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 10px;
}
.diagram-node strong {
  font-size: 14px;
}
.diagram-node small {
  color: var(--text-dim);
  font-size: 10px;
}
.diagram-node--capture {
  border-color: rgba(111, 240, 208, 0.42);
  box-shadow: 0 0 28px rgba(111, 240, 208, 0.08);
}
.diagram-node--capture strong {
  color: var(--accent);
}
.diagram-arrow {
  color: var(--text-faint);
  font-size: 20px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin: 14px 0;
}

.stat-card {
  min-height: 102px;
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto 1fr auto;
  gap: 3px 10px;
  padding: 16px 17px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: 9px;
}

.stat-card__label {
  grid-column: 1 / -1;
  color: var(--text-dim);
  font-size: 11px;
}
.stat-card strong {
  align-self: end;
  font-family: var(--mono);
  font-size: 27px;
  font-weight: 500;
  letter-spacing: -0.06em;
}
.stat-card small {
  align-self: end;
  color: var(--text-faint);
  font-size: 10px;
  text-align: right;
}
.stat-card--active strong {
  color: var(--info);
}
.stat-card--success strong {
  color: var(--accent);
}
.stat-card--info strong {
  color: var(--text);
}

.panel-section {
  padding: 19px 20px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
}

.workflow-section {
  margin-bottom: 14px;
}
.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 17px;
}
.section-heading .eyebrow {
  margin-bottom: 4px;
}
.section-heading h2 {
  font-size: 15px;
  letter-spacing: -0.01em;
}
.section-note {
  color: var(--text-faint);
  font-size: 11px;
}
.section-link {
  color: var(--accent);
  font-size: 11px;
  text-decoration: none;
}
.section-link span {
  margin-left: 4px;
}
.section-alert {
  color: var(--warn);
  font-size: 12px;
}

.workflow-list {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
}

.workflow-step {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  padding-right: 25px;
}

.workflow-step__number {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  display: grid;
  place-items: center;
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: 50%;
  font-family: var(--mono);
  font-size: 10px;
}

.workflow-step__copy {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.workflow-step__copy strong {
  font-size: 12px;
}
.workflow-step__copy small {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workflow-step__copy span {
  color: var(--text-dim);
  font-size: 10px;
}
.workflow-step--done .workflow-step__number {
  color: var(--accent);
  border-color: rgba(111, 240, 208, 0.55);
  background: var(--accent-soft);
}
.workflow-step--done .workflow-step__copy span {
  color: var(--accent);
}
.workflow-step--active .workflow-step__number {
  color: var(--info);
  border-color: rgba(127, 216, 255, 0.55);
  background: rgba(127, 216, 255, 0.1);
}
.workflow-step--active .workflow-step__copy span {
  color: var(--info);
}

.content-grid,
.bottom-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(320px, 0.75fr);
  gap: 14px;
}

.list-section {
  min-height: 280px;
}
.task-list,
.dataset-list {
  display: grid;
  gap: 8px;
}
.task-item {
  display: block;
  padding: 11px 12px;
  color: inherit;
  border: 1px solid transparent;
  border-radius: 7px;
  text-decoration: none;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}
.task-item:hover {
  background: var(--panel-raised);
  border-color: var(--border);
}
.task-item__head,
.task-item__meta,
.dataset-item__head,
.dataset-item__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.task-item__name {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
}
.task-item__name .status-dot {
  margin-top: 0;
}
.task-item__name strong,
.dataset-item__head strong {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-item__count {
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 11px;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-dim);
  font-size: 10px;
  white-space: nowrap;
}
.is-success {
  color: var(--accent);
  border-color: rgba(111, 240, 208, 0.32);
  background: rgba(111, 240, 208, 0.08);
}
.is-active {
  color: var(--info);
  border-color: rgba(127, 216, 255, 0.32);
  background: rgba(127, 216, 255, 0.08);
}
.is-warning {
  color: var(--warn);
  border-color: rgba(255, 196, 107, 0.32);
  background: rgba(255, 196, 107, 0.08);
}
.is-danger {
  color: var(--danger);
  border-color: rgba(255, 111, 126, 0.32);
  background: rgba(255, 111, 126, 0.08);
}
.is-muted {
  color: var(--text-faint);
}
.progress-track {
  height: 4px;
  margin: 10px 0 6px;
  overflow: hidden;
  background: #162a33;
  border-radius: 999px;
}
.progress-track span {
  display: block;
  height: 100%;
  min-width: 0;
  background: var(--accent);
  border-radius: inherit;
  transition: width 0.3s ease;
}
.task-item__meta,
.dataset-item__meta {
  color: var(--text-faint);
  font-size: 10px;
}

.dataset-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-soft);
}
.dataset-item:last-child {
  border-bottom: 0;
}
.dataset-item__icon {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  display: grid;
  place-items: center;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 8px;
  font-size: 17px;
}
.dataset-item__body {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 6px;
}
.dataset-item__head {
  align-items: center;
}

.empty-state {
  min-height: 190px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--text-faint);
  text-align: center;
}
.empty-state strong {
  color: var(--text-dim);
  font-size: 12px;
}
.empty-state span:not(.empty-state__icon) {
  max-width: 250px;
  font-size: 11px;
}
.empty-state__icon {
  color: var(--accent);
  font-size: 25px;
  line-height: 1;
}
.empty-state .button {
  margin-top: 7px;
}
.empty-state--compact {
  min-height: 180px;
}

.bottom-grid {
  margin-top: 14px;
}
.quick-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.quick-action {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 11px;
  color: inherit;
  border: 1px solid var(--border-soft);
  border-radius: 7px;
  text-decoration: none;
}
.quick-action:hover {
  border-color: var(--border-strong);
  background: var(--panel-raised);
}
.quick-action__icon {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  display: grid;
  place-items: center;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 7px;
  font-size: 16px;
}
.quick-action > span:nth-child(2) {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.quick-action strong {
  font-size: 11px;
}
.quick-action small {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.quick-action__arrow {
  margin-left: auto;
  color: var(--text-faint);
}

.environment-list {
  display: grid;
  gap: 9px;
}
.environment-list div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-soft);
  color: var(--text-dim);
  font-size: 11px;
}
.environment-list div:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}
.environment-list strong {
  color: var(--text);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 500;
}

.console-page :is(a, button):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
.console-page .nav-item {
  font-size: 13px;
}
.console-page
  :is(.stat-card__label, .text-link, .section-note, .section-link, .environment-list div) {
  font-size: 12px;
}
.console-page :is(.task-item__name strong, .dataset-item__head strong, .empty-state strong) {
  font-size: 13px;
}
.console-page
  :is(
    .workflow-step__copy small,
    .workflow-step__copy span,
    .task-item__meta,
    .dataset-item__meta,
    .quick-action small,
    .status-pill,
    .empty-state span:not(.empty-state__icon)
  ) {
  font-size: 11px;
}

@media (prefers-reduced-motion: reduce) {
  .console-page *,
  .console-page *::after,
  .console-page *::before {
    animation: none !important;
    transition: none !important;
  }
}

@media (max-width: 1100px) {
  .console-page {
    grid-template-columns: 190px minmax(0, 1fr);
  }
  .console-hero {
    align-items: flex-start;
    flex-direction: column;
  }
  .console-hero__diagram {
    width: 100%;
    min-width: 0;
    justify-content: flex-start;
  }
}

@media (max-width: 820px) {
  .console-page {
    display: flex;
    flex-direction: column;
  }
  .console-sidebar {
    flex: none;
    padding: 12px 14px;
    border-right: 0;
    border-bottom: 1px solid var(--border-soft);
  }
  .console-brand {
    padding: 0 4px 12px;
  }
  .console-nav-label,
  .console-sidebar__bottom {
    display: none;
  }
  .console-nav {
    display: flex;
    gap: 3px;
    overflow-x: auto;
  }
  .nav-item {
    flex: 0 0 auto;
    padding: 8px 10px;
  }
  .console-main {
    flex: 1;
    padding: 22px 14px 36px;
  }
  .console-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 16px;
  }
  .console-header__actions {
    justify-content: flex-start;
  }
  .stats-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .workflow-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px 0;
  }
  .content-grid,
  .bottom-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 540px) {
  .console-nav {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 2px;
    overflow: visible;
  }
  .console-page .nav-item {
    justify-content: center;
    gap: 0;
    padding: 9px 2px;
    font-size: 12px;
    white-space: nowrap;
  }
  .nav-item__icon {
    display: none;
  }
  .console-hero {
    padding: 21px;
  }
  .console-hero__diagram {
    display: none;
  }
  .diagram-node {
    width: 90px;
    min-height: 90px;
    padding: 9px;
  }
  .diagram-arrow {
    font-size: 16px;
  }
  .hero-links {
    align-items: flex-start;
    flex-direction: column;
    gap: 9px;
  }
  .quick-actions {
    grid-template-columns: 1fr;
  }
  .sync-time {
    display: none;
  }
  .workflow-list {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .task-item__head {
    align-items: flex-start;
  }
  .task-item__name {
    flex-wrap: wrap;
  }
  .task-item__name strong {
    flex: 1;
    min-width: 0;
  }
  .task-item__count {
    flex: none;
  }
  .dataset-item__head {
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 5px;
  }
  .dataset-item__meta {
    flex-wrap: wrap;
    gap: 6px;
  }
}
</style>
