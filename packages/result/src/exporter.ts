/**
 * ResultExporter(README §32 · §21)。
 *
 * 把结果导出成字符串 —— **不做 IO**。落盘、上传、塞进邮件是调用方的事:
 * 这样同一份导出逻辑在浏览器、Node 服务、MCP 工具里都能原样用,
 * 而且可以在纯单测里断言输出内容。
 */
import type { TaskResultReport } from './report'
import { summarizeTaskResult } from './report'

export type ResultFormat = 'json' | 'markdown' | 'csv'

export function exportTaskResult(report: TaskResultReport, format: ResultFormat = 'json'): string {
  switch (format) {
    case 'markdown':
      return exportTaskResultMarkdown(report)
    case 'csv':
      return exportTaskResultCsv(report)
    case 'json':
      return exportTaskResultJson(report)
  }
}

export function exportTaskResultJson(report: TaskResultReport): string {
  return JSON.stringify(report, null, 2)
}

export function exportTaskResultMarkdown(report: TaskResultReport): string {
  const summary = summarizeTaskResult(report)
  const track = report.trackReference
  const lines: string[] = [
    `## ${report.label}`,
    '',
    `| 项 | 值 |`,
    `| --- | --- |`,
    `| 任务 ID | \`${report.taskId}\` |`,
    `| 类型 | ${report.type} |`,
    `| 状态 | ${report.status} |`,
    `| 时长 | ${summary.durationText} |`,
    `| 结论 | ${report.message} |`,
  ]

  if (track) {
    lines.push(
      `| 飞行距离 | ${track.distanceFlown.toFixed(1)} m |`,
      `| 最高高度 | ${track.maxAltitude.toFixed(1)} m |`,
      `| 最大速度 | ${track.maxSpeed.toFixed(2)} m/s |`,
      `| 轨迹采样 | ${track.points} 点 @ ${track.sampleHz} Hz |`,
    )
  }

  lines.push(
    `| 事件 | ${report.eventReference.total}(告警 ${report.eventReference.byLevel.warn} · 错误 ${report.eventReference.byLevel.error}) |`,
    `| 指令 | ${report.statistics.commands} |`,
    `| 媒体 | ${report.mediaReference.length} 项 |`,
    '',
  )

  const metricKeys = Object.keys(report.metrics).sort()
  if (metricKeys.length > 0) {
    lines.push('### 任务指标', '', '| 指标 | 值 |', '| --- | --- |')
    for (const key of metricKeys) lines.push(`| ${key} | ${report.metrics[key] ?? 0} |`)
    lines.push('')
  }

  return lines.join('\n')
}

/** 一行一条指标 —— 便于粘进表格软件做横向对比 */
export function exportTaskResultCsv(report: TaskResultReport): string {
  const summary = summarizeTaskResult(report)
  const rows: ReadonlyArray<readonly [string, string | number]> = [
    ['taskId', report.taskId],
    ['type', report.type],
    ['label', report.label],
    ['status', report.status],
    ['duration', report.duration.toFixed(2)],
    ['durationText', summary.durationText],
    ['distanceFlown', report.trackReference?.distanceFlown ?? 0],
    ['maxAltitude', report.trackReference?.maxAltitude ?? 0],
    ['maxSpeed', report.trackReference?.maxSpeed ?? 0],
    ['trackPoints', report.statistics.trackPoints],
    ['events', report.statistics.events],
    ['warnings', report.statistics.warnings],
    ['errors', report.statistics.errors],
    ['commands', report.statistics.commands],
    ['media', report.mediaReference.length],
    ['message', report.message],
  ]

  return ['key,value', ...rows.map(([key, value]) => `${key},${csvCell(String(value))}`)].join('\n')
}

/** CSV 里的逗号、引号、换行都要转义,否则导出的表会错列 */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}
