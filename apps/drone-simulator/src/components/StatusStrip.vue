<script setup lang="ts">
/**
 * StatusStrip —— 常驻状态摘要。
 *
 * 侧栏改成标签页之后,每个面板一次只能看一组;但电量/高度/速度这几个量
 * 是「操作任何东西时都要瞄一眼」的,所以把它们从面板里提出来常驻。
 * 数据同源(telemetry 快照),只是另一个视图,不重复维护状态。
 */
import { computed } from 'vue'
import { useSandbox } from '../simulation/injection'
import { formatMeters, formatNumber, formatPercent, formatSigned } from '../utils/format'

const { telemetry, task } = useSandbox()

const batteryTone = computed(() => {
  const value = telemetry.value?.batteryPercent ?? 100
  if (value <= 15) return 'strip__bar-fill--danger'
  if (value <= 30) return 'strip__bar-fill--warn'
  return 'strip__bar-fill--ok'
})

const phase = computed(() => telemetry.value?.phaseLabel ?? '未上电')
const airborne = computed(() => telemetry.value?.airborne ?? false)

const taskText = computed(() => {
  const current = task.value
  if (!current) return null
  return `${current.progress.stage} ${current.progress.completed}/${current.progress.total}`
})
</script>

<template>
  <section class="strip" aria-label="飞行状态摘要">
    <!-- 电量:占一整行,条形比数字更早被余光捕捉到 -->
    <div class="strip__row">
      <span class="strip__label">电量</span>
      <span class="strip__value mono">{{ formatPercent(telemetry?.batteryPercent, 1) }}</span>
      <div class="strip__bar">
        <i
          class="strip__bar-fill"
          :class="batteryTone"
          :style="{ width: `${Math.max(0, Math.min(100, telemetry?.batteryPercent ?? 0))}%` }"
        />
      </div>
    </div>

    <div class="strip__grid">
      <div class="strip__cell">
        <span class="strip__label">相对高度</span>
        <span class="strip__value mono">{{ formatMeters(telemetry?.altitude) }}</span>
      </div>
      <div class="strip__cell">
        <span class="strip__label">水平速度</span>
        <span class="strip__value mono">
          {{ formatNumber(telemetry?.horizontalSpeed, 1) }} m/s
          <em class="strip__sub">{{ formatSigned(telemetry?.verticalSpeed, 1) }} 垂直</em>
        </span>
      </div>
      <div class="strip__cell">
        <span class="strip__label">阶段</span>
        <span class="strip__value" data-testid="status-phase" :class="airborne ? 'strip__value--air' : ''">
          {{ phase }}
        </span>
      </div>
      <div class="strip__cell">
        <span class="strip__label">任务</span>
        <span class="strip__value mono">{{ taskText ?? '—' }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.strip {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 11px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.strip__row {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

.strip__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 10px;
}

.strip__cell {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.strip__label {
  font-size: 10.5px;
  color: var(--text-faint);
  white-space: nowrap;
}

.strip__value {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  text-align: right;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.strip__value--air {
  color: var(--accent);
}

.strip__sub {
  font-style: normal;
  font-weight: 400;
  font-size: 10px;
  color: var(--text-faint);
}

.strip__bar {
  height: 6px;
  border-radius: 999px;
  background: #0b1a20;
  border: 1px solid var(--border-soft);
  overflow: hidden;
}

.strip__bar-fill {
  display: block;
  height: 100%;
  transition: width 0.2s ease;
}

.strip__bar-fill--ok {
  background: linear-gradient(90deg, #2fae95, var(--success));
}

.strip__bar-fill--warn {
  background: linear-gradient(90deg, #b8862f, var(--warn));
}

.strip__bar-fill--danger {
  background: linear-gradient(90deg, #b83a48, var(--danger));
}
</style>
