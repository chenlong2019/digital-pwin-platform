<script setup lang="ts">
/**
 * TaskPanel —— 航点任务面板。
 *
 * 值得注意:任务**不是**应用层写的一段循环,而是平台里一个真正的 Task 实现
 * (task-core 的 WaypointTask),它只使用平台契约指令(agent.move / takeOff / land …)。
 * 换个机型,同一个任务原样能跑 —— 面板这边一点都不用改。
 */
import { computed, ref } from 'vue'
import { defaultWaypoints } from '@simulation/task-core'
import { useSandbox } from '../simulation/injection'
import { formatMeters, formatNumber } from '../utils/format'

const { task, taskResult, createWaypointTask, startTask, pauseTask, resumeTask, abortTask, telemetry } = useSandbox()

const waypoints = ref(defaultWaypoints())

const METRIC_LABELS: Record<string, string> = {
  waypointsReached: '已到达航点',
  waypointsTotal: '航点总数',
  distanceFlown: '实际航程(m)',
  maxAltitude: '最大高度(m)',
}

const statusLabel = computed(() => {
  switch (task.value?.status) {
    case 'running':
      return '执行中'
    case 'paused':
      return '已暂停'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'aborted':
      return '已中止'
    case 'pending':
      return '待启动'
    default:
      return '未创建'
  }
})

const statusTone = computed(() => {
  switch (task.value?.status) {
    case 'running':
      return 'tag--ok'
    case 'paused':
      return 'tag--warn'
    case 'failed':
    case 'aborted':
      return 'tag--danger'
    case 'completed':
      return 'tag--info'
    default:
      return ''
  }
})

const progressRatio = computed(() => {
  const progress = task.value?.progress
  if (!progress || progress.total === 0) return 0
  return Math.round((progress.completed / progress.total) * 100)
})

const canCreate = computed(() => telemetry.value?.airborne !== true)

const resultMetrics = computed(() => {
  const result = taskResult.value
  if (!result) return []
  return Object.entries(result.metrics).map(([key, value]) => ({ key, label: METRIC_LABELS[key] ?? key, value }))
})

function create(): void {
  createWaypointTask(waypoints.value)
}
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <span class="panel__title">航点任务</span>
      <span class="tag" :class="statusTone">{{ statusLabel }}</span>
    </header>

    <div class="panel__body">
      <!-- 航点清单 -->
      <div class="waypoints">
        <div v-for="(waypoint, index) in waypoints" :key="waypoint.id" class="waypoint">
          <span class="waypoint__index mono">{{ index + 1 }}</span>
          <span class="waypoint__label">{{ waypoint.label }}</span>
          <span class="waypoint__coord mono">
            E {{ formatNumber(waypoint.x, 0) }} / S {{ formatNumber(waypoint.z, 0) }} · {{ formatMeters(waypoint.altitude, 0) }}
          </span>
        </div>
      </div>

      <!-- 进度 -->
      <template v-if="task">
        <div class="progress">
          <div class="row row--between">
            <span class="field-label">当前阶段</span>
            <span>{{ task.progress.stage }}</span>
          </div>
          <div class="bar">
            <div class="bar__fill" :style="{ width: `${progressRatio}%` }" />
          </div>
          <div class="row row--between hint">
            <span class="mono">{{ task.progress.completed }} / {{ task.progress.total }} 节点</span>
            <span class="mono">{{ progressRatio }} %</span>
          </div>
        </div>
      </template>

      <!-- 控制 -->
      <div class="grid">
        <button class="primary" :disabled="!canCreate" @click="create">创建航点任务</button>
        <button :disabled="!task || task.status !== 'pending'" @click="startTask()">启动</button>
        <button :disabled="!task || task.status !== 'running'" @click="pauseTask()">暂停</button>
        <button :disabled="!task || task.status !== 'paused'" @click="resumeTask()">继续</button>
        <button
          class="ghost danger"
          :disabled="!task || task.status === 'completed' || task.status === 'aborted'"
          @click="abortTask()"
        >
          中止任务
        </button>
      </div>

      <!-- 结果 -->
      <div v-if="taskResult" class="result">
        <span class="field-label">任务结果</span>
        <div class="hint">{{ taskResult.message }}</div>
        <dl class="metrics">
          <div v-for="item in resultMetrics" :key="item.key" class="metrics__row">
            <dt>{{ item.label }}</dt>
            <dd class="mono">{{ formatNumber(item.value, 1) }}</dd>
          </div>
        </dl>
      </div>

      <p class="hint">
        任务只发平台指令(agent.takeOff / agent.move / agent.land / agent.hover),不认识「无人机」这个概念,
        所以同一份实现可以直接驱动车 / 船 / 机器人。
      </p>
    </div>
  </section>
</template>

<style scoped>
.waypoints {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.waypoint {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 8px;
  background: var(--panel-soft);
  border: 1px solid var(--border-soft);
  border-radius: 7px;
}

.waypoint__index {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  font-size: 10px;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 5px;
}

.waypoint__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.waypoint__coord {
  font-size: 10.5px;
  color: var(--text-faint);
  white-space: nowrap;
}

.progress {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.bar {
  height: 6px;
  border-radius: 999px;
  background: #0b1a20;
  border: 1px solid var(--border-soft);
  overflow: hidden;
}

.bar__fill {
  height: 100%;
  background: linear-gradient(90deg, #2fae95, var(--accent));
  transition: width 0.25s ease;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.grid button {
  width: 100%;
}

.result {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 7px;
  border-top: 1px solid var(--border-soft);
}

.metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 12px;
  margin: 0;
}

.metrics__row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px dashed var(--border-soft);
  font-size: 11px;
}

.metrics dt {
  color: var(--text-faint);
}

.metrics dd {
  margin: 0;
}
</style>
