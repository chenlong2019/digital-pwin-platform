<script setup lang="ts">
/**
 * ReportPanel —— 巡检报告面板:汇总、对账、缺陷清单、导出。
 *
 * 这份面板有一条**必须守住的界线**:巡检结论与地面真值分开显示。
 *   · 结论区(汇总 / 缺陷清单 / 逐塔小结)—— 真实系统里能拿到的东西
 *   · 对账区(命中 / 漏检 / 误报 / 召回 / 精度)—— 只有仿真里才有真值可比,
 *     所以它单独成块并明确标注「仅用于对账」,避免让人以为现场也能这么统计
 *
 * 导出走 `buildReportNow()` 而不是面板里算好的那份:导出的是**此刻**的报告,
 * 时间戳是现取的;面板里那份为了不每 tick 跳字,时间只在任务起止时更新。
 */
import { computed } from 'vue'
import type { InspectionReport } from '@simulation/grid-inspection'
import {
  OUTCOME_LABELS,
  alarmRecords,
  missingParts,
  outcomeBreakdown,
  reportToCsv,
  reportToJson,
  reportToMarkdown,
} from '@simulation/grid-inspection'
import { useGridSession } from '../simulation/injection'
import { downloadBlob, timestampTag } from '../utils/download'
import { formatClock, formatMeters, formatNumber } from '../utils/format'

const session = useGridSession()
const { line, route, report, records, buildReportNow } = session

const REPORT_STATUS_LABELS: Record<InspectionReport['status'], string> = {
  inProgress: '巡检中(进度截面)',
  completed: '已完成',
  aborted: '已中止',
  failed: '失败',
}

const statusTone = computed(() => {
  switch (report.value?.status) {
    case 'completed':
      return 'tag--ok'
    case 'inProgress':
      return 'tag--info'
    case 'aborted':
    case 'failed':
      return 'tag--danger'
    default:
      return ''
  }
})

