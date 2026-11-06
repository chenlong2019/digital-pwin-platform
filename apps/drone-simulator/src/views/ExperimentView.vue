<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import CampusCaptureStage from '../components/CampusCaptureStage.vue'
import { CAPTURE_SERVICE_URL, serviceRequest } from '../capture/api'
import { campusCapturePlan } from '../experiments/campus-plan'
import { CAMPUS_SCENE_ID } from '../simulation/scenes/campus-scene'

interface ExperimentJob {
  job_id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  error: string | null
  request: { dataset_id: string; steps: number; gaussians: number; seed: number }
  result: { stage?: string; step?: number; steps?: number; loss?: number } | null
}
interface TestView {
  frame_id: string
  psnr: number
  ssim: number
  reference_image: string
  prediction_image: string
  difference_image: string
}
interface ExperimentReport {
  backend: string
  width: number
  height: number
  gaussians: number
  training_seconds: number
  device: string
  train_frames: string[]
  test_frames: string[]
  views: TestView[]
  quality: {
    psnr: number
    ssim: number
    foreground_psnr: number | null
    foreground_fraction: number
  }
  initial_quality: { psnr: number; ssim: number }
  performance: { fps: number; p50_ms: number; p95_ms: number; peak_allocated_mb: number }
}
const storageKey = 'campus.experiment.active'
const route = useRoute()
const router = useRouter()
const plan = campusCapturePlan()
const stage = ref<InstanceType<typeof CampusCaptureStage> | null>(null)
const resultsSection = ref<HTMLElement | null>(null)
const sceneReady = ref(false)
const connected = ref(false)
const connecting = ref(false)
const gpu = ref('')
const steps = ref(400)
const gaussians = ref(8000)
const datasetId = ref('')
const job = ref<ExperimentJob | null>(null)
const report = ref<ExperimentReport | null>(null)
const capturing = ref(false)
const submitting = ref(false)
const captured = ref(0)
const message = ref('正在加载园区与实验服务…')
const error = ref('')
const selectedView = ref(0)
let disposed = false
let captureStop = false
let pollTimer = 0
let polling = false

const busy = computed(
  () =>
    capturing.value || submitting.value || ['running', 'queued'].includes(job.value?.status ?? ''),
)
const canStart = computed(() => connected.value && sceneReady.value && !busy.value)
const phase = computed(() =>
  capturing.value
    ? 0
    : job.value?.status === 'completed'
      ? 4
      : job.value?.result?.stage === 'evaluating'
        ? 2
        : job.value
          ? 1
          : captured.value
            ? 0
            : -1,
)
const progress = computed(() =>
  capturing.value
    ? Math.round((captured.value / plan.length) * 100)
    : job.value?.result?.steps
      ? Math.round(((job.value.result.step ?? 0) / job.value.result.steps) * 100)
      : 0,
)
const currentView = computed(() => report.value?.views[selectedView.value])
const stageLabel = computed(
  () =>
    ({
      starting: '准备训练环境',
      preparing: '准备数据与高斯初始化',
      training: '优化高斯参数',
      evaluating: '渲染独立测试视角并评价',
      completed: '实验已完成',
      stopped: '实验已停止',
      failed: '实验未完成',
    })[job.value?.result?.stage ?? 'starting'],
)

function persist(): void {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ datasetId: datasetId.value, jobId: job.value?.job_id }),
    )
  } catch {
    /* current session remains usable */
  }
}
function artifact(name: string): string {
  return `${CAPTURE_SERVICE_URL}/api/v1/experiments/${job.value?.job_id}/artifacts/${name}`
}
function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function showResults(): void {
  resultsSection.value?.scrollIntoView({ block: 'start' })
  resultsSection.value?.focus({ preventScroll: true })
}

