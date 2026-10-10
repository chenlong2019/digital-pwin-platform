/**
 * 巡检报告 —— 把一场巡检变成一份能交付、能对账、能导出的东西(§56 汇总、§61 导出)。
 *
 * 记录本身在 `point/inspection-point-result.ts`;这里只管**汇总与序列化**:
 * 逐塔小结、全局汇总(覆盖率 / 召回 / 精度 / 缺陷清单),以及 JSON / CSV / Markdown。
 * 两者分开,是因为报告只是记录的一种**读法** —— 同一批记录可以算成报告、算成评分、
 * 也可以只拿来画一条曲线。
 *
 * 三个刻意的选择:
 *   ① **summary 不取墙钟**。`generatedAt` 由调用方注入 —— 包内取一次 `new Date()`
 *      就会让「同一次会话跑两遍得到同一份报告」这件事失效(README §75)。
 *   ② **分母为零时 recall / precision 给 null 而不是 1**。「没有真值缺陷」时谈召回率
 *      是没有意义的,给 100% 会让报告看起来比实际漂亮。显示成 `—` 才是诚实的。
 *      这条口径下沉到了 `evaluation-core`(`metricRatio`)—— 因为它是**通则**,
 *      不是电力巡检特有的。
 *   ③ **航线只按「事实面」读**(见 `inspection-route-facts.ts`):报告不需要认识任务。
 */
import { metricAverage, metricRatio } from '@simulation/evaluation-core'
import type { PowerLine, TowerType, DefectSeverity } from '@simulation/power-domain'
import { PART_KIND_LABELS, SEVERITY_LABELS, TOWER_TYPE_LABELS } from '@simulation/power-domain'
import { DETECTOR_VERSION, describeDetection } from '../metric/data-quality-metric'
import type { InspectionOutcome, InspectionRecord } from '../point/inspection-point-result'
import { OUTCOME_LABELS } from '../point/inspection-point-result'
import type { InspectionPointResult } from '../point/point-status'
import { POINT_STATUS_LABELS, derivePointResults, summarizePointStatuses } from '../point/point-status'
import type { InspectionRouteFacts } from './inspection-route-facts'

// ————————————————————————————— 数据来源 —————————————————————————————

/**
 * 数据来源(§10 最后一句:报告必须明确数据来源,不能混淆)。
 *
 * 仿真的截图**不能**被标成真实相机影像(§7.1),人工录入的结论也不能算成算法输出。
 * 所以它不是一句注释,而是报告里的一个字段 —— 导出后仍然在。
 */
export type DataSource = 'simulation' | 'device' | 'manual'

export const DATA_SOURCE_LABELS: Record<DataSource, string> = {
  simulation: '仿真数据',
  device: '真实设备数据',
  manual: '人工录入',
}

// ————————————————————————————— 报告 —————————————————————————————

export interface TowerReport {
  readonly towerId: string
  readonly towerLabel: string
  readonly towerType: TowerType
  readonly towerTypeLabel: string
  readonly partsTotal: number
  readonly partsChecked: number
  readonly coverage: number
  /** 本塔报出的缺陷 + 疑似 */
  readonly alarms: number
  readonly defectsReported: number
  readonly suspects: number
  readonly truthDefects: number
  readonly worstSeverity: DefectSeverity | null
  readonly averageQuality: number | null
  /** 本塔采集时的最大镜头俯仰绝对值(度):用来发现「全在仰着头看」这类机位问题 */
  readonly maxTiltDeg: number
}

export interface InspectionSummary {
  readonly towersTotal: number
  readonly towersInspected: number
  readonly partsTotal: number
  readonly partsChecked: number
  readonly partsUnchecked: number
  /** 覆盖率 = 已采集部位 / 全部部位 */
  readonly coverage: number
  readonly shotsPlanned: number
  readonly shotsTaken: number
  readonly alarms: number
  readonly defectsReported: number
  readonly suspects: number
  readonly truthDefects: number
  readonly truePositive: number
  readonly falsePositive: number
  readonly missed: number
  readonly trueNegative: number
  /** 召回率 = 命中 / (命中 + 漏检);全部部位都没有真值缺陷时为 null */
  readonly recall: number | null
  /** 精度 = 命中 / 报警总数;没有报警时为 null */
  readonly precision: number | null
  readonly averageQuality: number | null
  readonly maxAltitudeM: number
  readonly transitLengthM: number
  readonly captures: number
  /** 检查点四类终态统计(§5.3) */
  readonly pointsPlanned: number
  readonly pointsPassed: number
  readonly pointsWarning: number
  readonly pointsFailed: number
  readonly pointsSkipped: number
}