const alarms = computed(() => (report.value ? alarmRecords(report.value) : []))

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)} %`
}

/** 未采集的部位 —— 中止/失败时要说清「还剩哪些没拍」,而不是只报已完成的 */
const missing = computed(() => missingParts(route.value, records.value))

const outcomeRows = computed(() => (report.value ? outcomeBreakdown(report.value) : []))

/** 文件名里不能出现空格与间隔号,统一压成下划线 */
function slug(text: string): string {
  return text.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').replace(/^_+|_+$/g, '')
}

function exportReport(kind: 'json' | 'csv' | 'markdown'): void {
  const fresh = buildReportNow()
  if (!fresh) return
  const base = `巡检报告_${slug(line.label)}_${timestampTag()}`
  if (kind === 'json') {
    downloadBlob(new Blob([reportToJson(fresh)], { type: 'application/json' }), `${base}.json`)
    return
  }
  if (kind === 'csv') {
    // 带 BOM 的 CSV:这份文件的第一个消费者是 Excel
    downloadBlob(new Blob([reportToCsv(fresh)], { type: 'text/csv;charset=utf-8' }), `${base}.csv`)
    return
  }
  downloadBlob(new Blob([reportToMarkdown(fresh)], { type: 'text/markdown;charset=utf-8' }), `${base}.md`)
}
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <span class="panel__title">巡检报告</span>
      <span class="tag" :class="statusTone" data-testid="report-status">
        {{ report ? REPORT_STATUS_LABELS[report.status] : '未生成' }}
      </span>
    </header>

    <div class="panel__body">
      <p v-if="!report" class="hint">
        还没有报告。在「巡检作业」里创建并启动一次巡检,这里会随着采集逐条长出来
        —— 巡检没跑完也能看,拿到的是当前进度的截面,状态会标成「巡检中」而不是假装已完成。
      </p>

      <template v-else>
        <div class="row row--between hint">
          <span>{{ report.routeLabel }}</span>
          <span class="mono">{{ report.detectorVersion }}</span>
        </div>

        <!-- 结论汇总 -->
        <div class="stack">
          <span class="field-label">汇总</span>
          <dl class="metrics">
            <div class="metrics__row">
              <dt>杆塔</dt>
              <dd class="mono">{{ report.summary.towersInspected }} / {{ report.summary.towersTotal }}</dd>
            </div>
            <div class="metrics__row">
              <dt>部位覆盖</dt>
              <dd class="mono">
                {{ report.summary.partsChecked }} / {{ report.summary.partsTotal }}
                ({{ percent(report.summary.coverage) }})
              </dd>
            </div>
            <div class="metrics__row">
              <dt>拍点</dt>
              <dd class="mono">{{ report.summary.shotsTaken }} / {{ report.summary.shotsPlanned }}</dd>
            </div>
            <div class="metrics__row">
              <dt>报出缺陷</dt>
              <dd class="mono">{{ report.summary.defectsReported }}</dd>
            </div>
            <div class="metrics__row">
              <dt>疑似待复核</dt>
              <dd class="mono">{{ report.summary.suspects }}</dd>
            </div>
            <div class="metrics__row">
              <dt>平均成像质量</dt>
              <dd class="mono">
                {{ report.summary.averageQuality === null ? '—' : report.summary.averageQuality.toFixed(3) }}
              </dd>
            </div>
            <div class="metrics__row">
              <dt>转场里程 / 最大高度</dt>
              <dd class="mono">
                {{ formatMeters(report.summary.transitLengthM, 0) }} / {{ formatMeters(report.summary.maxAltitudeM, 0) }}
              </dd>
            </div>
            <div class="metrics__row">
              <dt>巡检时长</dt>
              <dd class="mono">{{ formatClock(report.durationS) }}</dd>
            </div>
          </dl>
          <div class="hint">{{ report.message }}</div>
        </div>

        <!-- 对账:只有仿真里才有真值可比 -->
        <div class="stack reconcile">
          <div class="row row--between">
            <span class="field-label">与地面真值对账</span>
            <span class="tag tag--warn">仅用于对账</span>
          </div>
          <dl class="metrics">
            <div class="metrics__row">
              <dt>真实缺陷</dt>
              <dd class="mono">{{ report.summary.truthDefects }}</dd>
            </div>
            <div class="metrics__row">
              <dt>召回率</dt>
              <dd class="mono">{{ percent(report.summary.recall) }}</dd>
            </div>
            <div class="metrics__row">
              <dt>精度</dt>
              <dd class="mono">{{ percent(report.summary.precision) }}</dd>
            </div>
          </dl>
          <div class="outcomes">
            <span v-for="row in outcomeRows" :key="row.outcome" class="outcome">
              <span class="outcome__label">{{ OUTCOME_LABELS[row.outcome] }}</span>
              <span class="mono outcome__count">{{ row.count }}</span>
            </span>
          </div>
          <p class="hint">
            真值是仿真世界写在杆塔资产上的事实,现场拿不到 —— 所以这一块单独放着,不混进上面的巡检结论。
            分母为零时召回/精度显示「—」,不假装 100%。
          </p>
        </div>

        <!-- 缺陷清单 -->
        <div class="stack">
          <div class="row row--between">
            <span class="field-label">缺陷清单</span>
            <span class="hint">{{ alarms.length }} 条</span>
          </div>
          <p v-if="alarms.length === 0" class="hint">未报出缺陷或疑似缺陷。</p>
          <div v-else class="alarms">
            <div v-for="record in alarms" :key="record.partId" class="alarm">
              <div class="row row--between">
                <span>
                  <span class="mono">{{ record.towerId }}</span>
                  · {{ record.partLabel }}
                </span>
                <span class="tag" :class="record.detection.verdict === 'defect' ? 'tag--danger' : 'tag--warn'">
                  {{ record.detection.verdict === 'defect' ? '缺陷' : '疑似' }}
                </span>
              </div>
              <div class="alarm__note">{{ record.detection.note }}</div>
              <div class="row row--between hint">
                <span class="mono">置信度 {{ record.detection.confidence.toFixed(2) }}</span>
                <span class="mono alarm__truth">
                  真值:{{ record.truth ? record.truth.kind : '无' }}({{ OUTCOME_LABELS[record.outcome] }})
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 未采集部位 -->
        <details v-if="missing.length > 0" class="missing">
          <summary>未采集部位({{ missing.length }})</summary>
          <div class="missing__list mono">
            <span v-for="id in missing" :key="id">{{ id }}</span>
          </div>
        </details>

        <!-- 逐塔小结 -->
        <div class="stack">
          <span class="field-label">逐塔小结</span>
          <table class="table">
            <thead>
              <tr>
                <th>塔号</th>
                <th>覆盖</th>
                <th>缺陷</th>
                <th>疑似</th>
                <th>成像质量</th>
                <th>最大俯仰</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="tower in report.towers" :key="tower.towerId">
                <td class="mono">{{ tower.towerId }}</td>
                <td class="mono">{{ tower.partsChecked }}/{{ tower.partsTotal }}</td>
                <td class="mono">{{ tower.defectsReported }}</td>
                <td class="mono">{{ tower.suspects }}</td>
                <td class="mono">
                  {{ tower.averageQuality === null ? '—' : tower.averageQuality.toFixed(2) }}
                </td>
                <td class="mono">{{ formatNumber(tower.maxTiltDeg, 1) }}°</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 导出 -->
        <div class="stack export">
          <span class="field-label">导出</span>
          <div class="grid grid--3">
            <button data-testid="export-json" @click="exportReport('json')">JSON</button>
            <button data-testid="export-csv" @click="exportReport('csv')">CSV</button>
            <button class="primary" data-testid="export-markdown" @click="exportReport('markdown')">Markdown</button>
          </div>
          <p class="hint">
            导出的是**此刻**的报告(重新取时间戳)。CSV 带 UTF-8 BOM,Excel 打开中文列头不乱码;
            Markdown 那份是「贴进工单」用的。
          </p>
        </div>
      </template>
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
  text-align: right;
}

.reconcile {
  padding: 8px;
  background: rgba(255, 196, 107, 0.06);
  border: 1px solid rgba(255, 196, 107, 0.28);
  border-radius: 8px;
}

.outcomes {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.outcome {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 2px 7px;
  font-size: 10.5px;
  background: var(--panel-soft);
  border: 1px solid var(--border-soft);
  border-radius: 999px;
}

.outcome__label {
  color: var(--text-faint);
}

.outcome__count {
  color: var(--text);
}

.alarms {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.alarm {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px;
  background: var(--panel-soft);
  border: 1px solid var(--border-soft);
  border-radius: 7px;
  font-size: 11.5px;
}

.alarm__note {
  color: var(--text-dim);
  font-size: 11px;
}

.alarm__truth {
  color: var(--warn);
}

.missing summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--text-faint);
}

.missing__list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--text-faint);
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.table th {
  padding: 3px 4px;
  text-align: left;
  font-weight: 500;
  color: var(--text-faint);
  border-bottom: 1px solid var(--border-soft);
}

.table td {
  padding: 3px 4px;
  border-bottom: 1px dashed var(--border-soft);
}

.export {
  padding-top: 8px;
  border-top: 1px solid var(--border-soft);
}

.grid {
  display: grid;
  gap: 6px;
}

.grid--3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.grid button {
  width: 100%;
}
</style>
