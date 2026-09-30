<script setup lang="ts">
/**
 * FlowCanvas —— 把 `flow/types.ts` 描述的图渲染成 vue-flow 画布。
 *
 * 三个刻意的取舍:
 *   1. 连线从哪一侧出/进是**算出来的**(见 edgeHandles),不是数据里手写的。
 *      依赖关系本来就带方向信息,手写只会多一处会写错的地方。
 *   2. 标了 autoLayout 的图交给 dagre 分层排布 —— 节点一多、一个节点扇出七八条边时,
 *      手摆必然出现连线穿过节点,而且每次加包都得回来调坐标。
 *   3. 图是只读的:节点不可拖、不可连、不可选。这些图是对代码的说明,
 *      不是编辑器 —— 能拖会让「图」和「代码」两个真相源立刻分家。
 */
import { computed, markRaw } from 'vue'
import { MarkerType, Position, VueFlow, type Edge, type Node } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import dagre from '@dagrejs/dagre'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import FlowNodeCard from './FlowNodeCard.vue'
import type { FlowGraph, NodeSpec } from '../flow/types'

const props = defineProps<{ graph: FlowGraph }>()

const nodeTypes = { module: markRaw(FlowNodeCard) }

/** 节点尺寸 —— dagre 排布和算连线方向都要用,所以只在这里定义一次 */
function widthOf(spec: NodeSpec): number {
  return spec.w ?? 168
}

function heightOf(spec: NodeSpec): number {
  // padding 16 + 一行标题 17 + 可选副标题 15 + 边框 2
  return 33 + (spec.sublabel ? 15 : 0)
}

interface Placed {
  readonly spec: NodeSpec
  readonly x: number
  readonly y: number
}

/** dagre 输出的是节点中心,这里换算回左上角,和手摆坐标同一坐标系 */
function autoLayout(graph: FlowGraph): Map<string, { x: number; y: number }> {
  const layout = new dagre.graphlib.Graph()
  layout.setGraph({ rankdir: graph.direction, nodesep: 48, ranksep: 96, marginx: 24, marginy: 24 })
  layout.setDefaultEdgeLabel(() => ({}))
  for (const spec of graph.nodes) {
    layout.setNode(spec.id, { width: widthOf(spec), height: heightOf(spec) })
  }
  for (const edge of graph.edges) layout.setEdge(edge.from, edge.to)
  dagre.layout(layout)

  const out = new Map<string, { x: number; y: number }>()
  for (const spec of graph.nodes) {
    const node = layout.node(spec.id) as { x: number; y: number } | undefined
    out.set(spec.id, node ? { x: node.x - widthOf(spec) / 2, y: node.y - heightOf(spec) / 2 } : { x: 0, y: 0 })
  }
  return out
}

const placed = computed<Placed[]>(() => {
  const graph = props.graph
  if (!graph.autoLayout) {
    return graph.nodes.map((spec) => ({ spec, x: spec.x ?? 0, y: spec.y ?? 0 }))
  }
  const coords = autoLayout(graph)
  return graph.nodes.map((spec) => ({ spec, x: coords.get(spec.id)?.x ?? 0, y: coords.get(spec.id)?.y ?? 0 }))
})

const byId = computed(() => new Map(placed.value.map((item) => [item.spec.id, item])))

/**
 * 按两个节点的相对位置挑进出边的手柄。
 *
 * 横向差更大就走左右,纵向差更大就走上下 —— 依赖图的边基本都近乎水平或垂直,
 * 这个判据足够,而且不需要在数据里逐条标注。
 */
function edgeHandles(from: Placed, to: Placed): { sourceHandle: string; targetHandle: string } {
  const dx = to.x + widthOf(to.spec) / 2 - (from.x + widthOf(from.spec) / 2)
  const dy = to.y + heightOf(to.spec) / 2 - (from.y + heightOf(from.spec) / 2)

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 's-right', targetHandle: 't-left' }
      : { sourceHandle: 's-left', targetHandle: 't-right' }
  }
  return dy >= 0
    ? { sourceHandle: 's-bottom', targetHandle: 't-top' }
    : { sourceHandle: 's-top', targetHandle: 't-bottom' }
}

