<script setup lang="ts">
/**
 * ScenePanel —— 场景与环境设置。
 *
 * 「改环境」这件事同样不走旁路:风与天气都通过 Domain API 写进 Sandbox,
 * Agent 再从 SandboxQuery 读回来。所以界面、AI、脚本改环境的效果完全一致。
 *
 * 滑块是**本地输入**,右侧读数是 `environment` 快照里沙盒实际生效的值 ——
 * 两个数一致,说明「界面 → Command → Sandbox → 快照 → 界面」这条闭环是通的。
 */
import { computed, ref } from 'vue'
import type { WeatherKind } from '@simulation/contracts'
import { useSandbox } from '../simulation/injection'
import { formatNumber } from '../utils/format'

const {
  scenario,
  metrics,
  environment,
  telemetry,
  rendererInfo,
  obstacles,
  obstaclesVisible,
  axesVisible,
  setObstaclesVisible,
  setAxesVisible,
  setTimeScale,
  setWeather,
  setWind,
} = useSandbox()

const TIME_SCALES = [0.25, 0.5, 1, 2, 4] as const

const WEATHER_OPTIONS: ReadonlyArray<{ key: WeatherKind; label: string }> = [
  { key: 'clear', label: '晴' },
  { key: 'cloudy', label: '多云' },
  { key: 'overcast', label: '阴' },
  { key: 'rain', label: '雨' },
  { key: 'fog', label: '雾' },
]

const windSpeed = ref(scenario.wind.speed)
const windDirection = ref(scenario.wind.directionDeg)
const weather = ref<WeatherKind>(scenario.weather)

function applyWind(): void {
  setWind(windSpeed.value, windDirection.value)
}

function applyWeather(): void {
  setWeather(weather.value)
}

/** 沙盒里实际生效的环境(来自快照) */
const liveWind = computed(() => environment.value?.wind ?? scenario.wind)
const liveWeather = computed(() => environment.value?.weather ?? scenario.weather)
const liveWeatherLabel = computed(
  () => WEATHER_OPTIONS.find((item) => item.key === liveWeather.value)?.label ?? liveWeather.value,
)
/** 机体感受到的相对风,是判断「风真的生效了」最直接的证据 */
const windRelative = computed(() => telemetry.value?.windRelative ?? '--')

const parts = computed(() => rendererInfo.value.parts)
const missingParts = computed(() => parts.value.filter((part) => !part.found))
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <span class="panel__title">场景与环境</span>
      <span class="tag" :class="rendererInfo.state === 'ready' ? 'tag--ok' : 'tag--warn'">
        {{ rendererInfo.state === 'ready' ? '渲染就绪' : rendererInfo.state === 'error' ? '渲染降级' : '渲染载入中' }}
      </span>
    </header>

    <div class="panel__body">
      <!-- 时间倍率 -->
      <div class="group">
        <span class="field-label">时间倍率</span>
        <div class="grid grid--5">
          <button
            v-for="scale in TIME_SCALES"
            :key="scale"
            :class="{ active: metrics.timeScale === scale }"
            @click="setTimeScale(scale)"
          >
            {{ scale }}×
          </button>
        </div>
      </div>

      <!-- 风 -->
      <div class="group">
        <div class="row row--between">
          <span class="field-label">风速</span>
          <span class="mono readout">{{ formatNumber(liveWind.speed, 1) }} m/s</span>
        </div>
        <input v-model.number="windSpeed" type="range" min="0" max="12" step="0.5" @input="applyWind" />
        <div class="row row--between">
          <span class="field-label">风向(风吹向)</span>
          <span class="mono readout">{{ formatNumber(liveWind.directionDeg, 0) }}°</span>
        </div>
        <input v-model.number="windDirection" type="range" min="0" max="359" step="1" @input="applyWind" />
        <div class="row row--between hint">
          <span>机体感受到的相对风</span>
          <span class="mono">{{ windRelative }}</span>
        </div>
      </div>

      <!-- 天气 -->
      <div class="group">
        <div class="row row--between">
          <span class="field-label">天气</span>
          <span class="hint mono readout">沙盒当前:{{ liveWeatherLabel }}</span>
        </div>
        <select v-model="weather" @change="applyWeather">
          <option v-for="item in WEATHER_OPTIONS" :key="item.key" :value="item.key">{{ item.label }}</option>
        </select>
      </div>

      <!-- 可视化开关 -->
      <div class="group">
        <span class="field-label">可视化</span>
        <div class="grid">
          <button :class="{ active: obstaclesVisible }" @click="setObstaclesVisible(!obstaclesVisible)">
            {{ obstaclesVisible ? '隐藏障碍物' : '显示障碍物' }}
          </button>
          <button :class="{ active: axesVisible }" @click="setAxesVisible(!axesVisible)">
            {{ axesVisible ? '隐藏坐标轴' : '显示坐标轴' }}
          </button>
        </div>
      </div>

      <!-- 场景信息 -->
      <div class="group">
        <span class="field-label">场景</span>
        <dl class="info">
          <div><dt>标识</dt><dd class="mono">{{ scenario.id }}</dd></div>
          <div><dt>确定性种子</dt><dd class="mono">{{ scenario.seed }}</dd></div>
          <div><dt>障碍物</dt><dd class="mono">{{ obstacles.length }} 个 AABB</dd></div>
          <div v-if="scenario.geofence">
            <dt>电子围栏</dt>
            <dd class="mono">
              {{ scenario.geofence.maxX - scenario.geofence.minX }} ×
              {{ scenario.geofence.maxZ - scenario.geofence.minZ }} m · {{ scenario.geofence.maxAltitude }} m 限高
            </dd>
          </div>
        </dl>
      </div>

      <!-- 模型自检 -->
      <div class="group">
        <div class="row row--between">
          <span class="field-label">模型部件</span>
          <span class="tag" :class="missingParts.length === 0 ? 'tag--ok' : 'tag--warn'">
            {{ parts.length - missingParts.length }} / {{ parts.length }} 已识别
          </span>
        </div>
        <div class="parts">
          <span
            v-for="part in parts"
            :key="part.id"
            class="tag"
            :class="part.found ? 'tag--ok' : 'tag--danger'"
            :title="part.drivable ? '可由仿真驱动' : '静态件'"
          >
            {{ part.label }}
          </span>
        </div>
        <p v-if="missingParts.length" class="hint">
          缺失部件只影响对应动画(桨叶自转 / 机臂折叠 / 云台),机体其余部分照常渲染。
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

.grid--5 {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

.grid button {
  width: 100%;
  padding: 5px 2px;
}

.readout {
  color: var(--accent);
}

.info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
}

.info > div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px dashed var(--border-soft);
  font-size: 11px;
  padding: 2px 0;
}

.info dt {
  color: var(--text-faint);
  white-space: nowrap;
}

.info dd {
  margin: 0;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.parts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
