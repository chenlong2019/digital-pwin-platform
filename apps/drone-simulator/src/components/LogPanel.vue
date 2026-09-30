<script setup lang="ts">
/**
 * LogPanel —— 事件日志 / 指令日志。
 *
 * Command 表示「我要做什么」,Event 表示「刚才发生了什么」—— 两条流分开列出,
 * 排查「指令发了但没生效」这类问题时,一眼就能看出是发不出去还是没反应(README §23)。
 */
import { computed, ref } from 'vue'
import { useSandbox } from '../simulation/injection'
import { formatClock } from '../utils/format'

const { events, commands, metrics } = useSandbox()

const tab = ref<'events' | 'commands'>('events')

const sortedEvents = computed(() => [...events.value].reverse())
const sortedCommands = computed(() => [...commands.value].reverse())

function levelText(level: string): string {
  switch (level) {
    case 'warn':
      return '警告'
    case 'error':
      return '错误'
    case 'success':
      return '成功'
    default:
      return '信息'
  }
}

const COMMAND_LABELS: Record<string, string> = {
  'agent.powerOn': '上电',
  'agent.powerOff': '下电',
  'agent.takeOff': '起飞',
  'agent.land': '降落',
  'agent.move': '摇杆',
  'agent.hover': '悬停',
  'agent.stop': '停止',
  'agent.returnToHome': '返航',
  'agent.cancelReturnToHome': '取消返航',
  'agent.reset': '重置',
  'task.start': '启动任务',
  'task.pause': '暂停任务',
  'task.resume': '继续任务',
  'task.abort': '中止任务',
  'drone.startMotors': '启动电机',
  'drone.stopMotors': '停止电机',
  'drone.emergencyStop': '紧急停桨',
  'drone.setMode': '切换挡位',
  'drone.setArmFold': '机臂折叠',
  'drone.setConfig': '改配置',
  'drone.setFaults': '注入故障',
  'drone.forceBattery': '强制电量',
  'drone.setGimbalPitch': '云台俯仰',
  'drone.nudgeGimbal': '微调云台',
  'drone.setZoom': '变焦',
  'drone.toggleRecording': '录制开关',
  'drone.takePhoto': '拍照',
}

function commandLabel(type: string): string {
  return COMMAND_LABELS[type] ?? type
}
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <div class="tabs">
        <button :class="{ active: tab === 'events' }" @click="tab = 'events'">事件 {{ sortedEvents.length }}</button>
        <button :class="{ active: tab === 'commands' }" @click="tab = 'commands'">
          指令 {{ sortedCommands.length }}
        </button>
      </div>
      <span class="hint mono">
        tick {{ metrics.tick }} · 丢弃 {{ metrics.droppedSteps }} 步 · 事件 {{ metrics.eventsEmitted }}
      </span>
    </header>

    <div class="panel__body log">
      <template v-if="tab === 'events'">
        <p v-if="sortedEvents.length === 0" class="hint">暂无事件。</p>
        <div v-for="event in sortedEvents" :key="event.eventId" class="log__row" :class="`log__row--${event.level}`">
          <span class="log__time mono">{{ formatClock(event.simulationTime) }}</span>
          <span class="log__tag">{{ levelText(event.level) }}</span>
          <span class="log__type mono">{{ event.type }}</span>
          <span class="log__message">{{ event.message ?? '' }}</span>
        </div>
      </template>

      <template v-else>
        <p v-if="sortedCommands.length === 0" class="hint">暂无指令。用键盘 WASD / 按钮下发一条试试。</p>
        <div v-for="command in sortedCommands" :key="command.commandId" class="log__row">
          <span class="log__time mono">{{ formatClock(command.simulationTime) }}</span>
          <span class="log__tag">{{ command.actorId === 'pilot' ? '操作员' : command.actorId }}</span>
          <span class="log__type mono">{{ command.commandId }}</span>
          <span class="log__message">{{ commandLabel(command.type) }}</span>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 4px;
}

.tabs button {
  padding: 3px 10px;
  font-size: 11px;
  background: transparent;
  border-color: transparent;
  color: var(--text-dim);
}

.tabs button.active {
  background: var(--accent-soft);
  border-color: rgba(111, 240, 208, 0.4);
  color: var(--accent);
}

.log {
  gap: 0;
  font-size: 11px;
}

.log__row {
  display: grid;
  grid-template-columns: 44px 42px 120px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
  padding: 2px 4px;
  border-bottom: 1px dashed var(--border-soft);
}

.log__row:last-child {
  border-bottom: none;
}

.log__time {
  color: var(--text-faint);
}

.log__tag {
  color: var(--text-faint);
}

.log__type {
  color: var(--info);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log__message {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log__row--warn .log__tag,
.log__row--warn .log__message {
  color: var(--warn);
}

.log__row--error .log__tag,
.log__row--error .log__message {
  color: var(--danger);
}

.log__row--success .log__tag,
.log__row--success .log__message {
  color: var(--success);
}
</style>
