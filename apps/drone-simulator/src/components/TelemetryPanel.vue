<script setup lang="ts">
/**
 * TelemetryPanel —— 遥测面板。
 *
 * 数据全部来自 `telemetry`(DroneAgent 发布的 DroneSnapshot),
 * 也就是「Agent State 的对外视图」——面板读不到内部 State,也就没有机会偷偷改它。
 */
import { computed } from 'vue'
import type { DroneSnapshot } from '@simulation/drone-agent'
import { useSandbox } from '../simulation/injection'
import {
  compassLabel,
  formatClock,
  formatHeading,
  formatMeters,
  formatNumber,
  formatPercent,
  formatSigned,
  formatSpeed,
  formatVolts,
} from '../utils/format'

const { telemetry, task } = useSandbox()

const batteryTone = computed(() => {
  const value = telemetry.value?.batteryPercent ?? 100
  if (value <= 15) return 'bar__fill--danger'
  if (value <= 30) return 'bar__fill--warn'
  return 'bar__fill--ok'
})

/** 需要一眼看到的关键量 */
const highlights = computed(() => {
  const t = telemetry.value
  return [
    { label: '相对高度', value: formatMeters(t?.altitude), extra: `限高 ${formatNumber(t?.altitudeMax, 0)} m` },
    { label: '水平速度', value: formatSpeed(t?.horizontalSpeed), extra: `垂速 ${formatSigned(t?.verticalSpeed)} m/s` },
    { label: '电量', value: formatPercent(t?.batteryPercent), extra: `续航 ${formatClock((t?.remainingMinutes ?? 0) * 60)}` },
    { label: '距返航点', value: formatMeters(t?.distanceToHome), extra: t?.homeRecorded ? '返航点已记录' : '未记录返航点' },
  ]
})

/** 次要量:两列栅格 */
const details = computed(() => {
  const t = telemetry.value
  if (!t) return []
  return [
    { label: '飞行阶段', value: t.phaseLabel },
    { label: '挡位', value: t.modeLabel },
    { label: '定位方式', value: t.positionSourceLabel },
    { label: '机头朝向', value: `${formatHeading(t.heading)} ${compassLabel(t.heading)}` },
    { label: '水平偏移', value: `E ${formatSigned(t.positionX, 1)} / S ${formatSigned(t.positionZ, 1)} m` },
    { label: '姿态', value: `俯仰 ${formatSigned(t.tiltPitch)}° / 横滚 ${formatSigned(t.tiltRoll)}°` },
    { label: '电池电压', value: formatVolts(t.batteryVoltage) },
    { label: '电池电流', value: `${formatNumber(t.batteryCurrent, 1)} A` },
    { label: '电池温度', value: `${formatNumber(t.batteryTemp, 1)} °C` },
    { label: '剩余电量', value: `${formatNumber(t.batteryWhLeft, 2)} Wh` },
    { label: '卫星', value: `${t.satellites} 颗 · HDOP ${formatNumber(t.hdop, 2)}` },
    { label: '图传 / 摇杆', value: `${t.rcBars} / 视觉${t.visionAvailable ? '可用' : '不可用'}` },
    { label: '风力', value: `${formatNumber(t.windSpeed, 1)} m/s · ${compassLabel(t.windDirection)}风 · ${t.windRelative}` },
    { label: '动力负荷', value: `${formatNumber(t.motorLoad * 100, 0)} %` },
    { label: '云台俯仰', value: `${formatNumber(t.gimbalPitch, 1)}° · 变焦 ${formatNumber(t.cameraZoom, 1)}×` },
    { label: '本次飞行', value: formatClock(t.flightTime) },
    { label: '累计时长', value: formatClock(t.totalTime) },
    { label: '避障', value: obstacleText(t.obstacle) },
  ]
})

function obstacleText(obstacle: DroneSnapshot['obstacle']): string {
  if (obstacle.braking) return `刹停 · ${formatMeters(obstacle.forward)} 前方`
  return obstacle.forward === null ? '前方净空' : `前方 ${formatMeters(obstacle.forward)}`
}

