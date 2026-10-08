<script setup lang="ts">
/**
 * InspectionPanel —— 电网巡检的**作业**面板(与 ReportPanel 分工明确)。
 *
 * 这里回答四个问题,按现场的顺序:
 *   ① 巡哪条线、一共要拍多少 —— 航线规模,改作业方案会当场重算
 *   ② 怎么拍 —— 镜头倍率与单拍点采集时长,这两项直接进成像质量模型
 *   ③ 现在到哪了 —— 阶段、拍点进度、云台在瞄什么(读数来自 Agent 的瞄准解算)
 *   ④ 逐塔什么情况 —— 每基塔采了几个部位、报出几条缺陷/疑似
 *
 * 它**不显示地面真值**:真值属于对账,放在报告面板并明确标注。作业面板若把真值
 * 混进来,现场人员就没法判断「这套判定到底能不能用」了。
 */
import { computed } from 'vue'
import { PLATFORM_COMMAND } from '@simulation/contracts'
import type { DefectSeverity } from '@simulation/grid-inspection'
import { PART_KIND_LABELS, TOWER_TYPE_LABELS } from '@simulation/grid-inspection'
import { useGridSession } from '../simulation/injection'
import { compassLabel, formatClock, formatMeters, formatNumber } from '../utils/format'

const session = useGridSession()
const {
  line,
  route,
  report,
  lensZoom,
  dwellSeconds,
  task,
  telemetry,
  createInspectionTask,
  abortInspection,
  startTask,
  pauseTask,
  resumeTask,
  sendToDrone,
} = session

const airborne = computed(() => telemetry.value?.airborne === true)

/** 计划已锁:任务在跑(含待启动)时改方案会让界面与任务手里的那份航线对不上 */
const planLocked = computed(() => {
  const status = task.value?.status
  return status === 'pending' || status === 'running' || status === 'paused'
})

const canCreate = computed(() => !planLocked.value && !airborne.value)

