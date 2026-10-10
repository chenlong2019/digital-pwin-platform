/**
 * 通用评价契约的护栏(`evaluation-core`)。
 *
 * 这个包是「词」,不是「业务」:指标怎么算缺失、分怎么归一化、违规怎么排序、
 * 状态怎么判 —— 全平台共用一套。所以这里钉的不是某个行业的结论,而是**口径本身**:
 *
 *   ① 缺数据必须与「0」分开:分母为零给 null、空集给 null、缺值不参与评分
 *   ② 评分以达标线为满分线:刚好达标 = 1 分,超标不超 1
 *   ③ 权重按「参与项」重算:没有数据的指标不会把总分拉成 0
 *   ④ 违规四档固定、排序稳定;只有 major/critical 阻断
 *   ⑤ 状态四态:「没跑完」与「跑得差」是两件事
 *
 * 这五条一旦破了,业务侧的报告会立刻变得「好看但不可信」—— 所以它们值得单测。
 */
import { describe, expect, it } from 'vitest'
import {
  SCORE_GRADE_THRESHOLDS,
  countBySeverity,
  createMetric,
  createViolation,
  deriveEvaluationStatus,
  formatMetricValue,
  gradeScore,
  hasBlockingViolation,
  meetsTarget,
  metricAverage,
  metricCount,
  metricRatio,
  normalizeMetric,
  scoreMetrics,
  sortBySeverity,
  worstSeverity,
} from '@simulation/evaluation-core'

describe('指标口径', () => {
  it('分母为零给 null 而不是 1 —— 「没有可评对象」不等于「全合格」', () => {
    expect(metricRatio(0, 0)).toBeNull()
    expect(metricRatio(3, 0)).toBeNull()
    expect(metricRatio(3, 4)).toBe(0.75)
    expect(metricAverage([])).toBeNull()
    expect(metricAverage([1, 2])).toBe(1.5)
    // 计数永远有值:0 就是 0
    expect(metricCount('alarms', '报警', 3).value).toBe(3)
  })

  it('达标判断是三态:缺值或没设目标都返回 null,不假装合格', () => {
    expect(meetsTarget(createMetric({ key: 'coverage', label: '覆盖', value: null, target: 0.9 }))).toBeNull()
    expect(meetsTarget(createMetric({ key: 'shots', label: '拍点', value: 3 }))).toBeNull()
    expect(meetsTarget(createMetric({ key: 'coverage', label: '覆盖', value: 0.9, target: 0.9 }))).toBe(true)
    expect(meetsTarget(createMetric({ key: 'coverage', label: '覆盖', value: 0.89, target: 0.9 }))).toBe(false)
    // 越小越好的指标:值低才算达标
    const lower = createMetric({ key: 'intrusion', label: '越界', value: 0.02, direction: 'lower', target: 0.05 })
    expect(meetsTarget(lower)).toBe(true)
  })

  it('显示口径统一:比值给百分数、计数给整数、缺失给「—」', () => {
    expect(formatMetricValue(createMetric({ key: 'coverage', label: '覆盖', value: 0.875 }))).toBe('87.5 %')
    expect(formatMetricValue(createMetric({ key: 'coverage', label: '覆盖', value: null }))).toBe('—')
    expect(formatMetricValue(createMetric({ key: 'shots', label: '拍点', value: 12.6, unit: 'count' }))).toBe('13')
  })
})