async function loadJob(id: string): Promise<void> {
  if (polling || disposed) return
  polling = true
  try {
    const next = await serviceRequest<ExperimentJob>(`/api/v1/jobs/${id}`)
    if (disposed) return
    job.value = next
    datasetId.value = next.request.dataset_id
    steps.value = next.request.steps
    gaussians.value = next.request.gaussians
    connected.value = true
    error.value = ''
    persist()
    if (next.status === 'completed' && !report.value) {
      report.value = await serviceRequest<ExperimentReport>(
        `/api/v1/experiments/${id}/artifacts/report.json`,
      )
      message.value = '独立测试与评价已完成，结果已保存。'
    }
    if (next.status === 'failed') error.value = next.error ?? '实验未完成，请查看日志。'
  } catch (failure) {
    if (!disposed) error.value = describe(failure)
  } finally {
    polling = false
  }
}

async function train(resume = false): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  error.value = ''
  try {
    const dataset = await serviceRequest<{ status: string }>(`/api/v1/datasets/${datasetId.value}`)
    if (dataset.status === 'draft') {
      const manifest = await serviceRequest<{ frames: Array<{ metadata?: { split?: string } }> }>(
        `/api/v1/datasets/${datasetId.value}/manifest`,
      )
      if (
        manifest.frames.filter((frame) => frame.metadata?.split === 'train').length < 8 ||
        manifest.frames.filter((frame) => frame.metadata?.split === 'test').length < 2
      ) {
        throw new Error('至少需要 8 个训练视角和 2 个独立测试视角，请继续采集。')
      }
      await serviceRequest(`/api/v1/datasets/${datasetId.value}/finalize`, {})
    }
    const next = await serviceRequest<ExperimentJob>('/api/v1/experiments', {
      dataset_id: datasetId.value,
      steps: steps.value,
      gaussians: gaussians.value,
      ...(resume && job.value
        ? { resume_job_id: job.value.job_id, seed: job.value.request.seed }
        : {}),
    })
    job.value = next
    report.value = null
    selectedView.value = 0
    persist()
    await router.replace({ query: { job: next.job_id } })
    message.value = '训练已提交，刷新页面后可继续查看进度。'
  } catch (failure) {
    error.value = describe(failure)
  } finally {
    submitting.value = false
  }
}

async function start(resumeCapture = false): Promise<void> {
  if (!canStart.value || !stage.value) return
  error.value = ''
  captureStop = false
  capturing.value = true
  report.value = null
  job.value = null
  try {
    if (!resumeCapture || !datasetId.value) {
      datasetId.value = ''
      await router.replace({ query: {} })
      const scenes = await serviceRequest<Array<{ scene_id: string }>>('/api/v1/scenes')
      if (!scenes.some((scene) => scene.scene_id === CAMPUS_SCENE_ID))
        await serviceRequest('/api/v1/scenes', {
          sceneId: CAMPUS_SCENE_ID,
          name: '园区点云',
          coordinate_frame: 'platform-world',
          metadata: { source: 'campus-road-v2', synthetic: true },
        })
      datasetId.value = `campus-${Date.now()}`
      await serviceRequest('/api/v1/datasets', {
        datasetId: datasetId.value,
        name: '园区 3DGS 基线实验',
        sceneId: CAMPUS_SCENE_ID,
        sceneVersion: 'lod3-fixed',
        metadata: {
          workflow: 'campus-3dgs',
          capturePlan: plan,
          source: 'simulation-point-cloud',
          cameraConvention: 'opengl-camera-to-world',
          frozenLod: 3,
          source_identity: stage.value.sourceIdentity(),
        },
      })
      captured.value = 0
      persist()
    }
    const manifest = await serviceRequest<{ frames: Array<{ frameId: string }> }>(
      `/api/v1/datasets/${datasetId.value}/manifest`,
    )
    const existing = new Set(manifest.frames.map((frame) => frame.frameId))
    captured.value = existing.size
    for (let i = 0; i < plan.length; i++) {
      if (disposed || captureStop) {
        message.value = '采集已暂停，可继续已保存的进度。'
        return
      }
      const view = plan[i]!
      const frameId = `${datasetId.value}-${view.id}`
      if (existing.has(frameId)) continue
      const shot = stage.value.capture(view)
      await serviceRequest(`/api/v1/datasets/${datasetId.value}/frames`, {
        frameId,
        imageDataUrl: shot.dataUrl,
        width: shot.intrinsics.width,
        height: shot.intrinsics.height,
        simulationTime: i,
        capturedAt: new Date().toISOString(),
        cameraPose: shot.pose,
        cameraIntrinsics: shot.intrinsics,
        metadata: { split: view.split, captureIndex: i, cameraConvention: 'opengl', frozenLod: 3 },
      })
      captured.value++
      message.value = `已采集 ${captured.value} / ${plan.length} 个视角`
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    }
    if (disposed || captureStop) {
      message.value = '采集已暂停，可继续已保存的进度。'
      return
    }
    await serviceRequest(`/api/v1/datasets/${datasetId.value}/finalize`, {})
    capturing.value = false
    await train()
  } catch (failure) {
    if (!disposed) error.value = describe(failure)
  } finally {
    capturing.value = false
  }
}

