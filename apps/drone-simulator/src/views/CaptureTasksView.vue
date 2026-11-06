<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { CAPTURE_SERVICE_URL, captureRequest } from '../capture/api'
import type { CaptureManifest, CaptureShotPlan, CaptureTask } from '../capture/api'

const name = ref('城市场景采集')
const shots = ref<CaptureShotPlan[]>([
  { id: 'view-01', positionEnu: [0, 0, 6], heading: 0, pitch: -25 },
  { id: 'view-02', positionEnu: [2, 0, 6], heading: 350, pitch: -25 },
  { id: 'view-03', positionEnu: [4, 0, 6], heading: 340, pitch: -25 },
])
const tasks = ref<CaptureTask[]>([])
const route = useRoute()
const resultPanel = ref<HTMLElement | null>(null)
const selectedId = ref<string | null>(null)
const selected = computed(() => tasks.value.find((task) => task.task_id === selectedId.value) ?? null)
const frames = ref<CaptureManifest['frames']>([])
const busy = ref(false)
const connected = ref(false)
const note = ref('')
let refreshing = false, disposed = false, timer: ReturnType<typeof setInterval> | undefined
const labels: Record<CaptureTask['status'], string> = {
  queued: '等待执行', running: '采集中', paused: '已暂停', failed: '执行失败', completed: '采集完成',
}

function imageUrl(task: CaptureTask, frameId: string): string {
  return `${CAPTURE_SERVICE_URL}/api/v1/datasets/${encodeURIComponent(task.dataset_id)}/images/${encodeURIComponent(frameId)}`
}
function leaseExpired(task: CaptureTask): boolean {
  return task.status === 'running' && !!task.lease_expires_at && Date.parse(task.lease_expires_at) < Date.now()
}
async function refresh(): Promise<void> {
  if (refreshing || disposed) return
  refreshing = true
  try {
    const next = await captureRequest<CaptureTask[]>('/capture-tasks')
    if (disposed) return
    const previousStatus = selected.value?.status
    tasks.value = next
    connected.value = true
    if (!selectedId.value && next.length) {
      const requested = typeof route.query.task === 'string' ? next.find((task) => task.task_id === route.query.task) : null
      selectedId.value = requested?.task_id ?? next[0]!.task_id
    }
    const current = selected.value
    if (previousStatus && current?.status !== previousStatus) note.value = ''
    const currentId = current?.task_id
    if (current && current.uploaded) {
      const manifest = await captureRequest<CaptureManifest>(`/datasets/${current.dataset_id}/manifest`)
      if (!disposed && selectedId.value === currentId) frames.value = manifest.frames
    } else frames.value = []
  } catch {
    if (!disposed) connected.value = false
  } finally { refreshing = false }
}
async function create(): Promise<void> {
  if (busy.value) return
  busy.value = true; note.value = ''
  try {
    const task = await captureRequest<CaptureTask>('/capture-tasks', {
      name: name.value.trim(),
      plan: { schemaVersion: 1, taskId: `capture-${crypto.randomUUID()}`, sceneId: 'three-demo-city-webgl-husky-v1', maxAttempts: 2, shots: shots.value },
    })
    tasks.value = [task, ...tasks.value]
    selectedId.value = task.task_id; frames.value = []
    note.value = '任务已下发，等待采集端领取。'
    connected.value = true
  } catch (error) { note.value = error instanceof Error ? error.message : '任务创建失败' }
  finally { busy.value = false }
}
async function control(task: CaptureTask, action: 'pause' | 'resume'): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const updated = await captureRequest<CaptureTask>(`/capture-tasks/${task.task_id}/${action}`, {})
    tasks.value = tasks.value.map((item) => item.task_id === updated.task_id ? updated : item)
    note.value = action === 'pause' ? '已请求暂停，当前拍点完成后生效。' : '任务已恢复，等待原采集端继续执行。'
  } catch (error) { note.value = error instanceof Error ? error.message : '操作失败' }
  finally { busy.value = false }
}
function addShot(): void {
  const count = shots.value.length
  shots.value.push({ id: `view-${crypto.randomUUID().slice(0, 8)}`, positionEnu: [Math.min(100, count * 2), 0, 6], heading: (360 - count * 10 % 360) % 360, pitch: -25 })
}
function selectTask(task: CaptureTask): void {
  selectedId.value = task.task_id; frames.value = []
  void refresh()
}
onMounted(() => {
  void refresh().then(async () => {
    await nextTick()
    if (!disposed && selectedId.value === route.query.task) resultPanel.value?.scrollIntoView({ block: 'start' })
  })
  timer = setInterval(() => void refresh(), 2000)
})
onScopeDispose(() => { disposed = true; clearInterval(timer) })
</script>