const warnings = computed(() => telemetry.value?.warnings ?? [])
const checklist = computed(() => telemetry.value?.checklist ?? [])
/** 只关心 blocking 的项:非阻塞项不通过也能飞 */
const checklistBlocked = computed(() => checklist.value.some((item) => item.blocking && !item.ok))
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <span class="panel__title">遥测</span>
      <span v-if="telemetry" class="tag" :class="telemetry.airborne ? 'tag--info' : ''">
        {{ telemetry.airborne ? '空中' : '地面' }}
      </span>
    </header>

    <div class="panel__body">
      <p v-if="!telemetry" class="hint">等待第一帧快照…</p>

      <template v-else>
        <!-- 电量条 -->
        <div class="battery">
          <div class="battery__head">
            <span class="field-label">电池</span>
            <span class="mono">{{ formatPercent(telemetry.batteryPercent, 1) }}</span>
          </div>
          <div class="bar">
            <div class="bar__fill" :class="batteryTone" :style="{ width: `${Math.max(0, telemetry.batteryPercent)}%` }" />
          </div>
          <div class="battery__mode hint">{{ telemetry.batteryModeText }}</div>
        </div>

        <!-- 四个关键量 -->
        <div class="highlights">
          <div v-for="item in highlights" :key="item.label" class="highlight">
            <div class="highlight__label">{{ item.label }}</div>
            <div class="highlight__value mono">{{ item.value }}</div>
            <div class="highlight__extra">{{ item.extra }}</div>
          </div>
        </div>

        <!-- 次要量 -->
        <dl class="details">
          <div v-for="item in details" :key="item.label" class="details__row">
            <dt>{{ item.label }}</dt>
            <dd class="mono">{{ item.value }}</dd>
          </div>
        </dl>

        <!-- 起飞检查单 -->
        <div class="block">
          <div class="row row--between">
            <span class="field-label">起飞检查单</span>
            <span class="tag" :class="checklistBlocked ? 'tag--warn' : 'tag--ok'">
              {{ checklistBlocked ? '存在阻塞项' : '全部通过' }}
            </span>
          </div>
          <ul class="checks">
            <li v-for="item in checklist" :key="item.id" :class="{ 'checks__item--bad': !item.ok }">
              <span class="checks__mark">{{ item.ok ? '✓' : '✕' }}</span>
              <span class="checks__label">{{ item.label }}</span>
              <span class="checks__detail">{{ item.detail }}</span>
            </li>
            <li v-if="checklist.length === 0" class="hint">未上电,暂无检查项</li>
          </ul>
        </div>

        <!-- 告警 -->
        <div v-if="warnings.length" class="block">
          <span class="field-label">告警</span>
          <ul class="warnings">
            <li v-for="(item, index) in warnings" :key="index">{{ item }}</li>
          </ul>
        </div>

        <!-- 任务进度顺手同步一份,操作时不用来回看 -->
        <div v-if="task" class="block">
          <span class="field-label">任务</span>
          <div class="row row--between">
            <span>{{ task.progress.stage }}</span>
            <span class="mono">{{ task.progress.completed }} / {{ task.progress.total }}</span>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.battery {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.battery__head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.battery__mode {
  text-align: right;
}

.bar {
  height: 7px;
  border-radius: 999px;
  background: #0b1a20;
  border: 1px solid var(--border-soft);
  overflow: hidden;
}

.bar__fill {
  height: 100%;
  transition: width 0.2s ease;
}

.bar__fill--ok {
  background: linear-gradient(90deg, #2fae95, var(--success));
}

.bar__fill--warn {
  background: linear-gradient(90deg, #b8862f, var(--warn));
}

.bar__fill--danger {
  background: linear-gradient(90deg, #b83a48, var(--danger));
}

.highlights {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}

.highlight {
  padding: 7px 9px;
  background: var(--panel-soft);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
}

.highlight__label {
  font-size: 10.5px;
  color: var(--text-faint);
}

.highlight__value {
  font-size: 18px;
  line-height: 1.25;
  color: var(--accent);
}

.highlight__extra {
  font-size: 10.5px;
  color: var(--text-faint);
}

.details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 12px;
  margin: 0;
}

.details__row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0;
  border-bottom: 1px dashed var(--border-soft);
  min-width: 0;
}

.details dt {
  color: var(--text-faint);
  font-size: 11px;
  white-space: nowrap;
}

.details dd {
  margin: 0;
  font-size: 11px;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 7px;
  border-top: 1px solid var(--border-soft);
}

.checks,
.warnings {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.checks li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
}

.checks__mark {
  color: var(--success);
  width: 10px;
}

.checks__item--bad .checks__mark {
  color: var(--warn);
}

.checks__label {
  white-space: nowrap;
}

.checks__detail {
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.warnings li {
  font-size: 11px;
  color: var(--warn);
}
</style>
