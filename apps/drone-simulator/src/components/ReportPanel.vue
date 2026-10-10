<script setup lang="ts">
/**
 * ReportPanel —— 巡检报告面板:汇总、对账、缺陷清单、作业评价、导出。
 *
 * 这份面板有一条**必须守住的界线**:巡检结论与地面真值分开显示。
 *   · 结论区(汇总 / 缺陷清单 / 逐塔小结)—— 真实系统里能拿到的东西
 *   · 对账区(命中 / 漏检 / 误报 / 召回 / 精度)—— 只有仿真里才有真值可比,
 *     所以它单独成块并明确标注「仅用于对账」,避免让人以为现场也能这么统计
 *
 * 导出走 `buildReportNow()` 而不是面板里算好的那份:导出的是**此刻**的报告,
 * 时间戳是现取的;面板里那份为了不每 tick 跳字,时间只在任务起止时更新。
 *
 * 「作业评价」那块是**纯函数算出来的**(`evaluateInspection`):指标口径与评分规则
 * 都不在这里 —— 面板只负责把结果摆出来,所以换一套验收口径不用动这一页。
 */
import { computed } from 'vue'
import type { InspectionReport, PointStatus } from '@simulation/power-evaluation'
import {
  DATA_SOURCE_LABELS,
  OUTCOME_LABELS,
  POINT_STATUS_LABELS,
  alarmRecords,
  evaluateInspection,
  missingParts,
  outcomeBreakdown,
  reportPointsToCsv,
  reportToCsv,
  reportToJson,
  reportToMarkdown,
} from '@simulation/power-evaluation'
import type { Metric, ViolationSeverity } from '@simulation/evaluation-core'
import {
  EVALUATION_STATUS_LABELS,
  SCORE_GRADE_LABELS,
  VIOLATION_SEVERITY_LABELS,
  formatMetricValue,
  meetsTarget,
} from '@simulation/evaluation-core'
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

/** 检查点结果(§5.2 作业口径)—— 与「对账」是两块,绝不混 */
const points = computed(() => report.value?.points ?? [])

const pointCounts = computed(() => ({
  passed: points.value.filter((point) => point.status === 'passed').length,
  warning: points.value.filter((point) => point.status === 'warning').length,
  failed: points.value.filter((point) => point.status === 'failed').length,
  skipped: points.value.filter((point) => point.status === 'skipped').length,
}))

function pointTone(status: PointStatus): string {
  switch (status) {
    case 'passed':
      return 'tag--ok'
    case 'warning':
      return 'tag--warn'
    case 'failed':
      return 'tag--danger'
    case 'skipped':
      return 'tag--info'
    default:
      return ''
  }
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)} %`
}

/** 未采集的部位 —— 中止/失败时要说清「还剩哪些没拍」,而不是只报已完成的 */
const missing = computed(() => missingParts(route.value, records.value))

const outcomeRows = computed(() => (report.value ? outcomeBreakdown(report.value) : []))

/**
 * 作业评价 —— 纯函数,拿面板这份报告直接算。
 * 规则与口径都不在这里:指标在 `score/mission-score.ts`,违规在 `mission/inspection-evaluator.ts`。
 */
const evaluation = computed(() => (report.value ? evaluateInspection({ report: report.value }) : null))

const evaluationTone = computed(() => {
  switch (evaluation.value?.status) {
    case 'passed':
      return 'tag--ok'
    case 'warning':
      return 'tag--warn'
    case 'failed':
      return 'tag--danger'
    default:
      return ''
  }
})

const SEVERITY_TONES: Record<ViolationSeverity, string> = {
  critical: 'tag--danger',
  major: 'tag--danger',
  minor: 'tag--warn',
  info: '',
}

function severityTone(severity: ViolationSeverity): string {
  return SEVERITY_TONES[severity]
}

/** 评分显示成整数分:0.873 → 87 分。缺指标给「—」,不给 0 */
function scoreText(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)} 分`
}

/** 指标达标与否 —— 三态,缺值或没设目标都显示「—」 */
function targetState(metric: Metric): string {
  const met = meetsTarget(metric)
  return met === null ? '—' : met ? '达标' : '未达标'
}

function metricTone(metric: Metric): string {
  const met = meetsTarget(metric)
  return met === null ? '' : met ? 'tag--ok' : 'tag--warn'
}

/** 文件名里不能出现空格与间隔号,统一压成下划线 */
function slug(text: string): string {
  return text.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').replace(/^_+|_+$/g, '')
}