async function stop(): Promise<void> {
  if (capturing.value) {
    captureStop = true
    return
  }
  if (job.value) {
    try {
      await serviceRequest(`/api/v1/experiments/${job.value.job_id}/stop`, {})
      message.value = '正在停止，已保存的检查点可用于恢复。'
    } catch (failure) {
      error.value = describe(failure)
    }
  }
}

async function connect(): Promise<void> {
  if (connecting.value) return
  connecting.value = true
  try {
    const capability = await serviceRequest<{ gpu: string | null }>(
      '/api/v1/experiments/capabilities',
    )
    if (disposed) return
    connected.value = true
    error.value = ''
    gpu.value = capability.gpu ?? '未检测到 NVIDIA GPU'
    message.value = '准备就绪，可以开始第一轮实验。'
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as {
      datasetId: string
      jobId?: string
    } | null
    const linkedJob = typeof route.query.job === 'string' ? route.query.job : ''
    if (linkedJob) await loadJob(linkedJob)
    else if (saved) {
      datasetId.value = saved.datasetId
      if (saved.jobId) await loadJob(saved.jobId)
      else {
        const manifest = await serviceRequest<{ frames: unknown[] }>(
          `/api/v1/datasets/${saved.datasetId}/manifest`,
        )
        captured.value = manifest.frames.length
        message.value = '上次采集尚未提交训练，可继续采集或直接提交已有数据。'
      }
    }
  } catch (failure) {
    if (!disposed) {
      connected.value = false
      error.value = describe(failure)
    }
  } finally {
    connecting.value = false
  }
}

onMounted(() => {
  void connect()
  pollTimer = window.setInterval(() => {
    if (
      job.value &&
      (['running', 'queued'].includes(job.value.status) ||
        (job.value.status === 'completed' && !report.value))
    )
      void loadJob(job.value.job_id)
  }, 2000)
})
onBeforeUnmount(() => {
  disposed = true
  captureStop = true
  window.clearInterval(pollTimer)
})
</script>

