<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { createGaussianSplatViewer } from '@simulation/three-adapter'
import type {
  GaussianSplatScene,
  GaussianTestCamera,
  GaussianViewerStats,
} from '@simulation/three-adapter'
import { CAPTURE_SERVICE_URL } from '../capture/api'

interface ModelReport {
  gaussians: number
  steps: number
  width: number
  height: number
  test_frames: string[]
}
const route = useRoute()
const jobId = computed(() => String(route.params.jobId ?? ''))
const resultLink = computed(() => ({ path: '/experiments', query: { job: jobId.value } }))
const modelUrl = computed(
  () =>
    `${CAPTURE_SERVICE_URL}/api/v1/experiments/${encodeURIComponent(jobId.value)}/artifacts/model.ply`,
)
const container = ref<HTMLDivElement | null>(null)
const loading = ref(true)
const error = ref('')
const status = ref('正在读取实验结果…')
const report = ref<ModelReport | null>(null)
const testCameras = ref<GaussianTestCamera[]>([])
const selectedCamera = ref('overview')
const autoRotate = ref(false)
const stats = ref<GaussianViewerStats>({ fps: 0, width: 0, height: 0, gaussians: 0 })
let viewer: GaussianSplatScene | null = null
let controller: AbortController | null = null
let generation = 0
let disposed = false

async function load(): Promise<void> {
  const current = ++generation
  controller?.abort()
  viewer?.dispose()
  viewer = null
  controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)])
  const active = () => !disposed && current === generation
  loading.value = true
  error.value = ''
  autoRotate.value = false
  selectedCamera.value = 'overview'
  report.value = null
  testCameras.value = []
  stats.value = { fps: 0, width: 0, height: 0, gaussians: 0 }
  status.value = '正在读取实验结果…'
  async function read<T>(path: string): Promise<T> {
    const response = await fetch(`${CAPTURE_SERVICE_URL}${path}`, { signal })
    if (!response.ok)
      throw new Error(
        response.status === 404
          ? '找不到这次实验的模型，请返回实验结果确认。'
          : `实验结果读取失败（${response.status}）`,
      )
    return (await response.json()) as T
  }
  let next: GaussianSplatScene | null = null
  try {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(jobId.value)) throw new Error('实验编号无效')
    const base = `/api/v1/experiments/${jobId.value}/artifacts/`
    const job = await read<{ status: string; backend: string }>(`/api/v1/jobs/${jobId.value}`)
    if (job.status !== 'completed') throw new Error('这次实验尚未完成，请先等待训练和模型导出。')
    if (job.backend !== 'torch-3dgs-reference')
      throw new Error('这次实验尚未提供可展示的高斯模型。')
    const [metadata, manifest] = await Promise.all([
      read<ModelReport>(base + 'report.json'),
      read<{ coordinateFrame: string; frames: GaussianTestCamera[] }>(base + 'manifest.json'),
    ])
    if (!active()) return
    if (manifest.coordinateFrame !== 'platform-world')
      throw new Error('模型与平台坐标不一致，暂时无法展示。')
    report.value = metadata
    testCameras.value = metadata.test_frames
      .map((id) => manifest.frames.find((frame) => frame.frameId === id))
      .filter((frame): frame is GaussianTestCamera => Boolean(frame))
    if (!container.value) return
    status.value = '正在准备三维显示…'
    next = await createGaussianSplatViewer(container.value, {
      onStats: (value) => {
        if (active()) stats.value = value
      },
      onError: (message) => {
        if (active()) {
          error.value = message
          loading.value = false
        }
      },
    })
    if (!active()) {
      next.dispose()
      return
    }
    viewer = next
    status.value = '正在加载高斯模型…'
    const count = await next.load(modelUrl.value)
    if (!active()) return
    if (count !== metadata.gaussians)
      throw new Error('模型中的高斯数量与报告不一致，请确认模型文件完整。')
    stats.value = { ...stats.value, gaussians: count }
    loading.value = false
    status.value = '模型已加载'
  } catch (failure) {
    next?.dispose()
    if (!active()) return
    viewer = null
    loading.value = false
    error.value = failure instanceof Error ? failure.message : '模型加载失败'
  }
}

function reset(): void {
  selectedCamera.value = 'overview'
  autoRotate.value = false
  viewer?.setAutoRotate(false)
  viewer?.reset()
}
function top(): void {
  selectedCamera.value = 'top'
  autoRotate.value = false
  viewer?.setAutoRotate(false)
  viewer?.top()
}
function selectCamera(): void {
  autoRotate.value = false
  viewer?.setAutoRotate(false)
  const camera = testCameras.value.find((view) => view.frameId === selectedCamera.value)
  if (camera) viewer?.setTestCamera(camera)
  else if (selectedCamera.value === 'top') viewer?.top()
  else viewer?.reset()
}
function toggleOrbit(): void {
  autoRotate.value = !autoRotate.value
  viewer?.setAutoRotate(autoRotate.value)
}

onMounted(() => void load())
watch(jobId, () => void load())
onBeforeUnmount(() => {
  disposed = true
  generation++
  controller?.abort()
  viewer?.dispose()
  viewer = null
})
</script>

