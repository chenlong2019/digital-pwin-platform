<script setup lang="ts">
/**
 * LightsPanel —— 灯光系统面板。
 *
 * 灯语由**领域层**判定(真机什么状态亮什么灯,是产品行为),
 * 渲染层只负责画;面板这里显示的是渲染器回读的快照,所以看到的一定是
 * 画面上真实在闪的那套灯,而不是界面自己算的。
 *
 * 手动指定灯语只是临时覆盖(调试用),清空即交还飞行状态。
 */
import { computed } from 'vue'
import type { AuxLightMode, BatteryLightMode, StatusLightKey } from '@simulation/three-adapter'
import { STATUS_PATTERN_LIST, batteryLedPlan, describeBatteryLevel } from '@simulation/three-adapter'
import { useSandbox } from '../simulation/injection'
import { formatNumber } from '../utils/format'

const {
  lights,
  statusLightOverride,
  auxBeamVisible,
  setStatusLightOverride,
  setBatteryLightMode,
  setAuxLightMode,
  setAuxBeamVisible,
} = useSandbox()

const BATTERY_MODES: ReadonlyArray<{ key: BatteryLightMode; label: string }> = [
  { key: 'level', label: '电量指示' },
  { key: 'charging', label: '充电中' },
  { key: 'full', label: '已充满' },
  { key: 'fault', label: '电池异常' },
  { key: 'off', label: '熄灭' },
]

const AUX_MODES: ReadonlyArray<{ key: AuxLightMode; label: string }> = [
  { key: 'auto', label: '自动' },
  { key: 'on', label: '常亮' },
  { key: 'off', label: '关闭' },
]

const snapshot = computed(() => lights.value)
const batteryLeds = computed(() => snapshot.value?.batteryLeds ?? [])
const batteryLevel = computed(() => snapshot.value?.batteryLevel ?? 0)
/** 手册第 2 节的灯珠编排(与真机一致) */
const batteryPlan = computed(() => batteryLedPlan(batteryLevel.value))

const statusColor = computed(
  () => STATUS_PATTERN_LIST.find((item) => item.key === snapshot.value?.statusKey)?.uiColor ?? 'var(--text-faint)',
)

function onOverrideChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  setStatusLightOverride(value === '' ? null : (value as StatusLightKey))
}

function onBatteryChange(event: Event): void {
  setBatteryLightMode((event.target as HTMLSelectElement).value as BatteryLightMode)
}

function onAuxChange(event: Event): void {
  setAuxLightMode((event.target as HTMLSelectElement).value as AuxLightMode)
}
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <span class="panel__title">灯光系统</span>
      <span v-if="statusLightOverride" class="tag tag--warn">手动锁定</span>
      <span v-else class="tag tag--ok">跟随飞行状态</span>
    </header>

    <div class="panel__body">
      <!-- 尾部状态灯 -->
      <div class="group">
        <div class="row row--between">
          <span class="field-label">尾部状态灯</span>
          <span class="status-dot" :style="{ background: statusColor }" />
        </div>
        <div class="status-card">
          <span class="status-card__name">{{ snapshot?.statusLabel ?? '未上电' }}</span>
          <span class="hint">{{ snapshot?.statusMeaning ?? '模型载入后显示灯语' }}</span>
        </div>
        <select :value="statusLightOverride ?? ''" @change="onOverrideChange">
          <option value="">跟随飞行状态(自动)</option>
          <option v-for="item in STATUS_PATTERN_LIST" :key="item.key" :value="item.key">
            {{ item.label }} · {{ item.meaning }}
          </option>
        </select>
      </div>

      <!-- 电量灯 -->
      <div class="group">
        <div class="row row--between">
          <span class="field-label">电量指示灯</span>
          <span class="mono readout">{{ formatNumber(batteryLevel, 0) }}%</span>
        </div>
        <div class="led-row">
          <span
            v-for="(led, index) in batteryLeds"
            :key="index"
            class="led"
            :class="{ 'led--on': led.on, 'led--blink': led.blinking && led.on }"
          />
        </div>
        <div class="row row--between hint">
          <span>手册编排</span>
          <span class="mono">{{ describeBatteryLevel(batteryLevel) }}</span>
        </div>
        <select :value="snapshot?.batteryMode ?? 'level'" @change="onBatteryChange">
          <option v-for="item in BATTERY_MODES" :key="item.key" :value="item.key">{{ item.label }}</option>
        </select>
      </div>

      <!-- 底部辅助灯 -->
      <div class="group">
        <div class="row row--between">
          <span class="field-label">底部辅助灯</span>
          <span class="tag" :class="snapshot?.auxOn ? 'tag--ok' : 'tag'">
            {{ snapshot?.auxOn ? '照明中' : snapshot?.auxLocked ? '地面锁定' : '未点亮' }}
          </span>
        </div>
        <select :value="snapshot?.auxMode ?? 'auto'" @change="onAuxChange">
          <option v-for="item in AUX_MODES" :key="item.key" :value="item.key">{{ item.label }}</option>
        </select>
        <button :class="{ active: auxBeamVisible }" @click="setAuxBeamVisible(!auxBeamVisible)">
          {{ auxBeamVisible ? '隐藏光束锥' : '显示光束锥' }}
        </button>
        <p class="hint">真机在地面锁定辅助灯(避免起降时刺眼),起飞后才会亮;光束锥只影响画面,不影响照明。</p>
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

.readout {
  color: var(--accent);
}

.status-card {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 9px;
  border-radius: 8px;
  background: var(--panel-soft);
  border: 1px solid var(--border-soft);
}

.status-card__name {
  font-size: 12.5px;
  color: var(--text);
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  box-shadow: 0 0 6px currentColor;
}

.led-row {
  display: flex;
  gap: 6px;
}

.led {
  flex: 1 1 0;
  height: 12px;
  border-radius: 3px;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  transition:
    background 0.12s linear,
    box-shadow 0.12s linear;
}

.led--on {
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 8px rgba(111, 240, 208, 0.5);
}

.led--blink {
  animation: led-blink 0.9s steps(2, start) infinite;
}

@keyframes led-blink {
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.18;
  }
  100% {
    opacity: 1;
  }
}
</style>