<template>
  <main class="experiment" tabindex="0" aria-labelledby="experiment-title">
    <header class="experiment-header">
      <div>
        <p class="eyebrow">神经渲染 / 算法验证</p>
        <h1 id="experiment-title">园区 3DGS 实验</h1>
        <p class="subtitle">采集、重建与独立测试，在一次实验中完成。</p>
      </div>
      <nav>
        <button v-if="report" class="results-link" @click="showResults">查看结果 ↓</button>
        <RouterLink to="/console">控制台</RouterLink><RouterLink to="/">仿真沙盒</RouterLink>
      </nav>
    </header>
    <ol class="workflow">
      <li
        v-for="(label, index) in ['自动采集', '3DGS 重建', '独立视角渲染', '画质与帧率评价']"
        :key="label"
        :class="{ active: index === phase, done: index < phase }"
      >
        <span>{{ index + 1 }}</span
        >{{ label }}
      </li>
    </ol>
    <div class="experiment-grid">
      <section class="preview-card">
        <div class="section-head">
          <h2>园区采集预览</h2>
          <span>{{ sceneReady ? '场景就绪' : '载入中' }}</span>
        </div>
        <CampusCaptureStage ref="stage" @ready="sceneReady = true" @error="error = $event" />
        <div class="capture-summary">
          <span>32 个训练视角</span><span>8 个独立测试视角</span><span>256 × 192</span>
        </div>
        <p class="note">
          使用固定点云精度与虚拟相机轨迹，测试视角在采集前独立划分。该轨迹用于成像实验，未校验无人机可飞性。
        </p>
      </section>
      <section class="settings-card">
        <div class="section-head">
          <h2>实验设置</h2>
          <span :class="connected ? 'online' : ''">{{
            connected ? '服务在线' : '服务未连接'
          }}</span>
        </div>
        <button v-if="!connected" :disabled="connecting" @click="connect">
          {{ connecting ? '正在连接…' : '重新连接服务' }}
        </button>
        <label
          >训练步数<select v-model.number="steps" :disabled="busy" data-testid="experiment-steps">
            <option :value="400">400 · 快速验证</option>
            <option :value="1200">1200 · 更充分训练</option>
          </select></label
        >
        <label
          >高斯数量<input
            v-model.number="gaussians"
            type="number"
            min="1000"
            max="20000"
            step="1000"
            :disabled="busy"
        /></label>
        <p class="device">{{ gpu || '正在检测计算设备…' }}</p>
        <button
          class="start-button"
          :disabled="!canStart"
          data-testid="experiment-start"
          @click="start(false)"
        >
          开始完整实验
        </button>
        <div class="secondary-actions">
          <button v-if="!busy && datasetId && !job" :disabled="!canStart" @click="start(true)">
            继续采集
          </button>
          <button v-if="!busy && datasetId && !job" :disabled="!connected" @click="train()">
            提交已有数据训练
          </button>
          <button
            v-if="job?.status === 'failed'"
            :disabled="busy || !connected"
            @click="train(true)"
          >
            从检查点恢复
          </button>
          <button
            v-if="capturing || ['running', 'queued'].includes(job?.status ?? '')"
            @click="stop"
          >
            停止实验
          </button>
        </div>
        <div
          class="run-status"
          data-testid="experiment-status"
          :data-status="capturing ? 'capturing' : (job?.status ?? 'idle')"
          :data-job-id="job?.job_id ?? ''"
        >
          <strong>{{
            capturing ? `采集 ${captured} / ${plan.length}` : job ? stageLabel : '等待开始'
          }}</strong>
          <progress v-if="busy || job?.status === 'completed'" :value="progress" max="100" />
          <span v-if="job?.result?.step"
            >{{ job.result.step }} / {{ job.result.steps }} 步<span v-if="job.result.loss != null">
              · Loss {{ job.result.loss.toFixed(4) }}</span
            ></span
          >
          <p>{{ message }}</p>
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p class="note">
          使用仿真点云的几何与颜色初始化、已知相机位姿和 PyTorch 3DGS
          参考后端。结果用于验证流程与算法，不代表真实照片重建或加速后端性能。
        </p>
        <a
          v-if="job"
          class="log-link"
          :href="artifact('worker.log')"
          target="_blank"
          rel="noreferrer"
          >查看运行日志</a
        >
      </section>
    </div>
    <section
      v-if="report"
      ref="resultsSection"
      class="results-card"
      data-testid="experiment-report"
      tabindex="-1"
      aria-labelledby="experiment-results-title"
    >
      <div class="section-head">
        <h2 id="experiment-results-title">独立测试结果</h2>
        <div class="downloads">
          <a :href="artifact('report.json')" target="_blank" rel="noreferrer">评价报告</a
          ><a :href="artifact('model.ply')">高斯模型 PLY</a>
        </div>
      </div>
      <div class="metric-grid">
        <div>
          <span>PSNR</span><strong>{{ report.quality.psnr.toFixed(2) }} <small>dB</small></strong>
        </div>
        <div>
          <span>SSIM</span><strong>{{ report.quality.ssim.toFixed(4) }}</strong>
        </div>
        <div>
          <span>前景 PSNR</span
          ><strong
            >{{ report.quality.foreground_psnr?.toFixed(2) ?? '—' }} <small>dB</small></strong
          >
        </div>
        <div>
          <span>渲染帧率</span
          ><strong>{{ report.performance.fps.toFixed(1) }} <small>FPS</small></strong>
        </div>
        <div>
          <span>耗时 P95</span
          ><strong>{{ report.performance.p95_ms.toFixed(1) }} <small>ms</small></strong>
        </div>
      </div>
      <p class="result-context">
        {{ report.width }} × {{ report.height }} · {{ report.gaussians.toLocaleString() }} 个高斯 ·
        训练 {{ report.training_seconds.toFixed(0) }} 秒 · GPU 张量峰值
        {{ report.performance.peak_allocated_mb?.toFixed(0) }}
        MB。帧率仅计同步后的参考后端渲染，排除图片保存、上传与评价。
      </p>
      <p class="result-context">
        初始化 → 训练后：PSNR {{ report.initial_quality.psnr.toFixed(2) }} →
        {{ report.quality.psnr.toFixed(2) }} dB；SSIM {{ report.initial_quality.ssim.toFixed(4) }} →
        {{ report.quality.ssim.toFixed(4) }}。
      </p>
      <p class="result-context">
        前景约占 {{ (report.quality.foreground_fraction * 100).toFixed(1) }}%，前景 PSNR
        排除纯背景区域；各项画质指标均取独立测试视角的平均值。
      </p>
      <label class="view-picker"
        >测试视角<select v-model.number="selectedView">
          <option v-for="(view, index) in report.views" :key="view.frame_id" :value="index">
            视角 {{ index + 1 }} · PSNR {{ view.psnr.toFixed(2) }} dB
          </option>
        </select></label
      >
      <div v-if="currentView" class="comparison-grid">
        <figure>
          <img :src="artifact(currentView.reference_image)" alt="独立视角参考图" />
          <figcaption>独立视角参考图</figcaption>
        </figure>
        <figure>
          <img :src="artifact(currentView.prediction_image)" alt="训练后的高斯渲染" />
          <figcaption>训练后的高斯渲染</figcaption>
        </figure>
        <figure>
          <img :src="artifact(currentView.difference_image)" alt="绝对误差放大三倍" />
          <figcaption>绝对误差 × 3</figcaption>
        </figure>
      </div>
    </section>
  </main>