export interface InspectionReport {
  readonly id: string
  /** 生成时刻 —— 由调用方注入,包内不取墙钟(见文件头 ①) */
  readonly generatedAt: string
  readonly detectorVersion: string
  readonly sessionLabel: string
  readonly scenarioId: string
  readonly lineLabel: string
  readonly voltageKv: number
  readonly routeLabel: string
  readonly taskLabel: string
  /** inProgress = 巡检还在跑,报告反映的是当前进度 */
  readonly status: 'inProgress' | 'completed' | 'aborted' | 'failed'
  readonly message: string
  readonly startedAtS: number
  readonly finishedAtS: number
  readonly durationS: number
  /** 数据来源(§10):仿真 / 真实设备 / 人工录入 */
  readonly dataSource: DataSource
  /** 检查点结果:逐点状态与六条检查(§5.1 / §5.2) */
  readonly points: ReadonlyArray<InspectionPointResult>
  readonly towers: ReadonlyArray<TowerReport>
  readonly records: ReadonlyArray<InspectionRecord>
  readonly summary: InspectionSummary
}

export interface BuildReportInput {
  /** 航线的事实面 —— 直接传 `InspectionRoute` 即可,结构兼容(见 inspection-route-facts.ts) */
  readonly route: InspectionRouteFacts
  readonly records: ReadonlyArray<InspectionRecord>
  readonly status: InspectionReport['status']
  readonly message: string
  readonly sessionLabel: string
  readonly scenarioId: string
  readonly taskLabel: string
  readonly startedAtS: number
  readonly finishedAtS: number
  readonly maxAltitudeM: number
  readonly generatedAt: string
  /** 数据来源,默认 `simulation`(仿真页产出的一定是仿真数据) */
  readonly dataSource?: DataSource
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 组装一份完整报告:逐塔小结 + 全局汇总。纯函数,可对同一批记录重复调用 */
export function buildInspectionReport(input: BuildReportInput): InspectionReport {
  const { route, records } = input
  const line: PowerLine = route.line

  const towers: TowerReport[] = line.towers.map((tower) => {
    const towerRecords = records.filter((record) => record.towerId === tower.id)
    const partsOfTower = route.parts.filter((part) => part.towerId === tower.id)
    const checked = towerRecords.filter((record) => record.outcome !== 'unchecked')
    const alarms = towerRecords.filter(
      (record) => record.detection.verdict === 'suspect' || record.detection.verdict === 'defect',
    )
    const defectSeverities = towerRecords
      .filter((record) => record.detection.verdict === 'defect')
      .map((record) => record.detection.severity)
    const defectRecords = towerRecords.filter((record) => record.detection.verdict === 'defect')
    const suspectRecords = towerRecords.filter((record) => record.detection.verdict === 'suspect')

    return {
      towerId: tower.id,
      towerLabel: tower.label,
      towerType: tower.type,
      towerTypeLabel: TOWER_TYPE_LABELS[tower.type],
      partsTotal: partsOfTower.length,
      partsChecked: checked.length,
      coverage: metricRatio(checked.length, partsOfTower.length) ?? 0,
      alarms: alarms.length,
      defectsReported: defectRecords.length,
      suspects: suspectRecords.length,
      truthDefects: tower.defects.length,
      worstSeverity: defectSeverities.includes('major')
        ? 'major'
        : defectSeverities.length > 0
          ? 'minor'
          : null,
      averageQuality: metricAverage(checked.map((record) => record.detection.quality.quality)),
      maxTiltDeg: round(
        checked.reduce((worst, record) => Math.max(worst, Math.abs(record.observation?.tiltDeg ?? 0)), 0),
        1,
      ),
    }
  })

  const checkedRecords = records.filter((record) => record.outcome !== 'unchecked')
  const truePositive = checkedRecords.filter((record) => record.outcome === 'truePositive').length
  const falsePositive = checkedRecords.filter((record) => record.outcome === 'falsePositive').length
  const missed = checkedRecords.filter((record) => record.outcome === 'missed').length
  const trueNegative = checkedRecords.filter((record) => record.outcome === 'trueNegative').length

  // 检查点结果:作业口径(§5.2)。它和对账口径(outcome)是两件事,并排放、不互顶
  const points = derivePointResults(route, records)
  const pointCounts = summarizePointStatuses(points)

  const summary: InspectionSummary = {
    towersTotal: line.towers.length,
    towersInspected: towers.filter((tower) => tower.partsChecked > 0).length,
    partsTotal: route.parts.length,
    partsChecked: checkedRecords.length,
    partsUnchecked: records.length - checkedRecords.length,
    coverage: metricRatio(checkedRecords.length, route.parts.length) ?? 0,
    shotsPlanned: route.shots.length,
    shotsTaken: new Set(records.filter((record) => record.outcome !== 'unchecked').map((record) => record.shotId)).size,
    alarms: checkedRecords.filter((record) => record.detection.verdict === 'suspect' || record.detection.verdict === 'defect')
      .length,
    defectsReported: checkedRecords.filter((record) => record.detection.verdict === 'defect').length,
    suspects: checkedRecords.filter((record) => record.detection.verdict === 'suspect').length,
    truthDefects: line.towers.reduce((total, tower) => total + tower.defects.length, 0),
    truePositive,
    falsePositive,
    missed,
    trueNegative,
    recall: metricRatio(truePositive, truePositive + missed),
    precision: metricRatio(truePositive, truePositive + falsePositive),
    averageQuality: metricAverage(checkedRecords.map((record) => record.detection.quality.quality)),
    maxAltitudeM: round(input.maxAltitudeM, 1),
    transitLengthM: route.transitLengthM,
    captures: checkedRecords.length,
    pointsPlanned: pointCounts.planned,
    pointsPassed: pointCounts.passed,
    pointsWarning: pointCounts.warning,
    pointsFailed: pointCounts.failed,
    pointsSkipped: pointCounts.skipped,
  }

  return {
    id: `${route.id}-report`,
    generatedAt: input.generatedAt,
    detectorVersion: DETECTOR_VERSION,
    sessionLabel: input.sessionLabel,
    scenarioId: input.scenarioId,
    lineLabel: line.label,
    voltageKv: line.voltageKv,
    routeLabel: route.label,
    taskLabel: input.taskLabel,
    status: input.status,
    message: input.message,
    startedAtS: round(input.startedAtS, 1),
    finishedAtS: round(input.finishedAtS, 1),
    durationS: round(Math.max(0, input.finishedAtS - input.startedAtS), 1),
    dataSource: input.dataSource ?? 'simulation',
    points,
    towers,
    records,
    summary,
  }
}

/** 报告里的报警清单(缺陷 + 疑似),按严重度再按塔号排 */
export function alarmRecords(report: InspectionReport): InspectionRecord[] {
  return report.records
    .filter((record) => record.detection.verdict === 'defect' || record.detection.verdict === 'suspect')
    .slice()
    .sort((a, b) => {
      const rank = (record: InspectionRecord): number => (record.detection.verdict === 'defect' ? 0 : 1)
      return rank(a) - rank(b) || a.partId.localeCompare(b.partId)
    })
}

/**
 * 由航线与报告反推「任务该记录但没记录到的部位」。
 * 任务失败/中止时,报告要显示「还剩哪些没拍」,而不是只报已完成的。
 */
export function missingParts(
  route: InspectionRouteFacts,
  records: ReadonlyArray<InspectionRecord>,
): string[] {
  const seen = new Set(records.filter((record) => record.outcome !== 'unchecked').map((record) => record.partId))
  return route.parts.filter((part) => !seen.has(part.id)).map((part) => part.id)
}

// ————————————————————————————— 序列化 —————————————————————————————

const OUTCOME_ORDER: ReadonlyArray<InspectionOutcome> = [
  'truePositive',
  'falsePositive',
  'missed',
  'trueNegative',
  'unchecked',
]

export function reportToJson(report: InspectionReport): string {
  return JSON.stringify(report, null, 2)
}

/** CSV 单元格:含逗号/引号/换行就加引号,引号翻倍 */
function csvCell(value: string | number | null): string {
  if (value === null) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * 明细 CSV:一行一个部位。
 * 带 UTF-8 BOM —— 不带的话 Excel 打开中文列头会乱码,这份文件的第一个消费者就是人。
 */
export function reportToCsv(report: InspectionReport): string {
  const header = [
    '塔号',
    '塔型',
    '部位',
    '部位类型',
    '仿真时刻(s)',
    '结论',
    '缺陷类型',
    '严重度',
    '置信度',
    '成像质量',
    '特征像素',
    '距离(m)',
    '偏心(°)',
    '俯仰(°)',
    '机身偏差(°)',
    '对账结果',
    '地面真值',
    '备注',
  ]
  const rows = report.records.map((record) => {
    const observation = record.observation
    return [
      record.towerId,
      TOWER_TYPE_LABELS[findTowerType(report, record.towerId)],
      record.partLabel,
      PART_KIND_LABELS[record.partKind],
      record.simulationTime.toFixed(1),
      verdictText(record),
      record.detection.kind ?? '',
      record.detection.severity ? SEVERITY_LABELS[record.detection.severity] : '',
      record.detection.verdict === 'unchecked' ? '' : record.detection.confidence.toFixed(2),
      record.detection.verdict === 'unchecked' ? '' : record.detection.quality.quality.toFixed(3),
      record.detection.verdict === 'unchecked' ? '' : record.detection.quality.featurePixels,
      observation ? observation.rangeM.toFixed(1) : '',
      observation ? observation.offAxisDeg.toFixed(1) : '',
      observation ? observation.tiltDeg.toFixed(1) : '',
      observation ? observation.headingErrorDeg.toFixed(1) : '',
      OUTCOME_LABELS[record.outcome],
      record.truth ? `${SEVERITY_LABELS[record.truth.severity]}·${record.truth.kind}` : '无',
      record.detection.note,
    ]
  })
  return `\ufeff${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

/**
 * 检查点 CSV:一行一个检查点。
 * 与明细 CSV 分开 —— 一份回答「每个部位拍成什么样」,一份回答「每个检查点算不算成立」。
 */
export function reportPointsToCsv(report: InspectionReport): string {
  const header = ['检查点', '杆塔', '标号', '启用', '状态', '通过条件', '未通过检查', '未通过原因', '证据数']
  const rows = report.points.map((point) => {
    const failed = point.checks.filter((check) => !check.ok)
    return [
      point.pointId,
      point.towerId,
      point.label,
      point.enabled ? '是' : '否',
      POINT_STATUS_LABELS[point.status],
      `${point.checks.filter((check) => check.ok).length}/${point.checks.length}`,
      failed.map((check) => check.label).join(' '),
      point.problems.join('；'),
      point.captureIds.length,
    ]
  })
  return `\ufeff${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

function findTowerType(report: InspectionReport, towerId: string): TowerType {
  return report.towers.find((tower) => tower.towerId === towerId)?.towerType ?? 'suspension'
}

function verdictText(record: InspectionRecord): string {
  return record.detection.verdict === 'unchecked' ? '未采集' : describeDetection(record.detection)
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`
}

/** Markdown 巡检报告:给「贴到工单里」用的版本 */
export function reportToMarkdown(report: InspectionReport): string {
  const summary = report.summary
  const lines: string[] = []
  lines.push(`# 无人机巡检报告 · ${report.lineLabel}`)
  lines.push('')
  lines.push(`- 会话:${report.sessionLabel}(${report.scenarioId})`)
  lines.push(`- 任务:${report.taskLabel}`)
  lines.push(`- 航线:${report.routeLabel}`)
  lines.push(`- 巡检状态:${report.status} —— ${report.message}`)
  lines.push(`- 数据来源:${DATA_SOURCE_LABELS[report.dataSource]}(报告中的数值仅代表该来源)`)
  lines.push(`- 仿真时长:${report.durationS} s(生成于 ${report.generatedAt})`)
  lines.push(`- 判定算法:${report.detectorVersion}`)
  lines.push('')
  lines.push('## 汇总')
  lines.push('')
  lines.push('| 指标 | 数值 |')
  lines.push('| --- | --- |')
  lines.push(`| 杆塔 | ${summary.towersInspected} / ${summary.towersTotal} 已检 |`)
  lines.push(`| 部位覆盖 | ${summary.partsChecked} / ${summary.partsTotal}(${percent(summary.coverage)}) |`)
  lines.push(`| 拍点 | ${summary.shotsTaken} / ${summary.shotsPlanned} |`)
  lines.push(
    `| 检查点 通过 / 警告 / 失败 / 跳过 | ${summary.pointsPassed} / ${summary.pointsWarning} / ${summary.pointsFailed} / ${summary.pointsSkipped} |`,
  )
  lines.push(`| 报出缺陷 | ${summary.defectsReported} |`)
  lines.push(`| 疑似待复核 | ${summary.suspects} |`)
  lines.push(`| 真实缺陷 | ${summary.truthDefects} |`)
  lines.push(`| 命中 / 漏检 / 误报 | ${summary.truePositive} / ${summary.missed} / ${summary.falsePositive} |`)
  lines.push(`| 召回率 / 精度 | ${percent(summary.recall)} / ${percent(summary.precision)} |`)
  lines.push(`| 平均成像质量 | ${summary.averageQuality === null ? '—' : summary.averageQuality.toFixed(3)} |`)
  lines.push(`| 转场里程 / 最大高度 | ${summary.transitLengthM} m / ${summary.maxAltitudeM} m |`)
  lines.push('')
  lines.push('## 检查点结果')
  lines.push('')
  if (report.points.length === 0) {
    lines.push('本航线没有检查点。')
  } else {
    lines.push('| 检查点 | 标号 | 状态 | 未通过原因 |')
    lines.push('| --- | --- | --- | --- |')
    for (const point of report.points) {
      lines.push(
        `| ${point.pointId} | ${point.label} | ${POINT_STATUS_LABELS[point.status]} | ${point.problems.join(';') || '—'} |`,
      )
    }
  }
  lines.push('')
  lines.push('## 缺陷清单')
  lines.push('')
  const alarms = alarmRecords(report)
  if (alarms.length === 0) {
    lines.push('未发现缺陷或疑似缺陷。')
  } else {
    lines.push('| 塔号 | 部位 | 结论 | 置信度 | 备注 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const record of alarms) {
      lines.push(
        `| ${record.towerId} | ${record.partLabel} | ${verdictText(record)} | ${record.detection.confidence.toFixed(2)} | ${record.detection.note} |`,
      )
    }
  }
  lines.push('')
  lines.push('## 逐塔小结')
  lines.push('')
  lines.push('| 塔号 | 塔型 | 覆盖 | 缺陷 | 疑似 | 真实缺陷 | 平均成像质量 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const tower of report.towers) {
    lines.push(
      `| ${tower.towerId} | ${tower.towerTypeLabel} | ${tower.partsChecked} / ${tower.partsTotal} | ${tower.defectsReported} | ${tower.suspects} | ${tower.truthDefects} | ${tower.averageQuality === null ? '—' : tower.averageQuality.toFixed(3)} |`,
    )
  }
  lines.push('')
  lines.push('> 「真实缺陷」一列是仿真世界的地面真值,仅用于对账召回/精度,不属于巡检结论。')
  return `${lines.join('\n')}\n`
}

/** 汇总里各对账项的展示顺序(界面与导出共用) */
export function outcomeBreakdown(report: InspectionReport): Array<{ outcome: InspectionOutcome; count: number }> {
  return OUTCOME_ORDER.map((outcome) => ({
    outcome,
    count: report.records.filter((record) => record.outcome === outcome).length,
  }))
}
