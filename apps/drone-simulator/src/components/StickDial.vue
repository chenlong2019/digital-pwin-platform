<script setup lang="ts">
/**
 * StickDial —— 单个虚拟摇杆盘。
 *
 * 真机摇杆是**圆形行程 + 自回中**的:所以这里按圆盘归一(斜推不会超速),
 * 指针一松立刻回中位。移植自 firstapp 的同名组件,配色换成本平台的 HUD 变量。
 *
 * 盘径由 CSS 变量 `--stick-size` 决定(默认 124px),父级在矮屏上可以整体收缩,
 * 旋钮行程用同一变量算出来 —— 尺寸只有一个来源,不会出现"盘小了旋钮还在外面"。
 */
import { ref } from 'vue'

const props = defineProps<{
  /** 用于测试钩子与样式钩子 */
  side: 'left' | 'right'
  label: string
  /** 横向轴名称(右为正)。不能叫 vLabel —— `v-` 前缀会被 Vue 当成自定义指令 */
  axisH: string
  /** 纵向轴名称(上为正) */
  axisV: string
  x: number
  y: number
  disabled?: boolean
}>()

const emit = defineEmits<{
  (event: 'move', payload: { x: number; y: number }): void
}>()

const rootRef = ref<HTMLElement | null>(null)
const active = ref(false)

const clamp = (value: number): number => Math.min(1, Math.max(-1, value))

/**
 * 把指针位置换算成归一化摇杆行程。
 * 盘中点 = (0,0),右/上为正;超出圆盘按圆行程归一(真机摇杆是圆形行程)。
 */
function applyPointer(event: PointerEvent): void {
  const element = rootRef.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const radius = rect.width / 2
  const centerX = rect.left + radius
  const centerY = rect.top + radius
  let dx = (event.clientX - centerX) / radius
  let dy = (centerY - event.clientY) / radius
  const magnitude = Math.hypot(dx, dy)
  if (magnitude > 1) {
    dx /= magnitude
    dy /= magnitude
  }
  emit('move', { x: clamp(dx), y: clamp(dy) })
}

function onPointerDown(event: PointerEvent): void {
  if (props.disabled) return
  active.value = true
  rootRef.value?.setPointerCapture(event.pointerId)
  applyPointer(event)
}

function onPointerMove(event: PointerEvent): void {
  if (!active.value) return
  applyPointer(event)
}

/** DJI 遥控器摇杆是自回中的:松手立刻回中位 */
function onPointerUp(): void {
  if (!active.value) return
  active.value = false
  emit('move', { x: 0, y: 0 })
}
</script>

<template>
  <div class="stick-dial" :class="{ 'stick-dial--disabled': disabled }">
    <div class="stick-dial__name">{{ label }}</div>
    <div
      ref="rootRef"
      class="stick-dial__pad"
      :class="{ 'stick-dial__pad--active': active }"
      :data-testid="`stick-pad-${side}`"
      role="slider"
      :aria-label="label"
      :aria-valuetext="`横向 ${x.toFixed(2)}, 纵向 ${y.toFixed(2)}`"
      @pointerdown.prevent="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @lostpointercapture="onPointerUp"
    >
      <span class="stick-dial__ring" />
      <span class="stick-dial__cross stick-dial__cross--h" />
      <span class="stick-dial__cross stick-dial__cross--v" />
      <span class="stick-dial__knob" :style="{ '--kx': x, '--ky': -y }">
        <i />
      </span>
    </div>
    <div class="stick-dial__axis">
      <span>{{ axisH }}</span>
      <span>{{ axisV }}</span>
    </div>
    <div class="stick-dial__value" :class="{ 'stick-dial__value--live': Math.hypot(x, y) > 0.04 }">
      {{ x.toFixed(2) }} / {{ y.toFixed(2) }}
    </div>
  </div>
</template>

<style scoped>
.stick-dial {
  /* 盘径的唯一来源;矮屏上由父级覆盖 --stick-size 整体收缩 */
  --size: var(--stick-size, 124px);
  --knob: calc(var(--size) * 0.387);
  /* 旋钮圆心能离开盘心的最大距离:盘半径 − 旋钮半径 */
  --travel: calc((var(--size) - var(--knob)) / 2);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  user-select: none;
}

.stick-dial__name {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.08em;
}

.stick-dial__pad {
  position: relative;
  width: var(--size);
  height: var(--size);
  background: radial-gradient(circle at 50% 45%, var(--panel-raised), var(--panel-soft) 78%);
  border: 1px solid rgba(111, 240, 208, 0.28);
  border-radius: 50%;
  box-shadow:
    inset 0 2px 14px rgba(0, 0, 0, 0.55),
    0 6px 18px rgba(0, 0, 0, 0.3);
  cursor: grab;
  touch-action: none;
  transition: border-color 0.15s ease;
}

.stick-dial__pad--active {
  border-color: rgba(111, 240, 208, 0.7);
  cursor: grabbing;
}

.stick-dial--disabled .stick-dial__pad {
  cursor: not-allowed;
  opacity: 0.45;
}

.stick-dial__ring {
  position: absolute;
  inset: 14%;
  border: 1px dashed rgba(111, 240, 208, 0.2);
  border-radius: 50%;
}

.stick-dial__cross {
  position: absolute;
  background: rgba(111, 240, 208, 0.14);
}

.stick-dial__cross--h {
  top: 50%;
  right: 9.5%;
  left: 9.5%;
  height: 1px;
}

.stick-dial__cross--v {
  top: 9.5%;
  bottom: 9.5%;
  left: 50%;
  width: 1px;
}

.stick-dial__knob {
  position: absolute;
  top: 50%;
  left: 50%;
  display: grid;
  width: var(--knob);
  height: var(--knob);
  place-items: center;
  background: linear-gradient(160deg, #1b3b41, #0f2027);
  border: 1px solid rgba(111, 240, 208, 0.45);
  border-radius: 50%;
  box-shadow:
    0 3px 9px rgba(0, 0, 0, 0.45),
    inset 0 1px 2px rgba(255, 255, 255, 0.16);
  transform: translate(-50%, -50%) translate(calc(var(--kx, 0) * var(--travel)), calc(var(--ky, 0) * var(--travel)));
  transition: transform 0.09s ease-out;
}

.stick-dial__pad--active .stick-dial__knob {
  transition: none;
}

.stick-dial__knob i {
  width: 34%;
  height: 34%;
  background: rgba(111, 240, 208, 0.22);
  border-radius: 50%;
}

.stick-dial__axis {
  display: flex;
  justify-content: space-between;
  width: var(--size);
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 8px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: 0.04em;
}

.stick-dial__value {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.06em;
}

.stick-dial__value--live {
  color: var(--accent);
}
</style>
