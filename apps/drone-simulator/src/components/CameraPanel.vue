<script setup lang="ts">
/**
 * CameraPanel —— 云台与相机。
 *
 * 云台俯仰与变焦都是**设备状态**:它们存在 Agent 身上,不归界面所有。
 * 所以滑杆只做两件事 —— 下发 Command、回读快照;右侧读数取自 `telemetry`
 * (10 Hz 采样),看到的就是仿真里此刻真实的角度,而不是滑杆自己以为的值。
 *
 * 机载视角不需要在这里做任何特殊处理:渲染适配器每帧从快照里取云台姿态,
 * 把相机摆到云台镜片位置。所以「云台转到哪,画面就朝哪」是自然发生的。
 */
import { computed, onScopeDispose, ref, watch } from 'vue'
import type { PhotoShot } from '@simulation/three-adapter'
import { useSandbox } from '../simulation/injection'
import { downloadBlob, downloadDataUrl, timestampTag } from '../utils/download'
import { formatClock, formatNumber } from '../utils/format'

const {
  telemetry,
  cameraMode,
  setCameraMode,
  setGimbalPitch,
  setCameraZoom,
  takePhoto,
  toggleRecording,
  setRecordingReadyHandler,
} = useSandbox()

/** 云台俯仰行程(−90°~+60°)与出厂默认角,取自真机手册 */
const GIMBAL_MIN = -90
const GIMBAL_MAX = 60
const GIMBAL_CENTER = -10
/** 变焦范围(1 = 广角) */
const ZOOM_MIN = 1
const ZOOM_MAX = 4

const zoom = ref(ZOOM_MIN)
const pitch = ref(GIMBAL_CENTER)

// 遥测回读:按钮(回中/垂直向下)改了云台之后,滑杆要跟着走
watch(
  () => telemetry.value?.gimbalPitch,
  (value) => {
    if (typeof value === 'number') pitch.value = value
  },
  { immediate: true },
)
watch(
  () => telemetry.value?.cameraZoom,
  (value) => {
    if (typeof value === 'number') zoom.value = value
  },
  { immediate: true },
)

const livePitch = computed(() => telemetry.value?.gimbalPitch ?? pitch.value)
const liveZoom = computed(() => telemetry.value?.cameraZoom ?? zoom.value)
const airborne = computed(() => telemetry.value?.airborne ?? false)

// ————————————————————————————— 拍照 / 录像 —————————————————————————————

const recording = computed(() => telemetry.value?.recording ?? false)
const recordSeconds = computed(() => telemetry.value?.recordSeconds ?? 0)
const photoCount = computed(() => telemetry.value?.photoCount ?? 0)

const photoBusy = ref(false)
const lastPhoto = ref<PhotoShot | null>(null)
const photoNote = ref('')
const recordNote = ref('')
/** 最近一次录制成片:自动下载可能被浏览器静默拦掉,这里留一份供手动下载 */
const lastRecording = ref<{ url: string; name: string; size: number } | null>(null)

// 成片由界面落盘:渲染层只把 Blob 交出来,下载时机与文件名归这里决定
setRecordingReadyHandler(({ blob, seconds }) => {
  const name = `DJI_Mini4Pro_record_${timestampTag()}.webm`
  downloadBlob(blob, name)
  if (lastRecording.value) URL.revokeObjectURL(lastRecording.value.url)
  lastRecording.value = { url: URL.createObjectURL(blob), name, size: blob.size }
  recordNote.value = `已保存 ${name}(${formatClock(seconds)})`
})
onScopeDispose(() => {
  setRecordingReadyHandler(null)
  if (lastRecording.value) URL.revokeObjectURL(lastRecording.value.url)
})

async function shoot(): Promise<void> {
  if (photoBusy.value) return
  photoBusy.value = true
  try {
    const shot = await takePhoto()
    if (!shot) {
      photoNote.value = '拍照失败:相机未就绪'
      return
    }
    lastPhoto.value = shot
    const name = `DJI_Mini4Pro_photo_${timestampTag()}.png`
    downloadDataUrl(shot.dataUrl, name)
    photoNote.value = `已保存 ${name}(${shot.width}×${shot.height})`
  } finally {
    photoBusy.value = false
  }
}

async function toggleRec(): Promise<void> {
  const wasRecording = recording.value
  const ok = await toggleRecording()
  if (!ok) {
    recordNote.value = '当前环境不支持录像(需要 MediaRecorder)'
    return
  }
  // 停止时的提示由成片回调写入,这里不要覆盖它
  if (!wasRecording) recordNote.value = '录制中…停止后自动保存'
}

function onPitchInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  pitch.value = value
  setGimbalPitch(value)
}

function onZoomInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  zoom.value = value
  setCameraZoom(value)
}

function centerGimbal(): void {
  setGimbalPitch(GIMBAL_CENTER)
}

function lookDown(): void {
  setGimbalPitch(GIMBAL_MIN)
}

function lookLevel(): void {
  setGimbalPitch(0)
}

function toggleFpv(): void {
  setCameraMode(cameraMode.value === 'fpv' ? 'orbit' : 'fpv')
}
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <span class="panel__title">云台与相机</span>
      <span class="tag tag--info">
        {{ formatNumber(livePitch, 0) }}° · {{ formatNumber(liveZoom, 1) }}×
      </span>
    </header>

    <div class="panel__body">
      <!-- 云台俯仰 -->
      <div class="group">
        <div class="row row--between">
          <span class="field-label">云台俯仰</span>
          <span class="mono readout">{{ formatNumber(livePitch, 1) }}°</span>
        </div>
        <input
          type="range"
          :min="GIMBAL_MIN"
          :max="GIMBAL_MAX"
          step="1"
          :value="pitch"
          data-testid="gimbal-pitch"
          @input="onPitchInput"
        />
        <div class="grid grid--3">
          <button @click="centerGimbal">回中</button>
          <button @click="lookDown">垂直向下</button>
          <button @click="lookLevel">水平前视</button>
        </div>
      </div>

      <!-- 变焦 -->
      <div class="group">
        <div class="row row--between">
          <span class="field-label">相机变焦</span>
          <span class="mono readout">{{ formatNumber(liveZoom, 1) }}×</span>
        </div>
        <input
          type="range"
          :min="ZOOM_MIN"
          :max="ZOOM_MAX"
          step="0.1"
          :value="zoom"
          data-testid="camera-zoom"
          @input="onZoomInput"
        />
        <p class="hint">变焦只在机载视角生效;切回观察者视角会把你原来的滚轮缩放还回来。</p>
      </div>

      <!-- 拍照 / 录像 -->
      <div class="group">
        <div class="row row--between">
          <span class="field-label">拍照 / 录像</span>
          <span v-if="recording" class="tag tag--danger">
            REC {{ formatClock(recordSeconds) }}
          </span>
        </div>
        <div class="grid">
          <button :disabled="photoBusy" data-testid="photo-button" @click="shoot">
            {{ photoBusy ? '拍摄中…' : `拍照(已拍 ${photoCount})` }}
          </button>
          <button :class="{ active: recording }" data-testid="record-toggle" @click="toggleRec">
            {{ recording ? '停止录像' : '开始录像' }}
          </button>
        </div>
        <p v-if="recordNote" class="hint" data-testid="record-note">{{ recordNote }}</p>
        <a
          v-if="lastRecording"
          class="record-download"
          :href="lastRecording.url"
          :download="lastRecording.name"
          data-testid="record-download"
        >
          手动下载最近一次录像({{ (lastRecording.size / 1048576).toFixed(1) }}MB)
        </a>
        <p v-if="photoNote" class="hint" data-testid="photo-note">{{ photoNote }}</p>
        <img v-if="lastPhoto" class="thumb" :src="lastPhoto.dataUrl" alt="最近一张照片" data-testid="photo-thumb" />
        <p class="hint">拍照与录像都用云台取景(与机载视角同一构图,含变焦);文件生成后自动下载。</p>
      </div>

      <!-- 机载视角 -->
      <div class="group">
        <div class="row row--between">
          <span class="field-label">机载取景</span>
          <span v-if="!airborne" class="hint">地面也可取景</span>
        </div>
        <div class="grid">
          <button :class="{ active: cameraMode === 'fpv' }" data-testid="fpv-toggle" @click="toggleFpv">
            {{ cameraMode === 'fpv' ? '退出机载视角' : '切到机载视角' }}
          </button>
          <button :class="{ active: cameraMode === 'follow' }" @click="setCameraMode('follow')">
            跟随视角
          </button>
        </div>
        <p class="hint">
          机载视角就是云台镜片取景:云台转到哪,画面就朝哪。三轴增稳会把机体倾斜反向补偿掉,
          超出 −90°~+60° 行程才让画面跟着机体歪。
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.grid--3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.grid button {
  width: 100%;
  padding: 5px 2px;
}

.readout {
  color: var(--accent);
}

.thumb {
  width: 100%;
  border-radius: 6px;
  border: 1px solid var(--border-soft);
  background: #000;
}

/* 自动下载可能被浏览器静默拦掉,留一条手动通道 */
.record-download {
  display: inline-block;
  margin-top: 4px;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
</style>
