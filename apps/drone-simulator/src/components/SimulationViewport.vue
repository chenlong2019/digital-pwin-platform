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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CameraMode } from '@simulation/three-adapter'
import { CAMERA_MODE_LIST, ThreeRenderAdapter } from '@simulation/three-adapter'
import { useSandbox } from '../simulation/injection'
import { formatSimulationClock } from '../utils/format'

const {
  metrics,
  rendererInfo,
  scenario,
  projector,
  obstacles,
  cameraMode,
  attachRenderer,
  refreshRendererInfo,
  notifyRendererError,
  setCameraMode,
} = useSandbox()

const container = ref<HTMLDivElement | null>(null)
let adapter: ThreeRenderAdapter | null = null

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
  metrics.value.status === 'running' ? 'tag tag--ok' : metrics.value.status === 'paused' ? 'tag tag--warn' : 'tag',
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
    obstacles,
    initialCameraTarget: { x: 0, y: 1.2, z: 0 },
  })
  adapter = next
  attachRenderer(next)

  try {
    await next.initialize()
    if (next.error) {
      notifyRendererError(`机体模型载入失败:${describeError(next.error)}`)
    } else {
      refreshRendererInfo()
    }
  } catch (error) {
    notifyRendererError(`场景初始化失败:${describeError(error)}`)
  }
}

function selectCamera(mode: CameraMode): void {
  setCameraMode(mode)
}

onMounted(() => {
  void mountRenderer()
})

onBeforeUnmount(() => {
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
</style>