<template>
  <main
    class="gaussian-page"
    data-testid="gaussian-viewer"
    :data-state="error ? 'error' : loading ? 'loading' : 'ready'"
  >
    <header class="model-header">
      <div class="model-heading">
        <RouterLink :to="resultLink" class="back-link">← 实验结果</RouterLink>
        <h1>高斯三维模型</h1>
        <span class="model-id">{{ jobId }}</span>
      </div>
      <div class="model-details" v-if="report">
        <span>{{ report.gaussians.toLocaleString() }} 个高斯</span
        ><span>训练 {{ report.steps }} 步 · {{ report.width }} × {{ report.height }}</span>
      </div>
    </header>
    <div class="model-toolbar">
      <label
        >视角<select
          v-model="selectedCamera"
          :disabled="loading || !!error"
          aria-label="三维模型视角"
          @change="selectCamera"
        >
          <option value="overview">整体视角</option>
          <option value="top">俯视</option>
          <option
            v-for="(camera, index) in testCameras"
            :key="camera.frameId"
            :value="camera.frameId"
          >
            测试视角 {{ index + 1 }}
          </option>
        </select></label
      >
      <div class="toolbar-actions">
        <button :disabled="loading || !!error" @click="reset">重置视角</button
        ><button :disabled="loading || !!error" @click="top">俯视</button
        ><button :disabled="loading || !!error" :aria-pressed="autoRotate" @click="toggleOrbit">
          {{ autoRotate ? '停止环绕' : '自动环绕' }}</button
        ><a v-if="report" :href="modelUrl">下载 PLY</a>
      </div>
    </div>
    <section class="model-stage" aria-label="高斯模型三维视口">
      <div ref="container" class="model-canvas" />
      <div v-if="loading" class="stage-message" role="status">
        <span class="loading-ring" />
        <p>{{ status }}</p>
      </div>
      <div v-else-if="error" class="stage-message failure" role="alert">
        <p>{{ error }}</p>
        <button @click="load">重新加载</button
        ><RouterLink :to="resultLink">返回实验结果</RouterLink>
      </div>
      <span v-else class="stage-badge">三维高斯 · 可交互</span>
    </section>
    <footer class="model-footer">
      <span>左键旋转 · 右键平移 · 滚轮缩放 · 触屏双指缩放与平移</span
      ><span v-if="!loading && !error" data-testid="gaussian-fps"
        >浏览器 {{ stats.fps.toFixed(0) }} FPS · {{ stats.width }} × {{ stats.height }}</span
      >
    </footer>
    <p class="model-note">
      展示本次训练导出的模型。测试视角沿用采集相机位置和方向，显示范围随窗口比例变化。浏览器帧率受屏幕刷新率影响，与报告中的后端测速分开计算。
    </p>
  </main>
</template>

<style scoped>
.gaussian-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  color: #dce7e7;
  background: #081219;
}
.model-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
  padding: 22px 28px;
  border-bottom: 1px solid #25363e;
}
.model-heading,
.model-details,
.toolbar-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 18px;
}
h1 {
  font-size: 19px;
  font-weight: 500;
  margin: 0;
}
a {
  color: #8ddac9;
  text-decoration: none;
  font-size: 13px;
}
.model-id,
.model-details {
  color: #91a4ab;
  font-size: 12px;
}
.model-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 28px;
  background: #0d1b23;
}
label {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: #a5b8bf;
  white-space: nowrap;
}
select {
  width: auto;
  min-width: 150px;
  padding: 8px 10px;
  background: #132630;
  border: 1px solid #30464f;
  border-radius: 6px;
  color: #e3eded;
}
button {
  font-size: 12px;
}
button[aria-pressed='true'] {
  color: #b8eedf;
  background: #153a36;
  border-color: #5bb59f;
}
.model-stage {
  position: relative;
  flex: 1;
  min-height: 340px;
  overflow: hidden;
  background: #0a141b;
}
.model-canvas {
  position: absolute;
  inset: 0;
}
.model-canvas :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
}
.stage-message {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 12px;
  background: #0a141be8;
  color: #afc2c7;
  font-size: 14px;
  padding: 24px;
  text-align: center;
}
.failure {
  color: #ffc7ba;
}
.stage-badge {
  position: absolute;
  left: 24px;
  top: 18px;
  pointer-events: none;
  padding: 8px 12px;
  border: 1px solid #30464f;
  border-radius: 20px;
  background: #0d1b23b0;
  color: #9be0cf;
  font-size: 12px;
}
.model-footer {
  padding: 12px 28px;
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: #afc2c7;
  border-top: 1px solid #25363e;
}
.model-note {
  color: #7c939d;
  padding: 0 28px 14px;
  margin: 0;
  font-size: 11px;
  line-height: 1.7;
}
.loading-ring {
  border: 2px solid #30464f;
  border-top-color: #8ddac9;
  border-radius: 50%;
  width: 24px;
  height: 24px;
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .loading-ring {
    animation: none;
  }
}
@media (max-width: 700px) {
  .model-header,
  .model-toolbar,
  .model-footer {
    padding: 14px 16px;
  }
  .model-heading,
  .model-details,
  .toolbar-actions {
    gap: 12px;
  }
  .model-id {
    display: none;
  }
  .model-note {
    padding: 0 16px 12px;
  }
  .model-stage {
    min-height: 420px;
  }
}
</style>
