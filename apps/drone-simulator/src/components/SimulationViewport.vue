<script setup lang="ts">
/**
 * SimulationViewport —— 三维视口的宿主。
 *
 * 它是**唯一**知道 three 存在的组件:
 *   · 建 ThreeRenderAdapter,并把它注册进会话
 *   · 卸载时 dispose,不留 WebGL 上下文
 *
 * 它不碰仿真:每帧的 `advance()` 由会话自己的 rAF 循环驱动,
 * 这里只负责「渲染器有了/没了」这两件事。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { CameraMode, PointCloudSnapshot } from '@simulation/three-adapter'
import { CAMERA_MODE_LIST, ThreeRenderAdapter } from '@simulation/three-adapter'
import { useSession } from '../simulation/injection'
import { formatSimulationClock } from '../utils/format'

const {
  metrics,
  rendererInfo,
  scenario,
  projector,
  obstacles,
  wires,
  pointCloud,
  bodyFactory,
  cameraTarget,
  cameraMode,
  attachRenderer,
  refreshRendererInfo,
  notifyRendererError,
  setCameraMode,
  resetCamera,
} = useSession()

const container = ref<HTMLDivElement | null>(null)
let adapter: ThreeRenderAdapter | null = null
const cloudStatus = shallowRef<PointCloudSnapshot | null>(null)
let statusTimer = 0
let disposed = false
const cloudStatusText = computed(() => {
  const status = cloudStatus.value
  if (!status || status.state === 'loading') return '园区概览载入中…'
  if (status.state === 'error') return '园区点云载入失败'
  if (status.state === 'degraded') return '概览可用 · 细节暂不可用'
  return status.loadingTiles ? '园区已就绪 · 正在补充细节' : '园区点云已就绪'
})
const pointCountText = computed(
  () => `${((cloudStatus.value?.renderedPoints ?? 0) / 10_000).toFixed(1)} 万点`,
)

const statusText = computed(() => {
  switch (metrics.value.status) {
    case 'running':
      return '运行中'
    case 'paused':
      return '已暂停'
    default:
      return '未启动'
  }
})

const statusClass = computed(() =>
  metrics.value.status === 'running'
    ? 'tag tag--ok'
    : metrics.value.status === 'paused'
      ? 'tag tag--warn'
      : 'tag',
)

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function mountRenderer(): Promise<void> {
  const host = container.value
  if (!host) return

  const next = new ThreeRenderAdapter({
    container: host,
    // 领域包提供的投影函数:适配器因此完全不需要认识无人机遥测
    project: projector,
    // 会话若指定了机体工厂(比如汽车),视口原样转交 —— 它对载具一无所知
    body: bodyFactory,
    obstacles,
    // 导线等纯视觉元素:视口只知道「场景还有这些折线」,不知道它们是输电导线
    wires,
    pointCloud,
    initialCameraTarget: cameraTarget ?? { x: 0, y: 1.2, z: 0 },
  })
  adapter = next
  attachRenderer(next)

  try {
    await next.initialize()
    if (disposed) return
    if (next.error) {
      notifyRendererError(`机体模型载入失败:${describeError(next.error)}`)
    } else {
      refreshRendererInfo()
    }
  } catch (error) {
    if (disposed) return
    notifyRendererError(`场景初始化失败:${describeError(error)}`)
  }
}

function selectCamera(mode: CameraMode): void {
  setCameraMode(mode)
}

function showOverview(): void {
  setCameraMode('orbit')
  adapter?.showSceneOverview()
}

function focusDrone(): void {
  setCameraMode('orbit')
  resetCamera()
}

function retryDetails(): void {
  adapter?.retryPointCloudDetails()
}

onMounted(() => {
  void mountRenderer()
  if (pointCloud)
    statusTimer = window.setInterval(() => {
      cloudStatus.value = adapter?.getPointCloudSnapshot() ?? null
    }, 300)
})

onBeforeUnmount(() => {
  disposed = true
  if (statusTimer) window.clearInterval(statusTimer)
  attachRenderer(null)
  adapter?.dispose()
  adapter = null
})
</script>

<template>
  <div class="viewport">
    <div ref="container" class="viewport__canvas" />

    <!-- 左上:会话与仿真时钟,和真机 HUD 的排布一致 -->
    <div class="viewport__hud viewport__hud--tl">
      <div class="hud-line">
        <span :class="statusClass">{{ statusText }}</span>
        <span class="tag tag--info">1/60 s 固定步长</span>
      </div>
      <div class="hud-line">
        <span class="hud-key">场景</span>
        <span class="mono">{{ scenario.label }}</span>
      </div>
      <div class="hud-line">
        <span class="hud-key">仿真时间</span>
        <span class="mono">{{ formatSimulationClock(metrics.simulationTime) }}</span>
      </div>
      <div class="hud-line">
        <span class="hud-key">Tick</span>
        <span class="mono">{{ metrics.tick }}</span>
      </div>
      <div class="hud-line">
        <span class="hud-key">帧率</span>
        <span class="mono">{{ metrics.fps }} fps · {{ metrics.stepsPerFrame }} 步/帧</span>
      </div>
    </div>

    <!-- 右上:相机模式 -->
    <div class="viewport__hud viewport__hud--tr">
      <div class="camera-switch">
        <button v-if="pointCloud" data-testid="campus-overview" @click="showOverview">
          园区全景
        </button>
        <button v-if="pointCloud" @click="focusDrone">聚焦无人机</button>
        <button
          v-for="item in CAMERA_MODE_LIST"
          :key="item.key"
          :class="{ active: cameraMode === item.key }"
          @click="selectCamera(item.key)"
        >
          {{ item.label }}
        </button>
      </div>
      <div class="hud-line hud-line--right">
        <span class="hud-key">模型</span>
        <span class="mono hud-value">{{ rendererInfo.modelHealth || '载入中…' }}</span>
      </div>
    </div>

    <div
      v-if="pointCloud"
      class="viewport__cloud"
      data-testid="campus-status"
      :data-state="cloudStatus?.state ?? 'loading'"
      :data-points="cloudStatus?.renderedPoints ?? 0"
    >
      <span class="cloud-dot" :class="`cloud-dot--${cloudStatus?.state ?? 'loading'}`" />
      <div>
        <strong>{{ cloudStatusText }}</strong>
        <span v-if="cloudStatus?.overviewPoints"
          >{{ pointCountText }} · 米制场景 · 南侧道路起飞</span
        >
        <span v-if="cloudStatus?.state === 'error'">{{ cloudStatus.error }}</span>
      </div>
      <button v-if="cloudStatus?.state === 'degraded'" @click="retryDetails">重试细节</button>
    </div>

    <div v-if="rendererInfo.state === 'error'" class="viewport__error">
      <strong>渲染降级</strong>
      <span>{{ rendererInfo.modelHealth }}</span>
      <span class="hint">仿真仍在运行:数据面板、指令与任务都不依赖渲染器。</span>
    </div>
  </div>
</template>

<style scoped>
.viewport {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--border-soft);
  background: #0a141b;
}

.viewport__canvas {
  position: absolute;
  inset: 0;
}

.viewport__canvas :deep(canvas) {
  display: block;
}

.viewport__hud {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  background: rgba(6, 13, 18, 0.62);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  pointer-events: none;
  font-size: 11.5px;
}

.viewport__hud--tl {
  top: 10px;
  left: 10px;
}

.viewport__hud--tr {
  top: 10px;
  right: 10px;
  align-items: flex-end;
}

.viewport__hud--tr .camera-switch {
  pointer-events: auto;
}

.hud-line {
  display: flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}

.hud-line--right {
  justify-content: flex-end;
}

.hud-key {
  color: var(--text-faint);
}

.hud-value {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.camera-switch {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: var(--panel-soft);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
}

.camera-switch button {
  padding: 3px 9px;
  font-size: 11px;
  background: transparent;
  border-color: transparent;
}

.viewport__error {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 520px;
  padding: 9px 13px;
  text-align: center;
  color: var(--warn);
  background: rgba(6, 13, 18, 0.9);
  border: 1px solid rgba(255, 196, 107, 0.4);
  border-radius: 8px;
}

.viewport__cloud {
  position: absolute;
  left: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: rgba(6, 13, 18, 0.84);
  font-size: 11px;
}
.viewport__cloud strong {
  display: block;
  font-size: 12px;
  font-weight: 500;
}
.viewport__cloud span:not(.cloud-dot) {
  display: block;
  margin-top: 3px;
  color: var(--text-faint);
}
.cloud-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}
.cloud-dot--loading,
.cloud-dot--degraded {
  background: var(--warn);
}
.cloud-dot--error {
  background: var(--danger);
}
</style>
