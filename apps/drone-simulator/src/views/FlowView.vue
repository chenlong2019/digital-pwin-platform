<script setup lang="ts">
/**
 * FlowView —— 平台模块流程图。
 *
 * 这一页是「文档」而不是「功能」:它不碰仿真会话,只把 README 里的架构约定画出来。
 * 图的数据在 src/flow/graphs.ts,那份文件旁边有测试盯着包清单,防止图和代码分家。
 */
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import FlowCanvas from '../components/FlowCanvas.vue'
import { FLOW_GRAPHS } from '../flow/graphs'

const activeId = ref(FLOW_GRAPHS[0]?.id ?? '')
const active = computed(() => FLOW_GRAPHS.find((graph) => graph.id === activeId.value) ?? FLOW_GRAPHS[0]!)

const LEGEND: ReadonlyArray<{ tone: string; label: string }> = [
  { tone: 'solid', label: '已实现' },
  { tone: 'accent', label: '强调 / 契约' },
  { tone: 'warn', label: '需要注意的分支' },
  { tone: 'muted', label: '规划中' },
]
</script>

<template>
  <div class="flow-page">
    <header class="flow-page__bar">
      <div class="flow-page__identity">
        <h1>平台模块流程</h1>
        <span class="tag">{{ FLOW_GRAPHS.length }} 张图</span>
        <span class="hint">依赖边取自架构守卫白名单</span>
      </div>
      <div class="flow-page__links">
        <RouterLink class="flow-page__back" to="/docs">项目文档</RouterLink>
        <RouterLink class="flow-page__back" to="/">返回沙盒</RouterLink>
      </div>
    </header>

    <nav class="flow-page__tabs">
      <button
        v-for="graph in FLOW_GRAPHS"
        :key="graph.id"
        :class="{ active: graph.id === activeId }"
        :data-testid="`flow-tab-${graph.id}`"
        @click="activeId = graph.id"
      >
        {{ graph.title }}
      </button>
    </nav>

    <div class="flow-page__meta">
      <p class="flow-page__caption">{{ active.caption }}</p>
      <div class="flow-page__legend">
        <span v-for="item in LEGEND" :key="item.tone" class="legend">
          <i class="legend__dot" :class="`legend__dot--${item.tone}`" />
          {{ item.label }}
        </span>
      </div>
      <span class="flow-page__refs mono">{{ active.refs }}</span>
    </div>

    <main class="flow-page__stage" data-testid="flow-stage">
      <FlowCanvas :graph="active" />
    </main>
  </div>
</template>

<style scoped>
.flow-page {
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  gap: 8px;
  height: 100%;
  padding: 8px;
}

.flow-page__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 12px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.flow-page__identity {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.flow-page__identity h1 {
  font-size: 15px;
  letter-spacing: 0.02em;
}

.flow-page__links {
  display: flex;
  flex: none;
  gap: 8px;
}

.flow-page__back {
  flex: none;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-dim);
  text-decoration: none;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.flow-page__back:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.flow-page__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.flow-page__tabs button {
  padding: 5px 12px;
  color: var(--text-dim);
}

.flow-page__tabs button.active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--accent);
}

.flow-page__meta {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.flow-page__caption {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-dim);
}

.flow-page__legend {
  display: flex;
  flex: none;
  gap: 10px;
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
}

.legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.legend__dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  border: 1px solid var(--border);
  background: var(--panel-raised);
}

.legend__dot--accent {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.legend__dot--warn {
  border-color: var(--warn);
  background: rgba(255, 196, 107, 0.12);
}

.legend__dot--muted {
  border-style: dashed;
  border-color: var(--border-soft);
  background: var(--panel-soft);
}

.flow-page__refs {
  flex: none;
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
}

.flow-page__stage {
  min-height: 0;
  min-width: 0;
}

@media (max-width: 1100px) {
  .flow-page__meta {
    flex-wrap: wrap;
  }

  .flow-page__refs {
    display: none;
  }
}
</style>