function exportReport(kind: 'json' | 'csv' | 'points' | 'markdown'): void {
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
  if (kind === 'points') {
    // 检查点清单单独一份:一行一个检查点,直接回答「哪个点没成立、为什么」
    downloadBlob(
      new Blob([reportPointsToCsv(fresh)], { type: 'text/csv;charset=utf-8' }),
      `巡检检查点_${slug(line.label)}_${timestampTag()}.csv`,
    )
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

        <div class="row row--between hint">
          <span>数据来源</span>
          <span class="tag tag--info" data-testid="data-source">{{ DATA_SOURCE_LABELS[report.dataSource] }}</span>
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
              <dt>检查点 通过/警告/失败/跳过</dt>
              <dd class="mono" data-testid="point-counts">
                {{ report.summary.pointsPassed }} / {{ report.summary.pointsWarning }} /
                {{ report.summary.pointsFailed }} / {{ report.summary.pointsSkipped }}
              </dd>
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

        <!-- 检查点结果:作业口径(§5.2)—— 只看「这次采集成不成立」,不掺地面真值 -->
        <div class="stack">
          <div class="row row--between">
            <span class="field-label">检查点结果</span>
            <span class="hint mono" data-testid="point-counts-badge">
              通过 {{ pointCounts.passed }} · 警告 {{ pointCounts.warning }} · 失败 {{ pointCounts.failed }} ·
              跳过 {{ pointCounts.skipped }}
            </span>
          </div>
          <p v-if="points.length === 0" class="hint">这条航线还没有检查点结果。</p>
          <div v-else class="points">
            <div v-for="point in points" :key="point.pointId" class="point" :data-testid="`point-${point.pointId}`">
              <div class="row row--between">
                <span class="mono point__id">{{ point.pointId }}</span>
                <span class="tag" :class="pointTone(point.status)" :data-testid="`point-status-${point.pointId}`">
                  {{ POINT_STATUS_LABELS[point.status] }}
                </span>
              </div>
              <div class="point__label hint">{{ point.label }}</div>
              <div v-if="point.problems.length > 0" class="point__problems">
                <span v-for="(problem, index) in point.problems" :key="index" class="point__problem">
                  {{ problem }}
                </span>
              </div>
            </div>
          </div>
          <p class="hint">
            这是<strong>作业口径</strong>:只看采集本身成不成立(到达 / 距离 / 航向 / 云台 / 数量 / 关联),
            真实系统里也拿得到。它与下面的「对账」不是一回事 —— 对账要地面真值,现场没有。
          </p>
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

        <!-- 作业评价:指标 + 评分 + 违规清单(口径来自 evaluation-core,规则来自 power-evaluation) -->
        <div v-if="evaluation" class="stack evaluation">
          <div class="row row--between">
            <span class="field-label">作业评价</span>
            <span class="tag" :class="evaluationTone" data-testid="evaluation-status">
              {{ EVALUATION_STATUS_LABELS[evaluation.status] }}
            </span>
          </div>
          <dl class="metrics">
            <div class="metrics__row">
              <dt>作业评分</dt>
              <dd class="mono">
                {{ scoreText(evaluation.score.value) }}
                <span class="hint">{{ SCORE_GRADE_LABELS[evaluation.score.grade] }}</span>
              </dd>
            </div>
            <div v-for="metric in evaluation.metrics" :key="metric.key" class="metrics__row">
              <dt>{{ metric.label }}</dt>
              <dd class="mono">
                {{ formatMetricValue(metric) }}
                <span v-if="metric.target !== null" class="hint">
                  / 目标 {{ formatMetricValue({ ...metric, value: metric.target }) }}
                </span>
                <span class="tag" :class="metricTone(metric)">{{ targetState(metric) }}</span>
              </dd>
            </div>
          </dl>
          <p v-if="evaluation.violations.length === 0" class="hint">
            没有不合规项。评分与违规都按当前这套口径算 —— 巡检没跑完时状态是「未完成」,而不是「不通过」。
          </p>
          <div v-else class="alarms">
            <div
              v-for="(violation, index) in evaluation.violations"
              :key="`${violation.rule}-${index}`"
              class="alarm"
            >
              <div class="row row--between">
                <span class="mono">{{ violation.rule }}</span>
                <span class="tag" :class="severityTone(violation.severity)">
                  {{ VIOLATION_SEVERITY_LABELS[violation.severity] }}
                </span>
              </div>
              <div class="alarm__note">{{ violation.message }}</div>
            </div>
          </div>
          <p class="hint">
            缺数据的指标（例如没有真值缺陷时的召回率）不参与评分,权重会重算 ——
            「不知道」不会被当成 0 分,也不会被当成满分。
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
          <button data-testid="export-points-csv" @click="exportReport('points')">检查点清单 CSV</button>
          <p class="hint">
            导出的是<strong>此刻</strong>的报告(重新取时间戳)。CSV 带 UTF-8 BOM,Excel 打开中文列头不乱码;
            Markdown 那份是「贴进工单」用的;检查点清单 CSV 一行一个检查点,直接回答「哪个点没成立、为什么」。
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

.evaluation {
  padding: 8px;
  background: var(--panel-soft);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
}

/* 评价块里的指标一行一条:右侧要同时放「值 / 目标 / 达标与否」,两列会挤到换行 */
.evaluation .metrics {
  grid-template-columns: 1fr;
}

.evaluation dt {
  white-space: nowrap;
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

.points {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 260px;
  overflow: auto;
}

.point {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  background: var(--panel-soft);
  border: 1px solid var(--border-soft);
  border-radius: 7px;
  font-size: 11.5px;
}

.point__id {
  color: var(--accent);
}

.point__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.point__problems {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.point__problem {
  color: #ffc46b;
}
</style>