describe('评分', () => {
  it('以达标线为满分线归一化:刚好达标得 1 分,超标也不超过 1', () => {
    expect(normalizeMetric(createMetric({ key: 'a', label: 'a', value: 0.9, target: 0.9 }))).toBe(1)
    expect(normalizeMetric(createMetric({ key: 'a', label: 'a', value: 1, target: 0.9 }))).toBe(1)
    expect(normalizeMetric(createMetric({ key: 'a', label: 'a', value: 0.45, target: 0.9 }))).toBeCloseTo(0.5, 6)
    // 越小越好的指标:不超过达标线就是满分,超了按比例掉
    expect(normalizeMetric(createMetric({ key: 'b', label: 'b', value: 0.01, target: 0.05, direction: 'lower' }))).toBe(1)
    expect(normalizeMetric(createMetric({ key: 'b', label: 'b', value: 0.1, target: 0.05, direction: 'lower' }))).toBeCloseTo(0.5, 6)
  })

  it('三类指标不参与评分:缺值、没设达标线、权重非正', () => {
    expect(normalizeMetric(createMetric({ key: 'a', label: 'a', value: null, target: 0.9 }))).toBeNull()
    expect(normalizeMetric(createMetric({ key: 'a', label: 'a', value: 0.9 }))).toBeNull()
    expect(normalizeMetric(createMetric({ key: 'a', label: 'a', value: 0.9, target: 0.9, weight: 0 }))).toBeNull()
  })

  it('缺数据的指标不参与,权重按参与项重算 —— 不会因为「没数据」被判 0 分', () => {
    const score = scoreMetrics([
      createMetric({ key: 'coverage', label: '覆盖', value: 1, target: 1, weight: 0.5 }),
      createMetric({ key: 'recall', label: '召回', value: null, target: 0.9, weight: 0.5 }),
    ])
    expect(score.value).toBe(1)
    expect(score.weight).toBe(0.5)
    expect(score.byMetric).toEqual({ coverage: 1 })
  })

  it('一条可评指标都没有 ⇒ 总分 null、档位 unknown(而不是 0 分)', () => {
    const score = scoreMetrics([createMetric({ key: 'a', label: 'a', value: null, target: 1 })])
    expect(score.value).toBeNull()
    expect(score.grade).toBe('unknown')
    expect(score.weight).toBe(0)
  })

  it('档位按阈值切:≥0.9 良好、≥0.75 一般、再低偏低,无分则 unknown', () => {
    expect(gradeScore(null)).toBe('unknown')
    expect(gradeScore(SCORE_GRADE_THRESHOLDS.good)).toBe('good')
    expect(gradeScore(0.8)).toBe('fair')
    expect(gradeScore(0.5)).toBe('poor')
  })
})

describe('违规', () => {
  const info = createViolation({ rule: 'tilt-exceeded', severity: 'info', message: '仰角偏大' })
  const minor = createViolation({ rule: 'precision-gap', severity: 'minor', message: '误报偏多' })
  const major = createViolation({
    rule: 'missed-defect',
    severity: 'major',
    message: '漏检',
    ref: 'T02/ins-1-a',
    atS: 12,
  })

  it('缺省字段落成 null —— 违规清单要能直接进 JSON 导出', () => {
    expect(info.atS).toBeNull()
    expect(info.ref).toBeNull()
    expect(info.at).toBeNull()
    expect(major.ref).toBe('T02/ins-1-a')
    expect(major.atS).toBe(12)
  })

  it('最严重档位与计数:一条都没有时为 null,不假装「提示级」', () => {
    expect(worstSeverity([])).toBeNull()
    expect(worstSeverity([info, minor, major])).toBe('major')
    expect(countBySeverity([info, minor, major, major])).toEqual({
      info: 1,
      minor: 1,
      major: 2,
      critical: 0,
    })
  })

  it('排序从重到轻且同级稳定 —— 报告与界面看到的是同一个顺序', () => {
    expect(sortBySeverity([info, major, minor]).map((violation) => violation.severity)).toEqual([
      'major',
      'minor',
      'info',
    ])
    expect(sortBySeverity([minor, info]).map((violation) => violation.rule)).toEqual([
      'precision-gap',
      'tilt-exceeded',
    ])
  })

  it('只有 major / critical 阻断:提示与轻微只降分,不否决', () => {
    expect(hasBlockingViolation([info, minor])).toBe(false)
    expect(hasBlockingViolation([minor, major])).toBe(true)
    expect(hasBlockingViolation([createViolation({ rule: 'x', severity: 'critical', message: 'x' })])).toBe(true)
  })
})

describe('评价状态', () => {
  const major = createViolation({ rule: 'missed-defect', severity: 'major', message: '漏检' })
  const minor = createViolation({ rule: 'precision-gap', severity: 'minor', message: '误报' })

  it('没跑完 ⇒ 未完成,哪怕指标好看 —— 「没跑完」与「跑得差」是两件事', () => {
    expect(deriveEvaluationStatus({ complete: false, violations: [] })).toBe('incomplete')
    expect(deriveEvaluationStatus({ complete: false, violations: [major] })).toBe('incomplete')
  })

  it('跑完:有阻断性违规 ⇒ 不通过;只有轻微 ⇒ 有告警;一条都没有 ⇒ 通过', () => {
    expect(deriveEvaluationStatus({ complete: true, violations: [major] })).toBe('failed')
    expect(deriveEvaluationStatus({ complete: true, violations: [minor] })).toBe('warning')
    expect(deriveEvaluationStatus({ complete: true, violations: [] })).toBe('passed')
  })
})