const statusLabel = computed(() => {
  switch (task.value?.status) {
    case 'running':
      return '巡检中'
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

/** 进度按拍点计 —— 与任务的上报口径保持一致,不另算一套 */
const shotProgress = computed(() => {
  const progress = task.value?.progress
  if (!progress || progress.total === 0) return { done: 0, total: route.value.shots.length, ratio: 0 }
  return {
    done: progress.completed,
    total: progress.total,
    ratio: Math.round((progress.completed / progress.total) * 100),
  }
})

const estimateCaptureSeconds = computed(() => route.value.shots.length * route.value.dwellSeconds)

/** 云台瞄准读数:解算在 drone-agent 里做,这里只做显示 */
const aim = computed(() => telemetry.value?.aim ?? null)

const aimTone = computed(() => {
  const current = aim.value
  if (!current) return ''
  return Math.abs(current.aimErrorDeg) <= 5 && !current.pitchLimited ? 'tag--ok' : 'tag--warn'
})

interface TowerRow {
  readonly towerId: string
  readonly towerLabel: string
  readonly towerTypeLabel: string
  readonly partsTotal: number
  readonly partsChecked: number
  readonly defectsReported: number
  readonly suspects: number
  readonly worstSeverity: DefectSeverity | null
}

/**
 * 塔清单:任务建好之前也要能看 —— 那时一律显示「计划规模 + 零进度」,
 * 而不是给一张空表,否则用户看不出这条线一共要检多少东西。
 */
const towerRows = computed<TowerRow[]>(() => {
  const current = report.value
  if (current) {
    return current.towers.map((tower) => ({
      towerId: tower.towerId,
      towerLabel: tower.towerLabel,
      towerTypeLabel: tower.towerTypeLabel,
      partsTotal: tower.partsTotal,
      partsChecked: tower.partsChecked,
      defectsReported: tower.defectsReported,
      suspects: tower.suspects,
      worstSeverity: tower.worstSeverity,
    }))
  }
  return line.towers.map((tower) => ({
    towerId: tower.id,
    towerLabel: tower.label,
    towerTypeLabel: TOWER_TYPE_LABELS[tower.type],
    partsTotal: route.value.parts.filter((part) => part.towerId === tower.id).length,
    partsChecked: 0,
    defectsReported: 0,
    suspects: 0,
    worstSeverity: null,
  }))
})

function towerState(row: TowerRow): { label: string; tone: string } {
  if (row.partsChecked === 0) return { label: '未检', tone: 'tag' }
  if (row.partsChecked < row.partsTotal) return { label: '进行中', tone: 'tag tag--info' }
  if (row.defectsReported > 0) return { label: '有缺陷', tone: 'tag tag--danger' }
  if (row.suspects > 0) return { label: '待复核', tone: 'tag tag--warn' }
  return { label: '正常', tone: 'tag tag--ok' }
}

/** 拍点清单里每一拍拍什么 —— 从航线里取,和任务执行的是同一份计划 */
const shotRows = computed(() =>
  route.value.shots.map((shot, index) => ({
    index: index + 1,
    id: shot.id,
    towerLabel: shot.towerLabel,
    label: shot.label,
    kinds: [...new Set(shot.parts.map((part) => PART_KIND_LABELS[part.kind]))].join(' / '),
  })),
)

function createAndStart(): void {
  const id = createInspectionTask()
  if (id !== null) startTask()
}
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <span class="panel__title">巡检作业</span>
      <span class="tag" :class="statusTone">{{ statusLabel }}</span>
    </header>

    <div class="panel__body">
      <!-- ① 线路与航线规模 -->
      <div class="stack">
        <div class="row row--between">
          <span class="field-label">线路</span>
          <span>{{ line.label }}</span>
        </div>
        <dl class="metrics">
          <div class="metrics__row">
            <dt>电压等级</dt>
            <dd class="mono">{{ line.voltageKv }} kV</dd>
          </div>
          <div class="metrics__row">
            <dt>杆塔</dt>
            <dd class="mono">{{ line.towers.length }} 基</dd>
          </div>
          <div class="metrics__row">
            <dt>线路走向</dt>
            <dd class="mono">{{ compassLabel(line.bearingDeg) }}</dd>
          </div>
          <div class="metrics__row">
            <dt>拍点 / 部位</dt>
            <dd class="mono" data-testid="plan-scale">{{ route.shots.length }} / {{ route.parts.length }}</dd>
          </div>
          <div class="metrics__row">
            <dt>转场里程</dt>
            <dd class="mono">{{ formatMeters(route.transitLengthM, 0) }}</dd>
          </div>
          <div class="metrics__row">
            <dt>采集净时长</dt>
            <dd class="mono" data-testid="plan-capture">{{ formatClock(estimateCaptureSeconds) }}</dd>
          </div>
        </dl>
      </div>

      <!-- ② 作业方案 -->
      <div class="stack plan">
        <div class="row row--between">
          <span class="field-label">作业方案</span>
          <span v-if="planLocked" class="hint">任务进行中,方案已锁定</span>
        </div>

        <label class="slider">
          <span class="slider__name">镜头倍率</span>
          <input
            v-model.number="lensZoom"
            type="range"
            min="1"
            max="4"
            step="0.5"
            :disabled="planLocked"
            data-testid="lens-zoom"
          />
          <span class="mono slider__value">{{ lensZoom.toFixed(1) }}×</span>
        </label>

        <label class="slider">
          <span class="slider__name">单拍点采集</span>
          <!-- 下限取 0.4 而不是 0.5:步长 0.2 时 0.5 起点的格子里没有默认值 2.4,
               滑杆一碰就会跳到 2.5 —— 默认值必须落在自己滑杆的格子上 -->
          <input
            v-model.number="dwellSeconds"
            type="range"
            min="0.4"
            max="6"
            step="0.2"
            :disabled="planLocked"
            data-testid="dwell-seconds"
          />
          <span class="mono slider__value">{{ dwellSeconds.toFixed(1) }} s</span>
        </label>

        <p class="hint">
          这两项会直接进成像质量模型:倍率决定特征落在几个像素上,采集时长决定悬停多久再判定。
          改完航线当场重算 —— 拍点数是推导出来的,不是写死的。
        </p>
      </div>

      <!-- ③ 进度与云台读数 -->
      <div class="stack progress">
        <div class="row row--between">
          <span class="field-label">当前阶段</span>
          <span class="mono">{{ task?.progress.stage ?? '—' }}</span>
        </div>
        <div class="bar">
          <div class="bar__fill" :style="{ width: `${shotProgress.ratio}%` }" />
        </div>
        <div class="row row--between hint">
          <span class="mono">{{ shotProgress.done }} / {{ shotProgress.total }} 拍点</span>
          <span class="mono">{{ shotProgress.ratio }} %</span>
        </div>

        <div v-if="aim" class="aim">
          <div class="row row--between">
            <span class="field-label">载荷瞄准</span>
            <span class="tag" :class="aimTone">{{ aim.aligned ? '已对准' : '调整中' }}</span>
          </div>
          <dl class="metrics">
            <div class="metrics__row">
              <dt>目标</dt>
              <dd class="mono">{{ aim.label }}</dd>
            </div>
            <div class="metrics__row">
              <dt>距离</dt>
              <dd class="mono">{{ formatMeters(aim.distanceM, 1) }}</dd>
            </div>
            <div class="metrics__row">
              <dt>云台俯仰 / 偏航</dt>
              <dd class="mono">{{ formatNumber(aim.pitchDeg, 1) }}° / {{ formatNumber(aim.yawDeg, 1) }}°</dd>
            </div>
            <div class="metrics__row">
              <dt>残余瞄准误差</dt>
              <dd class="mono">{{ formatNumber(aim.aimErrorDeg, 1) }}°</dd>
            </div>
          </dl>
          <p v-if="aim.yawLimited" class="hint">
            云台偏航行程只有 ±5°,残余误差要靠转机身补 —— 这正是巡检要先转机身再拍的原因。
          </p>
        </div>
      </div>

      <!-- 控制 -->
      <div class="grid">
        <button
          class="primary"
          :disabled="!canCreate"
          data-testid="create-inspection"
          @click="createAndStart()"
        >
          创建并启动巡检
        </button>
        <button :disabled="task?.status !== 'paused'" @click="pauseTask()">暂停</button>
        <button :disabled="task?.status !== 'paused'" @click="resumeTask()">继续</button>
        <button
          class="ghost danger"
          :disabled="!task || task.status === 'completed' || task.status === 'aborted'"
          data-testid="abort-inspection"
          @click="abortInspection()"
        >
          中止巡检
        </button>
      </div>

      <div v-if="task?.result" class="result">
        <span class="field-label">任务结果</span>
        <div class="hint">{{ task.result.message }}</div>
      </div>

      <!-- 安全出口:中止之后机体还在空中,得让它回得来。这一页没有手动摇杆,
           所以这两条不是「顺带放的按钮」,而是操作员唯一能落地的入口。 -->
      <div class="stack exits">
        <span class="field-label">安全出口</span>
        <div class="grid">
          <button
            :disabled="!airborne"
            data-testid="inspection-rth"
            @click="sendToDrone(PLATFORM_COMMAND.returnToHome, { reason: '巡检操作员指令' })"
          >
            自动返航
          </button>
          <button
            :disabled="!airborne"
            data-testid="inspection-land"
            @click="sendToDrone(PLATFORM_COMMAND.land)"
          >
            自动降落
          </button>
        </div>
        <p class="hint">
          巡检任务本身跑完会自动降落;中止是异常路径,之后由操作员决定是返航还是原地降落 ——
          所以这两条一直留着,而不是收回权限。
        </p>
      </div>

      <!-- ④ 塔清单 -->
      <div class="stack">
        <span class="field-label">逐塔情况</span>
        <div class="towers">
          <div v-for="row in towerRows" :key="row.towerId" class="tower" data-testid="tower-row">
            <span class="tower__id mono">{{ row.towerId }}</span>
            <span class="tower__label">
              {{ row.towerLabel }}
              <span class="hint">· {{ row.towerTypeLabel }}</span>
            </span>
            <span class="tower__count mono">{{ row.partsChecked }}/{{ row.partsTotal }}</span>
            <span class="tag" :class="towerState(row).tone">{{ towerState(row).label }}</span>
          </div>
        </div>
        <p class="hint">
          每塔 11 个检查部位(塔头 1 + 横担 4 + 绝缘子 4 + 塔身 1 + 塔基 1),按「方位 + 距离」
          分组后合并成 4 个拍点 —— 塔头与四段横担能同侧同距一次拍全,上下层绝缘子各一拍,塔身塔基一拍。
          <span v-if="report">报出缺陷 {{ report.summary.defectsReported }} 条、疑似 {{ report.summary.suspects }} 条。</span>
        </p>
      </div>

      <!-- 拍点清单 -->
      <details class="shots">
        <summary>航线拍点({{ shotRows.length }} 个)</summary>
        <div class="shots__list">
          <div v-for="shot in shotRows" :key="shot.id" class="shot">
            <span class="shot__index mono">{{ shot.index }}</span>
            <span class="shot__label">{{ shot.label }}</span>
            <span class="shot__kinds hint">{{ shot.kinds }}</span>
          </div>
        </div>
      </details>
    </div>
  </section>
</template>

<style scoped>
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

.plan {
  padding-top: 8px;
  border-top: 1px solid var(--border-soft);
}

.slider {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr) 52px;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}

.slider__name {
  color: var(--text-dim);
}

.slider__value {
  text-align: right;
  color: var(--accent);
}

.progress {
  padding-top: 8px;
  border-top: 1px solid var(--border-soft);
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

.aim {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 8px;
  background: var(--panel-soft);
  border: 1px solid var(--border-soft);
  border-radius: 7px;
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
  gap: 4px;
  padding-top: 7px;
  border-top: 1px solid var(--border-soft);
}

.exits {
  padding-top: 8px;
  border-top: 1px solid var(--border-soft);
}

.towers {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tower {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  background: var(--panel-soft);
  border: 1px solid var(--border-soft);
  border-radius: 7px;
  font-size: 11.5px;
}

.tower__id {
  width: 30px;
  flex: 0 0 auto;
  color: var(--accent);
}

.tower__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tower__count {
  flex: 0 0 auto;
  color: var(--text-faint);
}

.shots summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--text-faint);
}

.shots__list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 6px;
  max-height: 220px;
  overflow: auto;
}

.shot {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: 11px;
}

.shot__index {
  width: 16px;
  flex: 0 0 auto;
  color: var(--text-faint);
}

.shot__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shot__kinds {
  flex: 0 0 auto;
  white-space: nowrap;
}
</style>