</template>

<style scoped>
.experiment {
  /* 沙盒锁住 body 滚动；实验页独立滚动，保证下方结果可访问。 */
  height: 100%;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  scrollbar-gutter: stable;
  max-width: 1400px;
  margin: 0 auto;
  padding: 32px 36px 60px;
  color: #dce7e7;
}
.experiment-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
}
.eyebrow {
  color: #78c8ba;
  font-size: 12px;
  margin: 0 0 10px;
}
h1 {
  margin: 0;
  font-size: 28px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.subtitle {
  color: #91a4ab;
  margin: 10px 0 0;
  font-size: 14px;
}
nav,
.downloads {
  display: flex;
  align-items: center;
  gap: 16px;
}
.results-link {
  color: #9be0cf;
  background: #153a36;
  border-color: #397968;
}
a {
  color: #8ddac9;
  text-decoration: none;
  font-size: 13px;
}
.workflow {
  list-style: none;
  margin: 28px 0 22px;
  padding: 18px 22px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  background: #0d1b23;
  border: 1px solid #23343c;
  border-radius: 12px;
}
.workflow li {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #7f949d;
  font-size: 13px;
}
.workflow li span {
  border: 1px solid #344951;
  border-radius: 50%;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
}
.workflow .active,
.workflow .done {
  color: #9be0cf;
}
.workflow .active span,
.workflow .done span {
  border-color: #5bb59f;
  background: #153a36;
}
.experiment-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(320px, 1fr);
  gap: 20px;
}
.preview-card,
.settings-card,
.results-card {
  border: 1px solid #25363e;
  border-radius: 14px;
  background: #0d1b23;
  padding: 20px;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}
