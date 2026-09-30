<script setup lang="ts">
/**
 * FlowNodeCard —— 流程图节点。
 *
 * 四个方向各挂一对 source / target 手柄,具体走哪个由 FlowCanvas 按两个节点的
 * 相对位置算出来(见那边的 edgeHandles),所以这份数据里不需要手工标「从哪边出」。
 * 手柄本身不可见,只是为了给连线一个锚点。
 */
import { computed } from 'vue'
import { Handle, Position, type NodeProps } from '@vue-flow/core'

interface FlowNodeData {
  label: string
  sublabel?: string
  ref?: string
  tone?: string
  w?: number
}

const props = defineProps<NodeProps<FlowNodeData>>()

const tone = computed(() => props.data.tone ?? 'solid')
const width = computed(() => props.data.w ?? 168)

const SIDES: ReadonlyArray<readonly [string, Position]> = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left],
]
</script>

<template>
  <div class="fnode" :class="`fnode--${tone}`" :style="{ width: `${width}px` }">
    <template v-for="[side, position] in SIDES" :key="side">
      <Handle :id="`s-${side}`" type="source" :position="position" />
      <Handle :id="`t-${side}`" type="target" :position="position" />
    </template>

    <div class="fnode__row">
      <span class="fnode__label">{{ data.label }}</span>
      <span v-if="data.ref" class="fnode__ref">{{ data.ref }}</span>
    </div>
    <span v-if="data.sublabel" class="fnode__sub">{{ data.sublabel }}</span>
  </div>
</template>

<style scoped>
.fnode {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-raised);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  text-align: left;
}

.fnode__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.fnode__label {
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--text);
}

.fnode__ref {
  flex: none;
  font-family: var(--mono);
  font-size: 9px;
  line-height: 1.4;
  color: var(--text-faint);
  white-space: nowrap;
}

.fnode__sub {
  font-size: 10px;
  line-height: 1.35;
  color: var(--text-dim);
}

/* 已实现 / 主干 */
.fnode--solid {
  border-color: var(--border);
}

/* 规划中 */
.fnode--muted {
  border-style: dashed;
  border-color: var(--border-soft);
  background: var(--panel-soft);
}

.fnode--muted .fnode__label {
  color: var(--text-dim);
}

.fnode--muted .fnode__sub {
  color: var(--text-faint);
}

/* 强调 */
.fnode--accent {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.fnode--accent .fnode__label {
  color: var(--accent);
}

/* 注意分支 */
.fnode--warn {
  border-color: var(--warn);
  background: rgba(255, 196, 107, 0.1);
}

.fnode--warn .fnode__label {
  color: var(--warn);
}

/* 终态 */
.fnode--done {
  border-color: var(--info);
  background: rgba(127, 216, 255, 0.1);
}

.fnode--done .fnode__label {
  color: var(--info);
}

/* 手柄只作锚点用,不参与交互 */
.fnode :deep(.vue-flow__handle) {
  width: 1px;
  height: 1px;
  min-width: 0;
  min-height: 0;
  border: none;
  opacity: 0;
}
</style>