const nodes = computed<Node[]>(() =>
  placed.value.map(({ spec, x, y }) => ({
    id: spec.id,
    type: 'module',
    position: { x, y },
    data: {
      label: spec.label,
      sublabel: spec.sublabel,
      ref: spec.ref,
      tone: spec.tone ?? 'solid',
      w: widthOf(spec),
    },
    draggable: false,
    connectable: false,
    selectable: false,
  })),
)

const edges = computed<Edge[]>(() => {
  const positions = byId.value
  const result: Edge[] = []

  for (const spec of props.graph.edges) {
    const from = positions.get(spec.from)
    const to = positions.get(spec.to)
    if (!from || !to) {
      // 数据写错时不要静默:宁可少一条边,也要在控制台留下痕迹
      console.warn(`[flow] 边 ${spec.from} → ${spec.to} 的端点不存在,已跳过`)
      continue
    }
    const handles = edgeHandles(from, to)
    const muted = spec.dash || spec.tone === 'muted'
    result.push({
      id: `${spec.from}->${spec.to}`,
      source: spec.from,
      target: spec.to,
      type: props.graph.edgeType ?? 'smoothstep',
      ...handles,
      label: spec.label,
      animated: false,
      style: {
        stroke: muted ? 'var(--border)' : 'var(--border-strong)',
        strokeWidth: 1.4,
        strokeDasharray: spec.dash ? '4 3' : undefined,
      },
      labelStyle: { fill: 'var(--text-faint)', fontSize: '10px' },
      labelBgStyle: { fill: 'var(--panel)', fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
      markerEnd: MarkerType.ArrowClosed,
    })
  }
  return result
})

/** 规划中的节点用虚线外框,缩略图里也保持区分 */
function minimapColor(node: Node): string {
  const tone = (node.data as { tone?: string } | undefined)?.tone
  switch (tone) {
    case 'accent':
      return '#6ff0d0'
    case 'warn':
      return '#ffc46b'
    case 'done':
      return '#7fd8ff'
    case 'muted':
      return '#2a4552'
    default:
      return '#3d6b7d'
  }
}
</script>

<template>
  <div class="flow" data-testid="flow-canvas">
    <VueFlow
      :key="graph.id"
      :nodes="nodes"
      :edges="edges"
      :node-types="nodeTypes"
      :min-zoom="0.15"
      :max-zoom="2"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :elements-selectable="false"
      :zoom-on-double-click="false"
      :edges-updatable="false"
      fit-view-on-init
      :fit-view-params="{ padding: 0.12 }"
    >
      <Background :gap="18" :size="1" pattern-color="#16303c" />
      <Controls position="bottom-right" :show-interactive="false" />
      <MiniMap
        pannable
        zoomable
        :node-color="minimapColor"
        mask-color="rgba(6, 13, 18, 0.75)"
        position="bottom-left"
      />
    </VueFlow>
  </div>
</template>

<style scoped>
.flow {
  position: relative;
  width: 100%;
  height: 100%;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--panel-soft);
  overflow: hidden;
}

/* vue-flow 默认主题是给浅色页面用的,这里整片改成 HUD 深色 */
.flow :deep(.vue-flow__edge-path) {
  stroke-linecap: round;
}

.flow :deep(.vue-flow__arrowhead polyline),
.flow :deep(.vue-flow__arrowhead path) {
  stroke: var(--border);
  fill: var(--border);
}

.flow :deep(.vue-flow__controls) {
  box-shadow: none;
  gap: 2px;
}

.flow :deep(.vue-flow__controls-button) {
  width: 24px;
  height: 24px;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  fill: var(--text-dim);
}

.flow :deep(.vue-flow__controls-button:hover) {
  background: var(--border);
  fill: var(--accent);
}

.flow :deep(.vue-flow__minimap) {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.flow :deep(.vue-flow__attribution) {
  display: none;
}
</style>