h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
}
.section-head > span {
  font-size: 12px;
  color: #8da2aa;
}
.section-head .online {
  color: #8ddac9;
}
.capture-summary {
  display: flex;
  justify-content: space-between;
  margin-top: 16px;
  color: #afc2c7;
  font-size: 12px;
}
.note {
  margin: 16px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: #859ba5;
}
.settings-card > label {
  display: block;
  font-size: 12px;
  color: #a5b8bf;
  margin-bottom: 16px;
}
select,
input {
  width: 100%;
  margin-top: 8px;
  padding: 10px 12px;
  background: #132630;
  border: 1px solid #30464f;
  border-radius: 7px;
  color: #e3eded;
}
.device {
  font-size: 12px;
  color: #859ba5;
  margin: 20px 0;
}
.start-button {
  width: 100%;
  padding: 12px;
  background: #75cbb7;
  color: #08251f;
  border-color: #75cbb7;
  font-size: 14px;
  font-weight: 600;
}
.start-button:disabled {
  opacity: 0.4;
}
.start-button:hover:not(:disabled) {
  background: #8cdec8;
  border-color: #8cdec8;
  color: #08251f;
}
.secondary-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.secondary-actions button {
  font-size: 12px;
}
.run-status {
  margin-top: 22px;
  font-size: 12px;
  color: #9eb1b9;
}
.run-status strong {
  color: #d9e7e7;
  font-weight: 500;
  display: block;
  margin-bottom: 10px;
}
progress {
  display: block;
  width: 100%;
  height: 6px;
  accent-color: #75cbb7;
  margin-bottom: 10px;
}
.run-status p {
  line-height: 1.7;
}
.error {
  padding: 10px 12px;
  color: #ffc7ba;
  background: #34272a;
  border-radius: 7px;
  font-size: 12px;
  line-height: 1.7;
}
.log-link {
  display: block;
  margin-top: 14px;
  font-size: 12px;
}
.results-card {
  margin-top: 22px;
  scroll-margin-top: 20px;
}
.metric-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
}
.metric-grid > div {
  background: #142832;
  border-radius: 9px;
  padding: 16px;
}
.metric-grid span {
  color: #8da7b0;
  font-size: 12px;
  display: block;
  margin-bottom: 10px;
}
.metric-grid strong {
  color: #b8eedf;
  font-size: 25px;
  font-weight: 500;
}
.metric-grid small {
  font-size: 12px;
}
.result-context {
  color: #8da4ad;
  font-size: 12px;
  line-height: 1.8;
}
.view-picker {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
  margin: 22px 0 16px;
}
.view-picker select {
  width: auto;
  margin: 0;
}
.comparison-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}
figure {
  margin: 0;
}
figure img {
  display: block;
  width: 100%;
  border-radius: 8px;
  background: #08151c;
  image-rendering: auto;
}
figcaption {
  text-align: center;
  font-size: 12px;
  color: #98afb8;
  margin-top: 10px;
}
@media (max-width: 900px) {
  .experiment {
    padding: 20px 16px;
  }
  .experiment-grid {
    grid-template-columns: 1fr;
  }
  .workflow {
    gap: 14px;
    grid-template-columns: repeat(2, 1fr);
  }
  .metric-grid {
    grid-template-columns: repeat(3, 1fr);
  }
  .comparison-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 480px) {
  .experiment-header {
    align-items: flex-start;
    flex-direction: column;
  }
  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .capture-summary {
    gap: 8px;
    flex-wrap: wrap;
  }
  .view-picker {
    align-items: flex-start;
    flex-direction: column;
  }
  .view-picker select {
    max-width: 100%;
  }
  .section-head {
    flex-wrap: wrap;
  }
}
</style>