<template>
  <div class="capture-page">
    <header class="capture-header">
      <div><h1>采集任务</h1><p>下发拍摄计划，查看执行进度和采集成果。</p></div>
      <div class="header-actions"><span :class="connected ? 'online' : 'offline'">{{ connected ? '采集服务已连接' : '采集服务未连接' }}</span><RouterLink to="/console">控制台</RouterLink><RouterLink to="/">返回沙盒</RouterLink></div>
    </header>
    <p v-if="!connected" class="notice" role="status">请启动采集服务和采集执行端，任务会在连接后继续。</p>
    <p v-if="note" class="notice" role="status">{{ note }}</p>
    <main class="capture-layout">
      <section class="panel plan-panel">
        <h2>创建采集计划</h2>
        <form @submit.prevent="create">
          <label class="name-field">任务名称<input v-model="name" required maxlength="200" aria-label="任务名称" /></label>
          <p class="hint">城市仿真场景 · 坐标相对场景原点 · 单位米 · 航向 0° 朝北</p>
          <div class="table-scroll"><table>
            <thead><tr><th>拍点</th><th>东</th><th>北</th><th>高度</th><th>航向°</th><th>俯仰°</th><th></th></tr></thead>
            <tbody><tr v-for="(shot, index) in shots" :key="shot.id">
              <td>{{ index + 1 }}</td>
              <td><input v-model.number="shot.positionEnu[0]" type="number" required min="-100" max="100" step="any" :aria-label="`拍点${index + 1}东`" /></td>
              <td><input v-model.number="shot.positionEnu[1]" type="number" required min="-100" max="100" step="any" :aria-label="`拍点${index + 1}北`" /></td>
              <td><input v-model.number="shot.positionEnu[2]" type="number" required min="1" max="100" step="any" :aria-label="`拍点${index + 1}高度`" /></td>
              <td><input v-model.number="shot.heading" type="number" required min="0" max="360" step="any" :aria-label="`拍点${index + 1}航向`" /></td>
              <td><input v-model.number="shot.pitch" type="number" required min="-90" max="60" step="any" :aria-label="`拍点${index + 1}俯仰`" /></td>
              <td><button type="button" :disabled="shots.length <= 2 || busy" :aria-label="`删除拍点${index + 1}`" @click="shots.splice(index, 1)">删除</button></td>
            </tr></tbody>
          </table></div>
          <div class="form-actions"><button type="button" :disabled="shots.length >= 200 || busy" @click="addShot">添加拍点</button><button class="primary" type="submit" :disabled="busy || !connected">下发采集任务</button></div>
        </form>
      </section>
      <section class="panel task-panel">
        <h2>任务记录</h2>
        <p v-if="!tasks.length" class="hint">暂无采集任务。</p>
        <button v-for="task in tasks" :key="task.task_id" class="task-row" :class="{ selected: selectedId === task.task_id }" @click="selectTask(task)">
          <span><strong>{{ task.name }}</strong><small>{{ labels[task.status] }}{{ task.pause_requested ? ' · 正在暂停' : '' }}</small></span>
          <span>{{ task.uploaded }} / {{ task.total }}</span>
        </button>
      </section>
      <section v-if="selected" ref="resultPanel" class="panel result-panel" data-testid="capture-task-detail">
        <div class="result-header"><h2>{{ selected.name }}</h2><span>{{ labels[selected.status] }}</span></div>
        <p>已采集 {{ selected.completed }} / {{ selected.total }} 张，已登记 {{ selected.uploaded }} 张。</p>
        <progress :value="selected.uploaded" :max="selected.total" aria-label="采集进度" />
        <p v-if="selected.status === 'queued'" class="hint">{{ selected.worker_id ? '等待原采集端连接，接续已有照片。' : '等待采集端领取任务。' }}</p>
        <p v-if="leaseExpired(selected)" class="notice">采集端连接已中断，原采集端重新连接后可继续。</p>
        <p v-if="selected.pause_requested" class="hint">正在等待当前拍点完成。</p>
        <p v-if="selected.error" class="error">{{ selected.error }}</p>
        <div class="form-actions">
          <button v-if="selected.status === 'queued' || selected.status === 'running'" :disabled="busy || selected.pause_requested" @click="control(selected, 'pause')">暂停任务</button>
          <button v-if="selected.status === 'paused' || selected.status === 'failed' || leaseExpired(selected)" class="primary" :disabled="busy" @click="control(selected, 'resume')">继续任务</button>
          <a v-if="selected.uploaded" :href="`${CAPTURE_SERVICE_URL}/api/v1/datasets/${selected.dataset_id}/manifest`" target="_blank" rel="noopener">查看采集清单</a>
        </div>
        <p v-if="selected.status === 'completed'" class="hint">照片及相机参数已校验并登记，数据集已封存。</p>
        <div class="image-grid"><figure v-for="frame in frames" :key="frame.frameId">
          <a :href="imageUrl(selected, frame.frameId)" target="_blank" rel="noopener"><img :src="imageUrl(selected, frame.frameId)" :alt="`采集照片 ${frame.metadata?.shotId ?? frame.frameId}`" loading="lazy" /></a>
          <figcaption>{{ frame.metadata?.shotId ?? frame.frameId }} · {{ frame.width }} × {{ frame.height }}</figcaption>
        </figure></div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.capture-page { max-width: 1500px; margin: 0 auto; padding: 24px; height: 100%; overflow: auto; }
