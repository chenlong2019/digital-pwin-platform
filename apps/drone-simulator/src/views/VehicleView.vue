<script setup lang="ts">
/**
 * VehicleView —— 轮式载具沙盒页面。
 *
 * 与无人机页面(SandboxView)是**平级**的两个场景入口:
 * 同一个 SimulationDomainAPI、同一个 Sandbox、同一个 Recorder、同一个 ThreeRenderAdapter,
 * 差别只有两处:
 *   ① 会话的领域装配换成 vehicle(见 use-vehicle-simulation)
 *   ② 会话告诉视口该加载哪个机体模型(bodyFactory → CarView)
 *
 * 所以「切换场景」在代码里就是换一个页面 —— 内核那一层完全没有分叉。
 */
import { computed, provide } from 'vue'
import { RouterLink } from 'vue-router'
import LogPanel from '../components/LogPanel.vue'
import SimulationViewport from '../components/SimulationViewport.vue'
import VehicleHud from '../components/VehicleHud.vue'
import { SANDBOX_SIMULATION_KEY } from '../simulation/injection'
import { useVehicleSimulation } from '../simulation/use-vehicle-simulation'

const simulation = useVehicleSimulation()
// 视口与日志面板通过这个 key 取会话 —— 与无人机页面是同一个注入点
provide(SANDBOX_SIMULATION_KEY, simulation)

const { metrics, rendererInfo, sessionLabel, scenario, toggleRun, resetVehicle } = simulation

const runLabel = computed(() => {
  if (metrics.value.status === 'running') return '暂停'
  if (metrics.value.status === 'paused') return '继续'
  return '启动'
})

const runHint = computed(() => {
  const info = rendererInfo.value
  if (info.state === 'error') return info.modelHealth
  if (info.state === 'loading') return '机体模型载入中…'
  const missing = info.parts.filter((part) => !part.found).length
  return missing === 0 ? `模型自检通过 · ${info.parts.length} 项部件` : `模型缺少 ${missing} 项部件`
})
</script>

<template>
  <div class="vehicle">
    <header class="vehicle__bar">
      <div class="vehicle__identity">
        <h1>智能体沙盒仿真 · 汽车</h1>
        <span class="tag tag--info">{{ sessionLabel }}</span>
        <span class="tag">种子 {{ scenario.seed }}</span>
      </div>

      <div class="vehicle__run">
        <span class="hint">{{ runHint }}</span>
        <RouterLink class="vehicle__link" to="/">无人机沙盒</RouterLink>
        <RouterLink class="vehicle__link" to="/flow">模块流程</RouterLink>
        <RouterLink class="vehicle__link" to="/docs">项目文档</RouterLink>
        <button class="primary" @click="toggleRun()">{{ runLabel }}</button>
        <button class="ghost" @click="resetVehicle()">整车复位</button>
      </div>
    </header>

    <div class="vehicle__grid">
      <main class="vehicle__stage">
        <SimulationViewport />
      </main>

      <aside class="vehicle__side">
        <VehicleHud />
      </aside>
    </div>

    <footer class="vehicle__logs">
      <LogPanel />
    </footer>
  </div>
</template>

<style scoped>
.vehicle {
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) minmax(140px, 22vh);
  gap: 8px;
  padding: 8px;
}

.vehicle__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 12px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.vehicle__identity {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.vehicle__identity h1 {
  font-size: 15px;
  letter-spacing: 0.02em;
}

.vehicle__run {
  display: flex;
  align-items: center;
  gap: 10px;
}

.vehicle__link {
  flex: none;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-dim);
  text-decoration: none;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.vehicle__link:hover,
.vehicle__link.router-link-active {
  color: var(--accent);
  border-color: var(--accent);
}

.vehicle__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 8px;
  min-height: 0;
}

.vehicle__stage {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
}

.vehicle__side {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.vehicle__logs {
  min-height: 0;
}
</style>
