<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { PointCloudCaptureRenderer } from '@simulation/three-adapter'
import type {
  MultiViewCamera,
  MultiViewPhoto,
  PointCloudSceneOptions,
} from '@simulation/three-adapter'
import { campusPointCloud } from '../simulation/scenes/campus-scene'
import { campusCapturePlan } from '../experiments/campus-plan'

const props = defineProps<{ options?: PointCloudSceneOptions; firstView?: MultiViewCamera }>()
const emit = defineEmits<{ ready: []; error: [message: string] }>()
const container = ref<HTMLDivElement | null>(null)
let renderer: PointCloudCaptureRenderer | null = null
let disposed = false

function capture(view: MultiViewCamera, width: number, height: number): MultiViewPhoto {
  if (!renderer) throw new Error('采集场景尚未就绪')
  return renderer.capture(view, width, height)
}
function sourceIdentity() {
  return renderer?.sourceIdentity() ?? null
}
defineExpose({ capture, sourceIdentity })

onMounted(async () => {
  if (!container.value) return
  const next = new PointCloudCaptureRenderer(container.value, props.options ?? campusPointCloud)
  renderer = next
  try {
    await next.initialize()
    if (disposed) return
    next.preview(props.firstView ?? campusCapturePlan()[0]!)
    emit('ready')
  } catch (error) {
    if (!disposed) emit('error', error instanceof Error ? error.message : String(error))
  }
})
onBeforeUnmount(() => {
  disposed = true
  renderer?.dispose()
  renderer = null
})
</script>

<template><div ref="container" class="capture-stage" data-testid="experiment-stage" /></template>
<style scoped>
.capture-stage {
  width: 100%;
  aspect-ratio: 4 / 3;
  background: #0a141b;
  border-radius: 12px;
  overflow: hidden;
}
.capture-stage :deep(canvas) {
  display: block;
}
</style>
