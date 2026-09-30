<script setup lang="ts">
/**
 * StickDeck —— 视口下方的常驻摇杆台。
 *
 * 真机遥控器是两个自回中摇杆(美国手 Mode 2):左杆偏航/升降,右杆横滚/俯仰。
 * 键盘与拖拽走的是**同一条合成路径**(useFlightStick),所以两种输入都能在杆上看见,
 * 也能叠加。这一层只负责画和转发,不自己维护摇杆量 —— 免得出现两份互不相符的杆位。
 */
import { computed } from 'vue'
import StickDial from './StickDial.vue'
import type { DialAxes, StickAxes } from '../simulation/use-flight-stick'

const props = defineProps<{
  left: DialAxes
  right: DialAxes
  axes: StickAxes
  disabled: boolean
}>()

const emit = defineEmits<{
  (event: 'move', payload: { side: 'left' | 'right'; value: DialAxes }): void
  (event: 'neutral'): void
}>()

/** 四通道读数:让「按了键 / 推了杆之后到底给了什么量」肉眼可查 */
const channels = computed(() => [
  { label: '升降', value: props.axes.up },
  { label: '偏航', value: props.axes.yawRate },
  { label: '前后', value: props.axes.forward },
  { label: '横移', value: props.axes.right },
])

/** 读数条从中线往两边长:负值向左,正值向右 */
function fillStyle(value: number): Record<string, string> {
  const width = `${Math.min(50, Math.abs(value) * 50)}%`
  return value >= 0 ? { left: '50%', width } : { right: '50%', width }
}
</script>

<template>
  <section class="deck" aria-label="虚拟摇杆">
    <StickDial
      side="left"
      :x="left.x"
      :y="left.y"
      :disabled="disabled"
      label="左摇杆 · 美国手"
      axis-h="偏航 ← →"
      axis-v="升降 ↓ ↑"
      @move="emit('move', { side: 'left', value: $event })"
    />

    <div class="deck__center">
      <div class="deck__head">
        <span class="deck__title">虚拟摇杆 · 美国手 Mode 2</span>
        <button class="ghost deck__reset" data-testid="stick-neutral" @click="emit('neutral')">归中悬停</button>
      </div>

      <div class="deck__channels">
        <div v-for="item in channels" :key="item.label" class="channel">
          <span class="channel__label">{{ item.label }}</span>
          <span class="channel__bar">
            <i class="channel__fill" :style="fillStyle(item.value)" />
          </span>
          <span class="channel__value mono">{{ item.value.toFixed(2) }}</span>
        </div>
      </div>

      <p class="deck__keys">
        <span><kbd>W</kbd><kbd>S</kbd> 升降</span>
        <span><kbd>A</kbd><kbd>D</kbd> 偏航(水平旋转)</span>
        <span><kbd>↑</kbd><kbd>↓</kbd> 前后</span>
        <span><kbd>←</kbd><kbd>→</kbd> 横移</span>
        <span><kbd>Space</kbd> 归中</span>
      </p>

      <p v-if="disabled" class="hint">起飞后摇杆才生效:地面上推杆没有意义,也会误发一堆指令。</p>
      <p v-else class="hint">拖拽杆盘或按方向键都能操纵;松手/松键即回中悬停。</p>
    </div>

    <StickDial
      side="right"
      :x="right.x"
      :y="right.y"
      :disabled="disabled"
      label="右摇杆 · 美国手"
      axis-h="横滚 ← →"
      axis-v="俯仰 ↓ ↑"
      @move="emit('move', { side: 'right', value: $event })"
    />
  </section>
</template>

<style scoped>
.deck {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 8px 14px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.deck__center {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}

.deck__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.deck__title {
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-faint);
  font-weight: 600;
}

.deck__reset {
  flex: 0 0 auto;
  padding: 3px 10px;
  font-size: 11px;
}

.deck__channels {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 3px 16px;
}

.channel {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) 38px;
  align-items: center;
  gap: 7px;
}

.channel__label {
  color: var(--text-faint);
  font-size: 10.5px;
}

.channel__bar {
  position: relative;
  height: 4px;
  background: var(--panel-soft);
  border-radius: 999px;
  overflow: hidden;
}

.channel__bar::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  background: var(--border);
}

.channel__fill {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--accent);
  border-radius: 999px;
  transition: width 0.08s linear;
}

.channel__value {
  color: var(--text-dim);
  font-size: 10px;
  text-align: right;
}

.deck__keys {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 13px;
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
}

.deck__keys kbd {
  display: inline-block;
  margin-right: 2px;
  padding: 0 4px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-dim);
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.deck__center .hint {
  margin: 0;
}

@media (max-height: 880px) {
  .deck {
    --stick-size: 100px;
    gap: 12px;
    padding: 6px 12px;
  }
}
</style>
