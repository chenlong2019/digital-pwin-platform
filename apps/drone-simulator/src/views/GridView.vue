<script setup lang="ts">
/**
 * GridView —— 无人机电网巡检页。
 *
 * 这是「行业纵深」那条线的落点:同一个仿真内核、同一套三维视口、同一个会话粘合点,
 * 换上一份行业包,就成了一个能跑完整作业流程的应用 ——
 *
 *   资产台账 → 航线规划 → 逐塔转场/对准/采集 → 缺陷判定 → 巡检报告 → 导出
 *
 * 页面只做三件事:provide 会话、排版面、给入口。作业逻辑一行都不在这里
 * (在 packages/grid-inspection),面板也不互相通信(都只跟会话说话)。
 */
import { computed, provide, ref } from 'vue'
import CameraPanel from '../components/CameraPanel.vue'
import InspectionPanel from '../components/InspectionPanel.vue'
import LogPanel from '../components/LogPanel.vue'
import ReportPanel from '../components/ReportPanel.vue'
import ScenePanel from '../components/ScenePanel.vue'
import SimulationViewport from '../components/SimulationViewport.vue'
import StatusStrip from '../components/StatusStrip.vue'
import TelemetryPanel from '../components/TelemetryPanel.vue'
import { GRID_INSPECTION_KEY, SANDBOX_SIMULATION_KEY } from '../simulation/injection'
import { useGridInspection } from '../simulation/use-grid-inspection'

const simulation = useGridInspection()
// 两个 key 都提供:视口等通用组件走通用 key,巡检面板走巡检 key
provide(SANDBOX_SIMULATION_KEY, simulation)
provide(GRID_INSPECTION_KEY, simulation)

const { metrics, scenario, sessionLabel, route, report, toggleRun, resetDrone } = simulation

const runLabel = computed(() => (metrics.value.status === 'running' ? '暂停仿真' : '启动仿真'))
const runHint = computed(() => {
  switch (metrics.value.status) {
    case 'running':
      return '固定 60 Hz 推进中'
    case 'paused':
      return '已暂停,画面仍可自由环视'
    default:
      return '尚未启动'
  }
})

const tabs = [
  { id: 'inspection', label: '巡检' },
  { id: 'report', label: '报告' },
  { id: 'camera', label: '相机' },
  { id: 'scene', label: '场景' },
  { id: 'telemetry', label: '遥测' },
] as const

type TabId = (typeof tabs)[number]['id']
const activeTab = ref<TabId>('inspection')

/** 报告中一旦出现缺陷/疑似,标签上就挂个角标 —— 巡检时不用一直盯着面板 */
const alarmCount = computed(() => {
  const current = report.value
  return current ? current.summary.alarms : 0
})

const coverageText = computed(() => {
  const current = report.value
  if (!current) return `航线 ${route.value.shots.length} 拍点`
  return `已检 ${current.summary.partsChecked}/${current.summary.partsTotal} 部位`
})
</script>

<template>
  <div class="grid-page">
    <header class="grid-page__bar">
      <div class="grid-page__identity">
        <h1>无人机电网巡检</h1>
        <span class="tag tag--info">{{ sessionLabel }}</span>
        <span class="tag">种子 {{ scenario.seed }}</span>
        <span class="tag tag--ok">{{ coverageText }}</span>
      </div>

      <div class="grid-page__run">
        <span class="hint">{{ runHint }}</span>
        <RouterLink class="grid-page__link" to="/">无人机沙盒</RouterLink>
        <RouterLink class="grid-page__link" to="/car">汽车沙盒</RouterLink>
        <RouterLink class="grid-page__link" to="/replay">飞行回放</RouterLink>
        <RouterLink class="grid-page__link" to="/docs">项目文档</RouterLink>
        <button class="primary" @click="toggleRun()">{{ runLabel }}</button>
        <button class="ghost" @click="resetDrone()">整体重置</button>
      </div>
    </header>

    <div class="grid-page__grid">
      <main class="grid-page__stage">
        <SimulationViewport />
      </main>

      <aside class="grid-page__side">
        <StatusStrip />

        <nav class="side-tabs" role="tablist" aria-label="巡检面板分组">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            role="tab"
            class="side-tabs__item"
            :class="{ 'side-tabs__item--active': activeTab === tab.id }"
            :aria-selected="activeTab === tab.id"
            :data-testid="`tab-${tab.id}`"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
            <span v-if="tab.id === 'report' && alarmCount > 0" class="side-tabs__badge mono">
              {{ alarmCount }}
            </span>
          </button>
        </nav>

        <!-- v-show 而不是 v-if:面板的本地状态(方案滑杆、展开的拍点清单)不能因切页被销毁 -->
        <div class="side-panes">
          <div v-show="activeTab === 'inspection'" class="side-pane" data-testid="pane-inspection">
            <InspectionPanel />
          </div>
          <div v-show="activeTab === 'report'" class="side-pane" data-testid="pane-report">
            <ReportPanel />
          </div>
          <div v-show="activeTab === 'camera'" class="side-pane" data-testid="pane-camera">
            <CameraPanel />
          </div>
          <div v-show="activeTab === 'scene'" class="side-pane" data-testid="pane-scene">
            <ScenePanel />
          </div>
          <div v-show="activeTab === 'telemetry'" class="side-pane" data-testid="pane-telemetry">
            <TelemetryPanel />
          </div>
        </div>
      </aside>
    </div>

    <footer class="grid-page__logs">
      <LogPanel />
    </footer>
  </div>
</template>

<style scoped>
.grid-page {
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) minmax(140px, 22vh);
  gap: 8px;
  padding: 8px;
}

.grid-page__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 12px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.grid-page__identity {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.grid-page__identity h1 {
  font-size: 15px;
  letter-spacing: 0.02em;
}

.grid-page__run {
  display: flex;
  align-items: center;
  gap: 10px;
}

.grid-page__link {
  flex: none;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-dim);
  text-decoration: none;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.grid-page__link:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.grid-page__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 404px;
  gap: 8px;
  min-height: 0;
}

.grid-page__stage {
  min-width: 0;
  min-height: 0;
}

.grid-page__side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.side-tabs {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.side-tabs__item {
  position: relative;
  padding: 6px 0;
  text-align: center;
  background: transparent;
  border-color: transparent;
  color: var(--text-faint);
  border-radius: 7px;
  font-size: 12px;
}

.side-tabs__item:hover:not(:disabled) {
  background: var(--panel-raised);
  color: var(--text);
}

.side-tabs__item--active,
.side-tabs__item--active:hover:not(:disabled) {
  background: var(--accent-soft);
  border-color: rgba(111, 240, 208, 0.45);
  color: var(--accent);
}

.side-tabs__badge {
  position: absolute;
  top: 1px;
  right: 3px;
  min-width: 15px;
  padding: 0 4px;
  font-size: 9.5px;
  line-height: 14px;
  color: var(--danger);
  background: rgba(255, 111, 126, 0.14);
  border: 1px solid rgba(255, 111, 126, 0.4);
  border-radius: 999px;
}

.side-panes {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  display: flex;
}

.side-pane {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
  padding-right: 2px;
}

.side-pane :deep(.panel) {
  flex: 0 0 auto;
}

.side-pane :deep(.panel:only-child) {
  flex: 1 1 auto;
}

.grid-page__logs {
  min-height: 0;
}

@media (max-width: 1180px) {
  .grid-page__grid {
    grid-template-columns: minmax(0, 1fr) 348px;
  }
}
</style>
