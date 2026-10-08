<script setup lang="ts">
/**
 * SandboxView —— 简单场景的整页装配。
 *
 * 这是唯一「把它们组起来」的地方:
 *   · 建一次会话,provide 给所有面板
 *   · 装上键盘虚拟摇杆
 *   · 排好 视口 / 侧栏 / 日志 三块
 *
 * 组件之间不互相通信,都只跟会话说话 —— 少一层耦合,也多一个能独立测试的边界。
 */
import { computed, provide, ref } from 'vue'
import { PLATFORM_COMMAND } from '@simulation/contracts'
import CameraPanel from '../components/CameraPanel.vue'
import FlightControls from '../components/FlightControls.vue'
import LightsPanel from '../components/LightsPanel.vue'
import LogPanel from '../components/LogPanel.vue'
import RadarPanel from '../components/RadarPanel.vue'
import ScenePanel from '../components/ScenePanel.vue'
import SimulationViewport from '../components/SimulationViewport.vue'
import StatusStrip from '../components/StatusStrip.vue'
import StickDeck from '../components/StickDeck.vue'
import TaskPanel from '../components/TaskPanel.vue'
import TelemetryPanel from '../components/TelemetryPanel.vue'
import { SANDBOX_SIMULATION_KEY } from '../simulation/injection'
import { useSandboxSimulation } from '../simulation/use-sandbox-simulation'
import { useFlightStick } from '../simulation/use-flight-stick'

const simulation = useSandboxSimulation({ label: '无人机测试沙盒 · 简单场景' })
provide(SANDBOX_SIMULATION_KEY, simulation)

const { metrics, telemetry, scenario, sessionLabel, toggleRun, sendMove, sendToDrone, resetDrone } = simulation

/** 空中才接受键盘输入:地面上推杆没有意义,也免得误发一堆指令 */
const airborne = computed(() => telemetry.value?.airborne ?? false)

const flightStick = useFlightStick({
  enabled: airborne,
  onChange: (axes) => sendMove(axes),
  // 归中发 hover 而不是「全零的 move」:指令日志里语义更清楚
  onNeutral: () => sendToDrone(PLATFORM_COMMAND.hover),
})

/** 摇杆台与键盘共用同一份杆量:拖拽只把盘位报给输入层,合成与下发都在那里 */
const stickAxes = flightStick.axes
const stickDials = flightStick.dials

function onStickMove(payload: { side: 'left' | 'right'; value: { x: number; y: number } }): void {
  flightStick.setDial(payload.side, payload.value)
}

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

/**
 * 侧栏标签页:一次只展开一组,窄栏不再被七个面板挤扁。
 * 感知 = 测距雷达 + 灯光系统(都是「机体对外的感知与表达」)。
 */
const tabs = [
  { id: 'flight', label: '飞行' },
  { id: 'camera', label: '相机' },
  { id: 'sense', label: '感知' },
  { id: 'task', label: '任务' },
  { id: 'scene', label: '场景' },
  { id: 'telemetry', label: '遥测' },
] as const

type TabId = (typeof tabs)[number]['id']
const activeTab = ref<TabId>('flight')
</script>

<template>
  <div class="sandbox">
    <header class="sandbox__bar">
      <div class="sandbox__identity">
        <h1>智能体沙盒仿真</h1>
        <span class="tag tag--info">{{ sessionLabel }}</span>
        <span class="tag">种子 {{ scenario.seed }}</span>
      </div>

      <div class="sandbox__run">
        <span class="hint">{{ runHint }}</span>
        <RouterLink class="sandbox__link" to="/car">汽车沙盒</RouterLink>
        <RouterLink class="sandbox__link" to="/flow">模块流程</RouterLink>
        <RouterLink class="sandbox__link" to="/docs">项目文档</RouterLink>
        <button class="primary" @click="toggleRun()">{{ runLabel }}</button>
        <button class="ghost" @click="resetDrone()">整体重置</button>
      </div>
    </header>

    <div class="sandbox__grid">
      <main class="sandbox__stage">
        <SimulationViewport />
        <!-- 常驻在视口正下方:操纵与看画面是同一件事,不该藏进标签页 -->
        <StickDeck
          :left="stickDials.left"
          :right="stickDials.right"
          :axes="stickAxes"
          :disabled="!airborne"
          @move="onStickMove"
          @neutral="sendToDrone(PLATFORM_COMMAND.hover)"
        />
      </main>

      <aside class="sandbox__side">
        <!-- 常驻摘要:不管切到哪个标签页,电量/高度/速度都要能余光扫到 -->
        <StatusStrip />

        <nav class="side-tabs" role="tablist" aria-label="控制面板分组">
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
          </button>
        </nav>

        <!-- v-show 而不是 v-if:面板的本地状态(录像中、滑杆位置)不能因切页被销毁 -->
        <div class="side-panes">
          <div v-show="activeTab === 'flight'" class="side-pane" data-testid="pane-flight">
            <FlightControls />
          </div>
          <div v-show="activeTab === 'camera'" class="side-pane" data-testid="pane-camera">
            <CameraPanel />
          </div>
          <div v-show="activeTab === 'sense'" class="side-pane side-pane--stack" data-testid="pane-sense">
            <RadarPanel />
            <LightsPanel />
          </div>
          <div v-show="activeTab === 'task'" class="side-pane" data-testid="pane-task">
            <TaskPanel />
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

    <footer class="sandbox__logs">
      <LogPanel />
    </footer>
  </div>
</template>

<style scoped>
.sandbox {
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) minmax(140px, 22vh);
  gap: 8px;
  padding: 8px;
}

.sandbox__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 12px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.sandbox__identity {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.sandbox__identity h1 {
  font-size: 15px;
  letter-spacing: 0.02em;
}

.sandbox__run {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sandbox__link {
  flex: none;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-dim);
  text-decoration: none;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.sandbox__link:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.sandbox__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 404px;
  gap: 8px;
  min-height: 0;
}

.sandbox__stage {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 8px;
}

.sandbox__side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.side-tabs {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.side-tabs__item {
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

.sandbox__logs {
  min-height: 0;
}

@media (max-width: 1180px) {
  .sandbox__grid {
    grid-template-columns: minmax(0, 1fr) 348px;
  }
}
</style>