.capture-page a { color: var(--accent, #62d2ae); }
.capture-header, .header-actions, .result-header, .form-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 26px; } h2 { margin: 0 0 18px; font-size: 18px; }
p { line-height: 1.6; } .hint, small, figcaption, .capture-header p { color: var(--text-muted, #93a9b5); font-size: 13px; }
.capture-layout { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(280px, 1fr); gap: 20px; }
.panel { padding: 22px; border: 1px solid var(--border-soft, #29434c); border-radius: 12px; background: var(--panel, #12252e); min-width: 0; }
.result-panel { grid-column: 1 / -1; }
.name-field { display: grid; gap: 8px; font-size: 14px; }
input { width: 100%; min-width: 55px; color: inherit; background: var(--bg, #0d1e27); border: 1px solid var(--border-soft, #29434c); padding: 9px; border-radius: 6px; }
.table-scroll { overflow-x: auto; } table { width: 100%; min-width: 620px; table-layout: fixed; border-collapse: collapse; margin: 16px 0; } th, td { text-align: left; padding: 6px; font-size: 12px; } th { color: var(--text-muted, #93a9b5); white-space: nowrap; }
th:first-child { width: 42px; } th:last-child { width: 64px; } td:last-child button { width: 100%; padding: 9px 6px; white-space: nowrap; }
button { padding: 9px 14px; border: 1px solid var(--border-soft, #29434c); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
button:disabled { opacity: .45; cursor: default; } .primary { background: #177765; border-color: #279783; color: white; }
.notice { padding: 12px 16px; border-radius: 8px; background: #19313c; } .error, .offline { color: #f0b1a4; } .online { color: #62d2ae; }
.task-row { width: 100%; display: flex; text-align: left; justify-content: space-between; gap: 12px; margin-top: 8px; padding: 14px; }
.task-row span:first-child { display: grid; gap: 7px; } .task-row.selected { border-color: #3bb29b; background: #163a3c; }
.result-header h2 { margin-bottom: 0; } progress { width: 100%; height: 9px; accent-color: #3bb29b; margin-bottom: 16px; }
.image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 16px; margin-top: 22px; }
figure { margin: 0; } img { width: 100%; aspect-ratio: 4 / 3; object-fit: contain; background: #0a171e; border-radius: 8px; } figcaption { padding-top: 7px; }
@media (max-width: 900px) { .capture-layout { grid-template-columns: 1fr; } .capture-page { padding: 14px; } }
</style>
