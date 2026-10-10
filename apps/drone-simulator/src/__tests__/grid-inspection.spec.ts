/**
 * 电网巡检链路护栏。
 *
 * 这条链路比别处长:资产台账 → 航线规划 → 载荷瞄准 → 逐塔控制 → 成像质量 → 判定 → 报告。
 * 逐段单测抓不住的错都会在这里现形,所以按六段分开钉:
 *
 *   ① 航线几何 —— 拍点怎么分、悬停落在哪、朝哪转,全部是**可推导的量**,不靠飞一遍看
 *   ② 载荷瞄准 —— 三个符号约定(仰角正=在上 / 偏航误差正=在右 / 云台偏航正=向左)逐个断言
 *   ③ 判定器   —— 同种子同结论;无真值绝不报缺陷;真值在时只可能漏检,不会报疑似
 *   ④ 无头端到端 —— 真飞机跑一次,从起飞到落地到出报告
 *   ⑤ 起飞前提 —— 机体没上电 / 自检没过就启动时,任务等就绪并重发,不报与真实原因不符的超时
 *   ⑥ 报告     —— 汇总口径、分母为零的处理、JSON/CSV/Markdown 三种导出
 *   ⑦ 作业评价 —— 指标口径、评分归一化、雾天必然降分、违规分档与状态四态
 *   ⑧ 检查点   —— 作业口径的通过/警告/失败/跳过(与对账口径严格分开)、启用/禁用
 *   ⑨ 预检查   —— 每条问题都带字段定位与修正方式,不能只说「校验失败」
 *
 * ④ 之所以敢断言「同种子得到同一份报告」,是因为仿真内核里没有 Math.random / Date.now
 * —— 连报告时间戳都是调用方注入的(README §75)。
 */
import { describe, expect, it } from 'vitest'
import { PLATFORM_COMMAND, vectorToHeading } from '@simulation/contracts'
import type { Vec3 } from '@simulation/contracts'
import { SimulationDomainAPI } from '@simulation/domain-api'
import type { AimSolution } from '@simulation/drone-agent'
import { solveAim } from '@simulation/drone-agent'
import type { PowerLine } from '@simulation/power-domain'
import { gridInspectionLine } from '@simulation/power-domain'
import type { InspectionRecord, InspectionReport, PartObservation } from '@simulation/power-evaluation'
import {
  alarmRecords,
  buildInspectionReport,
  classifyOutcome,
  derivePointResults,
  detect,
  evaluateInspection,
  imagingQuality,
  missionMetrics,
  missionScore,
  missingParts,
  outcomeBreakdown,
  reportPointsToCsv,
  reportToCsv,
  reportToJson,
  reportToMarkdown,
  summarizePointStatuses,
} from '@simulation/power-evaluation'
import {
  DEFAULT_DWELL_SECONDS,
  DEFAULT_LENS_ZOOM,
  canRunMission,
  gridInspectionScenario,
  gridLaunchSite,
  planInspectionRoute,
  validateMission,
} from '@simulation/grid-inspection'
import type { WeatherKind } from '@simulation/contracts'

/** 固定的报告时间戳 —— 报告不取墙钟,生成时刻由调用方给 */
const REPORT_STAMP = '2026-10-08T00:00:00.000Z'

function shortestAngle(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180
}

// ————————————————————————————— ① 航线几何 —————————————————————————————

describe('巡检航线规划', () => {
  const line = gridInspectionLine()
  const home: Vec3 = { x: 34, y: 0, z: 70 }
  const route = planInspectionRoute(line, { home })

  it('一基塔十一个部位,按「方位 + 距离」合并成四个拍点', () => {
    expect(line.towers).toHaveLength(6)
    // 塔头 1 + 上下两层各两段横担 4 + 上下两层各两串绝缘子 4 + 塔身 1 + 塔基 1
    expect(route.parts).toHaveLength(66)
    // 塔头与四段横担同侧同距(都从线路右侧 18 m 拍),合成一拍;
    // 上下层绝缘子分别在顺线两侧(14 m),各一拍;塔身与塔基同侧同距,合成一拍。
    for (const tower of line.towers) {
      const shots = route.shots.filter((shot) => shot.towerId === tower.id)
      expect(shots, `${tower.id} 的拍点数`).toHaveLength(4)
    }
    expect(route.shots).toHaveLength(24)
    // 拍点与部位的 id 都全局唯一 —— 报告按它做对账键
    expect(new Set(route.shots.map((shot) => shot.id)).size).toBe(24)
    expect(new Set(route.parts.map((part) => part.id)).size).toBe(66)
  })

  it('悬停落在横担之外的同一方位、同一距离上,且高于本拍点所有部位', () => {
    const towers = new Map(line.towers.map((tower) => [tower.id, tower]))
    for (const shot of route.shots) {
      const tower = towers.get(shot.towerId)
      expect(tower, `拍点 ${shot.id} 找不到对应杆塔`).toBeDefined()
      if (!tower) continue

      const distance = Math.hypot(shot.hover.x - tower.x, shot.hover.z - tower.z)
      // 配方里的拍摄距离只有 14 / 18 两种;四舍五入后必然落在其中之一
      expect([14, 18], `${shot.id} 的悬停距离`).toContain(Math.round(distance))
      // 悬停在横担半展之外 —— 否则塔边悬停会被避障反复推开,画面永远在抖
      expect(distance).toBeGreaterThan(tower.armHalfSpanM + 1)

      const topPart = Math.max(...shot.parts.map((part) => part.target.y))
      expect(shot.hover.y, `${shot.id} 悬停高度应高于本拍点最高部位(带俯角)`).toBeGreaterThan(topPart)
    }
  })

  it('期望航向就是「从悬停位看向杆塔」的方向', () => {
    const towers = new Map(line.towers.map((tower) => [tower.id, tower]))
    for (const shot of route.shots) {
      const tower = towers.get(shot.towerId)
      if (!tower) continue
      const bearing = vectorToHeading(tower.x - shot.hover.x, tower.z - shot.hover.z)
      expect(Math.abs(shortestAngle(shot.headingDeg, bearing)), `${shot.id} 的期望航向`).toBeLessThan(0.05)
    }
  })

  it('每个拍点的部位都归属同一塔、且该塔的部位一个不漏', () => {
    for (const tower of line.towers) {
      const shotParts = route.shots
        .filter((shot) => shot.towerId === tower.id)
        .flatMap((shot) => shot.parts.map((part) => part.partId))
      expect(shotParts.slice().sort()).toEqual(
        route.parts
          .filter((part) => part.towerId === tower.id)
          .map((part) => part.partId)
          .slice()
          .sort(),
      )
    }
  })

  it('作业方案进航线,但不改几何:倍率只影响成像质量,不影响飞法', () => {
    const wide = planInspectionRoute(line, { home, lensZoom: 1, dwellSeconds: 1 })
    const zoomed = planInspectionRoute(line, { home, lensZoom: 3, dwellSeconds: 5 })
    expect(wide.lensZoom).toBe(1)
    expect(zoomed.lensZoom).toBe(3)
    expect(wide.dwellSeconds).toBe(1)
    expect(zoomed.dwellSeconds).toBe(5)
    expect(wide.shots.map((shot) => shot.hover)).toEqual(zoomed.shots.map((shot) => shot.hover))
    expect(wide.transitLengthM).toBe(zoomed.transitLengthM)
  })

  it('转场里程随起飞点变化 —— 它算的是 home → 各拍点这条折线', () => {
    const fromLaunch = planInspectionRoute(line, { home }).transitLengthM
    const fromOrigin = planInspectionRoute(line, { home: { x: 0, y: 0, z: 0 } }).transitLengthM
    expect(fromLaunch).toBeGreaterThan(0)
    expect(fromLaunch).not.toBe(fromOrigin)
  })

  it('默认镜头倍率与采集时长就是常量里那两个,不另外藏一份', () => {
    const fallback = planInspectionRoute(line, { home })
    expect(fallback.lensZoom).toBe(DEFAULT_LENS_ZOOM)
    expect(fallback.dwellSeconds).toBe(DEFAULT_DWELL_SECONDS)
  })
})

// ————————————————————————————— ② 载荷瞄准 —————————————————————————————

describe('载荷瞄准解算', () => {
  const drone: Vec3 = { x: 0, y: 10, z: 0 }

  function aimAt(target: Vec3, headingDeg = 0): AimSolution {
    return solveAim({ drone, headingDeg, target })
  }

  it('目标正北、同高、机头朝北 ⇒ 云台不用动就已经对准', () => {
    const solution = aimAt({ x: 0, y: 10, z: -20 })
    expect(solution.bearingDeg).toBeCloseTo(0, 4)
    expect(solution.yawErrorDeg).toBeCloseTo(0, 4)
    expect(solution.elevationDeg).toBeCloseTo(0, 4)
    expect(solution.yawLimited).toBe(false)
    expect(solution.pitchLimited).toBe(false)
    expect(solution.aligned).toBe(true)
  })

  it('目标正右(东)⇒ 偏航误差为正,但云台只有 ±5°,残余误差如实报出且不算对准', () => {
    const solution = aimAt({ x: 20, y: 10, z: 0 })
    expect(solution.bearingDeg).toBeCloseTo(90, 4)
    expect(solution.yawErrorDeg).toBeCloseTo(90, 4)
    // 目标在右 ⇒ 云台向左偏 ⇒ 负值(见 aim.ts 文件头 ③)
    expect(solution.yawDeg).toBeCloseTo(-5, 4)
    expect(solution.yawLimited).toBe(true)
    expect(solution.aimErrorDeg).toBeCloseTo(85, 4)
    expect(solution.aligned).toBe(false)
  })

  it('目标在正上方 ⇒ 仰角 90°、俯仰被限到行程上限,并标记限幅', () => {
    const solution = aimAt({ x: 0, y: 110, z: 0 })
    expect(solution.distanceM).toBeCloseTo(0, 6)
    expect(solution.elevationDeg).toBeCloseTo(90, 4)
    expect(solution.pitchDeg).toBeCloseTo(60, 4)
    expect(solution.pitchLimited).toBe(true)
    expect(solution.aligned).toBe(false)
  })

  it('目标在正下方 ⇒ −90° 正好在行程内;方位角无定义时按机头朝向算,不报假误差', () => {
    const solution = aimAt({ x: 0, y: -90, z: 0 })
    expect(solution.distanceM).toBeCloseTo(0, 6)
    expect(solution.elevationDeg).toBeCloseTo(-90, 4)
    expect(solution.pitchDeg).toBeCloseTo(-90, 4)
    expect(solution.pitchLimited).toBe(false)
    // 正下方(俯拍塔基)的方位角没有意义:必须退化成「不转机身」,否则会凭空报出 ~175° 残余误差
    expect(solution.bearingDeg).toBeCloseTo(0, 6)
    expect(solution.yawErrorDeg).toBeCloseTo(0, 6)
    expect(solution.aimErrorDeg).toBeCloseTo(0, 6)
    expect(solution.aligned).toBe(true)
  })

  it('斜上方 45°:距离、斜距、仰角都是可手算的几何量', () => {
    const solution = aimAt({ x: 0, y: 30, z: -20 })
    expect(solution.distanceM).toBeCloseTo(20, 4)
    expect(solution.rangeM).toBeCloseTo(Math.hypot(20, 20), 4)
    expect(solution.elevationDeg).toBeCloseTo(45, 4)
    expect(solution.pitchDeg).toBeCloseTo(45, 4)
    expect(solution.pitchLimited).toBe(false)
  })

  it('目标在正后方 ⇒ 偏航误差取最短角(−180°),不会绕成 +180°', () => {
    const solution = aimAt({ x: 0, y: 10, z: 20 })
    expect(solution.bearingDeg).toBeCloseTo(180, 4)
    expect(solution.yawErrorDeg).toBeCloseTo(-180, 4)
    expect(solution.aligned).toBe(false)
  })
})

// ————————————————————————————— ③ 判定器 —————————————————————————————

function observation(rangeM: number): PartObservation {
  return { rangeM, offAxisDeg: 0, tiltDeg: 0, headingErrorDeg: 0 }
}

describe('缺陷判定', () => {
  it('成像质量:倍率越高特征像素越多,距离越远质量越低,雾天必然打折', () => {
    // 0.25 m 的特征(绝缘子串上的一片)在广角 1× 下,10 m 处看得满,60 m 已经勉强,120 m 基本看不清
    const qualityAt = (rangeM: number, lensZoom: number, weather: WeatherKind): number =>
      imagingQuality({
        criticalSizeM: 0.25,
        observation: observation(rangeM),
        lensZoom,
        weather,
        windSpeedMps: 0,
      }).quality

    expect(qualityAt(10, 1, 'clear')).toBeGreaterThan(qualityAt(60, 1, 'clear'))
    expect(qualityAt(60, 1, 'clear')).toBeGreaterThan(qualityAt(120, 1, 'clear'))

    // 变焦把特征在画面上的张角放大 —— 同样距离下倍率翻倍,特征像素数也翻倍
    const wide = imagingQuality({
      criticalSizeM: 0.4,
      observation: observation(30),
      lensZoom: 1,
      weather: 'clear',
      windSpeedMps: 0,
    })
    const zoomed = imagingQuality({
      criticalSizeM: 0.4,
      observation: observation(30),
      lensZoom: 2,
      weather: 'clear',
      windSpeedMps: 0,
    })
    // 特征像素按 0.1 px 取整后报出,所以这里用比值而不是精确倍数断言
    expect(zoomed.featurePixels).toBeGreaterThan(wide.featurePixels * 1.9)
    expect(zoomed.featurePixels).toBeLessThan(wide.featurePixels * 2.1)
    expect(zoomed.quality).toBeGreaterThanOrEqual(wide.quality)

    // 天气是整体系数:雾天在任何距离上都比晴天差
    expect(qualityAt(30, 2, 'fog')).toBeLessThan(qualityAt(30, 2, 'clear'))
  })

  it('无真值 ⇒ 永远不会报「缺陷」,低质量最多报「疑似」', () => {
    let suspects = 0
    for (let seed = 1; seed <= 200; seed += 1) {
      const result = detect({
        towerId: 'T01',
        partId: 'ins-1-b',
        partKind: 'insulator',
        criticalSizeM: 0.25,
        truth: null,
        observation: observation(40),
        lensZoom: 1,
        weather: 'fog',
        windSpeedMps: 0,
        seed,
      })
      expect(result.verdict === 'defect', `seed ${seed} 在没有真值时报了缺陷`).toBe(false)
      if (result.verdict === 'suspect') suspects += 1
    }
    // 低质量图片必然带来误检 —— 这正是报告里 precision 会掉下去的原因
    expect(suspects, '低质量下应当出现误检').toBeGreaterThan(0)
  })

  it('有真值 ⇒ 只可能「检出」或「漏检」,不会报「疑似」', () => {
    let misses = 0
    for (let seed = 1; seed <= 200; seed += 1) {
      const result = detect({
        towerId: 'T02',
        partId: 'ins-1-a',
        partKind: 'insulator',
        criticalSizeM: 0.25,
        truth: { partId: 'ins-1-a', kind: 'insulatorBroken', severity: 'major', note: '' },
        observation: observation(40),
        lensZoom: 1,
        weather: 'fog',
        windSpeedMps: 0,
        seed,
      })
      expect(result.verdict === 'suspect', `seed ${seed} 在已知真值时报了疑似`).toBe(false)
      if (result.verdict === 'ok') misses += 1
    }
    // 严重缺陷也有漏检率(0.9×质量 + 严重度基数 < 1),所以必然存在漏检
    expect(misses, '低质量下应当出现漏检').toBeGreaterThan(0)
  })

  it('同一份输入重复判定 ⇒ 结论完全一致(随机源由种子派生,不取墙钟)', () => {
    const input = {
      towerId: 'T04',
      partId: 'towerBody',
      partKind: 'towerBody' as const,
      criticalSizeM: 1.2,
      truth: { partId: 'towerBody', kind: 'towerRust' as const, severity: 'minor' as const, note: '' },
      observation: observation(14),
      lensZoom: 2,
      weather: 'cloudy' as const,
      windSpeedMps: 3,
      seed: 20261008,
    }
    expect(detect(input)).toEqual(detect(input))
  })

  it('「疑似」计入报警 —— 现场要派人去看,所以它参与精度而不是被丢掉', () => {
    const truth = { partId: 'p', kind: 'towerRust' as const, severity: 'minor' as const, note: '' }
    expect(classifyOutcome('unchecked', null)).toBe('unchecked')
    expect(classifyOutcome('ok', null)).toBe('trueNegative')
    expect(classifyOutcome('ok', truth)).toBe('missed')
    expect(classifyOutcome('defect', truth)).toBe('truePositive')
    expect(classifyOutcome('defect', null)).toBe('falsePositive')
    expect(classifyOutcome('suspect', null)).toBe('falsePositive')
    expect(classifyOutcome('suspect', truth)).toBe('truePositive')
  })
})

// ————————————————————————————— ④ 无头端到端 —————————————————————————————

interface InspectionRun {
  readonly report: InspectionReport
  readonly status: string
  readonly metrics: Readonly<Record<string, number>>
}

interface RunOptions {
  readonly lensZoom?: number
  readonly weather?: WeatherKind
  /** 被禁用的检查点 id(§3.2)—— 禁用的点不飞,但部位仍计入总数 */
  readonly disabledShotIds?: ReadonlyArray<string>
}

/**
 * 无头跑一次完整巡检:上电 → 创建任务 → 启动 → 推进到任务收尾 → 取报告。
 * 不碰渲染、不碰浏览器,但走的是与界面完全同一条链路。
 */
function runInspection(options: RunOptions = {}): InspectionRun {
  const line = gridInspectionLine()
  const launch = gridLaunchSite()
  const scenario = { ...gridInspectionScenario({ line }), weather: options.weather ?? 'clear' }
  const route = planInspectionRoute(line, {
    home: { x: launch.x, y: launch.y, z: launch.z },
    lensZoom: options.lensZoom ?? DEFAULT_LENS_ZOOM,
    dwellSeconds: DEFAULT_DWELL_SECONDS,
    disabledShotIds: options.disabledShotIds,
  })

  const session = new SimulationDomainAPI({
    scenario,
    label: '巡检护栏',
    drone: { factoryFolded: false },
    autoStart: false,
  })
  const droneId = session.primaryDroneId()
  if (droneId === undefined) throw new Error('巡检场景应当包含一架无人机')

  session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId })
  session.step(600) // 自检 + 传感器预热

  const taskId = session.createGridInspectionTask({
    agentId: droneId,
    route,
    seed: scenario.seed,
    landAtEnd: true,
  })
  if (taskId === null) throw new Error('创建巡检任务失败')
  session.startTask(taskId)

  // 基准工况约 370 s 仿真时长(接近段按刹车曲线收杆,比原先一路满舵慢约 9%);
  // 预算给到 1 小时仿真时间,超了就是真的卡住了
  let elapsed = 0
  while (elapsed < 3600) {
    session.step(600)
    elapsed += 10
    const status = session.getTaskResult(taskId)?.status ?? 'pending'
    if (status !== 'pending' && status !== 'running') break
  }

  const result = session.getTaskResult(taskId)
  const report = session.getInspectionReport(taskId, REPORT_STAMP)
  session.dispose()
  if (!result || !report) throw new Error('任务或报告缺失')
  return { report, status: result.status, metrics: result.metrics }
}

/** 同参数的巡检只跑一次 —— 无头跑一次约 0.6 s,几个用例共用即可 */
const sharedRuns = new Map<string, InspectionRun>()
function sharedRun(options: RunOptions): InspectionRun {
  const key = JSON.stringify(options)
  const cached = sharedRuns.get(key)
  if (cached) return cached
  const run = runInspection(options)
  sharedRuns.set(key, run)
  return run
}

describe('巡检端到端', () => {
  it('基准工况:24 个拍点全部拍成、66 个部位全覆盖、四条真值缺陷全部对上', () => {
    const run = sharedRun({ weather: 'clear' })
    const summary = run.report.summary

    expect(run.status).toBe('completed')
    expect(run.metrics['shotsTaken']).toBe(run.metrics['shotsTotal'])
    expect(summary.shotsTaken).toBe(24)
    expect(summary.partsChecked).toBe(summary.partsTotal)
    expect(summary.partsUnchecked).toBe(0)
    expect(summary.coverage).toBe(1)
    expect(summary.towersInspected).toBe(summary.towersTotal)

    // 真值缺陷都进了记录,而且都被检出
    const truthRecords = run.report.records.filter((record) => record.truth !== null)
    expect(truthRecords).toHaveLength(summary.truthDefects)
    expect(summary.truthDefects).toBeGreaterThan(0)
    expect(truthRecords.filter((record) => record.outcome === 'truePositive')).toHaveLength(summary.truthDefects)

    // 报告时间戳是调用方注入的,不是包内取的墙钟
    expect(run.report.generatedAt).toBe(REPORT_STAMP)
    expect(run.report.detectorVersion).toBe('rule-v1')
    expect(run.report.status).toBe('completed')
  })

  it('每条记录都带得出「当时拍成什么样」:观测量与成像质量都在', () => {
    const run = sharedRun({ weather: 'clear' })
    for (const record of run.report.records) {
      expect(record.observation, `${record.partId} 缺观测几何`).not.toBeNull()
      const view = record.observation
      if (!view) continue
      expect(view.rangeM).toBeGreaterThan(0)
      expect(view.offAxisDeg).toBeGreaterThanOrEqual(0)
      expect(record.detection.quality.quality).toBeGreaterThan(0)
      expect(record.detection.quality.quality).toBeLessThanOrEqual(1)
      expect(record.detection.quality.featurePixels).toBeGreaterThan(0)
    }
  })

  it('雾天:成像质量掉下去之后,漏检与误检同时出现,召回与精度跟着掉', () => {
    const clear = sharedRun({ weather: 'clear' }).report.summary
    const fog = sharedRun({ weather: 'fog' }).report.summary

    expect(fog.averageQuality).not.toBeNull()
    expect(clear.averageQuality).not.toBeNull()
    expect(fog.averageQuality ?? 1).toBeLessThan(clear.averageQuality ?? 0)

    expect(fog.missed).toBeGreaterThan(0)
    expect(fog.falsePositive).toBeGreaterThan(0)
    expect(fog.recall ?? 1).toBeLessThan(1)
    expect(fog.precision ?? 1).toBeLessThan(1)

    // 覆盖率不受天气影响:判断不出来是判定的事,不是没拍到
    expect(fog.coverage).toBe(1)
  })

  it('漏检的记录在报告里是「真值存在但结论正常」,不藏起来', () => {
    const run = sharedRun({ weather: 'fog' })
    const missed = run.report.records.filter((record) => record.outcome === 'missed')
    expect(missed.length).toBeGreaterThan(0)
    for (const record of missed) {
      expect(record.truth).not.toBeNull()
      expect(record.detection.verdict).toBe('ok')
      expect(record.detection.note).toContain('未能分辨')
    }
  })

  it('同种子 + 同方案 ⇒ 两次巡检得到同一份报告', () => {
    const first = runInspection({ weather: 'clear' })
    const second = runInspection({ weather: 'clear' })
    expect(second.report.summary).toEqual(first.report.summary)
    expect(second.metrics).toEqual(first.metrics)
    expect(second.report.records.map(keyOf)).toEqual(first.report.records.map(keyOf))
  })
})

// ————————————————————————————— ⑤ 起飞前提 —————————————————————————————
//
// 这一段钉的是一个**契约层没有回执**的缺口:任务发出 `agent.takeOff` 之后,没有任何
// 机制告诉它「指令被接受了没有」。而「上电」不等于「可飞」—— 自检 / 预热 / 搜星要
// 走几秒,这几秒里的起飞指令会被内部检查单静默拒掉。
//
// 修之前任务只在启动那一 tick 发一次指令,被拒后就空等满整个超时窗口,最后报出
// 「起飞爬升超时(40 秒未到达 32 米)」—— 把「机体还没准备好」说成了「飞不起来」。
// 界面上这特别容易撞上:操作员点「创建并启动」时,页面刚打开几秒,自检未必走完。

/** 冷启一次巡检:可选「先上电」与「上电后等多久再启动」,其余与 runInspection 同路 */
function coldStart(options: {
  readonly powerOnFirst: boolean
  readonly warmupSteps: number
}): { readonly session: SimulationDomainAPI; readonly taskId: string; readonly droneId: string } {
  const line = gridInspectionLine()
  const launch = gridLaunchSite()
  const scenario = gridInspectionScenario({ line })
  const route = planInspectionRoute(line, {
    home: { x: launch.x, y: launch.y, z: launch.z },
    lensZoom: DEFAULT_LENS_ZOOM,
    dwellSeconds: DEFAULT_DWELL_SECONDS,
  })
  const session = new SimulationDomainAPI({
    scenario,
    label: '冷启',
    drone: { factoryFolded: false },
    autoStart: false,
  })
  const droneId = session.primaryDroneId()
  if (droneId === undefined) throw new Error('巡检场景应当包含一架无人机')

  if (options.powerOnFirst) {
    session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId })
  }
  session.step(options.warmupSteps)

  const taskId = session.createGridInspectionTask({
    agentId: droneId,
    route,
    seed: scenario.seed,
    landAtEnd: true,
  })
  if (taskId === null) throw new Error('创建巡检任务失败')
  session.startTask(taskId)
  return { session, taskId, droneId }
}

describe('起飞前提', () => {
  it('机体还没上电就启动 ⇒ 任务停在「等待机体就绪」,上电后自己起飞,不报假超时', () => {
    const { session, taskId, droneId } = coldStart({ powerOnFirst: false, warmupSteps: 0 })

    // 没上电时不能把起飞指令丢出去装作一切正常 —— 要如实停在等待态
    session.step(60)
    const waiting = session.getTaskSnapshots().find((item) => item.id === taskId)
    expect(waiting?.status).toBe('running')
    expect(waiting?.progress.stage).toBe('等待机体就绪')

    // 上电之后任务自己接着飞,不需要谁再点一次
    session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId })
    session.step(600 * 20)

    const snapshot = session.getTaskSnapshots().find((item) => item.id === taskId)
    expect(snapshot?.status).toBe('running')
    expect(snapshot?.progress.stage).not.toBe('等待机体就绪')
    // 真离地了才算数 —— 状态机往前走不等于飞机起来了
    expect(session.getAgentState(droneId)?.position.y ?? 0).toBeGreaterThan(5)
    expect(session.getEventLog().some((event) => event.message?.includes('等待机体就绪超时') === true)).toBe(false)
    session.dispose()
  })

  it('上电了但自检没过就启动 ⇒ 任务重发起飞指令,不空等满超时窗口', () => {
    // warmup 给 1 秒:上电已完成(status 变 active),但自检 / 预热还在跑
    const { session, taskId } = coldStart({ powerOnFirst: true, warmupSteps: 60 })

    let failure: string | null = null
    for (let second = 0; second < 60; second += 1) {
      session.step(60)
      const snapshot = session.getTaskSnapshots().find((item) => item.id === taskId)
      if (snapshot?.status === 'failed') {
        failure = snapshot.result?.message ?? '任务失败'
        break
      }
    }

    expect(failure).toBeNull()
    // 那条与真实原因不符的告警不该出现 —— 指令只是被拒,不是飞不起来
    expect(session.getEventLog().some((event) => event.message?.includes('起飞爬升超时') === true)).toBe(false)
    // 提示只该出现一次:重发是补请求,不是把日志刷成一片
    const retryNotes = session
      .getEventLog()
      .filter((event) => event.message?.includes('尚未接受起飞指令') === true)
    expect(retryNotes.length).toBeLessThanOrEqual(1)
    session.dispose()
  })
})

function keyOf(record: InspectionRecord): string {
  return `${record.partId}:${record.detection.verdict}:${record.outcome}`
}

// ————————————————————————————— ⑥ 报告汇总与导出 —————————————————————————————

describe('巡检报告', () => {
  const report = sharedRun({ weather: 'clear' }).report

  it('逐塔小结与全局汇总对得上账', () => {
    const towersSum = report.towers.reduce((total, tower) => total + tower.partsChecked, 0)
    expect(towersSum).toBe(report.summary.partsChecked)
    expect(report.towers.reduce((total, tower) => total + tower.partsTotal, 0)).toBe(report.summary.partsTotal)
    expect(report.towers.reduce((total, tower) => total + tower.truthDefects, 0)).toBe(report.summary.truthDefects)
    expect(report.records).toHaveLength(report.summary.partsTotal)
    // 同一次巡检重算两次报告,结果必须一样(纯函数)
    expect(sharedRun({ weather: 'clear' }).report.summary).toEqual(report.summary)
  })

  it('对账分布恰好覆盖全部记录,五类一类不少', () => {
    const breakdown = outcomeBreakdown(report)
    expect(breakdown.map((item) => item.outcome)).toEqual([
      'truePositive',
      'falsePositive',
      'missed',
      'trueNegative',
      'unchecked',
    ])
    expect(breakdown.reduce((total, item) => total + item.count, 0)).toBe(report.records.length)
  })

  it('报警清单把缺陷排在疑似之前,同类按部位 id 排', () => {
    const alarms = alarmRecords(report)
    expect(alarms).toHaveLength(report.summary.alarms)
    for (let index = 1; index < alarms.length; index += 1) {
      const previous = alarms[index - 1]
      const current = alarms[index]
      if (!previous || !current) continue
      if (previous.detection.verdict === current.detection.verdict) {
        expect(previous.partId.localeCompare(current.partId)).toBeLessThanOrEqual(0)
      } else {
        expect(previous.detection.verdict).toBe('defect')
      }
    }
  })

  it('没有真值缺陷时,召回率与精度给 null 而不是 100%', () => {
    const clean: PowerLine = {
      ...gridInspectionLine(),
      towers: gridInspectionLine().towers.map((tower) => ({ ...tower, defects: [] })),
    }
    const route = planInspectionRoute(clean, { home: gridLaunchSite() })
    // 一条记录都没有:分母为零
    const empty = {
      route,
      records: [] as ReadonlyArray<InspectionRecord>,
      status: 'completed' as const,
      message: '空报告',
      sessionLabel: '护栏',
      scenarioId: 'test',
      taskLabel: '空',
      startedAtS: 0,
      finishedAtS: 0,
      maxAltitudeM: 0,
      generatedAt: REPORT_STAMP,
    }
    const built = buildInspectionReport(empty)
    expect(built.summary.truthDefects).toBe(0)
    expect(built.summary.recall).toBeNull()
    expect(built.summary.precision).toBeNull()
    expect(built.summary.coverage).toBe(0)
    // 未采集的部位清单就是整条航线
    expect(missingParts(route, [])).toHaveLength(route.parts.length)
  })

  it('JSON 导出可原样往返', () => {
    const parsed = JSON.parse(reportToJson(report)) as InspectionReport
    expect(parsed.summary).toEqual(report.summary)
    expect(parsed.records).toHaveLength(report.records.length)
    expect(parsed.id).toBe(report.id)
    expect(parsed.generatedAt).toBe(REPORT_STAMP)
  })

  it('CSV 带 UTF-8 BOM,一行一个部位,表头是中文列名', () => {
    const csv = reportToCsv(report)
    expect(csv.startsWith('\ufeff'), 'CSV 少了 BOM,Excel 打开会乱码').toBe(true)
    const rows = csv.trim().split('\r\n')
    expect(rows).toHaveLength(report.records.length + 1)
    const header = rows[0]?.replace('\ufeff', '') ?? ''
    expect(header.split(',')).toHaveLength(18)
    for (const column of ['塔号', '部位', '结论', '成像质量', '对账结果', '地面真值']) {
      expect(header).toContain(column)
    }
  })

  it('Markdown 报告说清了三件事:汇总、缺陷清单、真值只用于对账', () => {
    const markdown = reportToMarkdown(report)
    expect(markdown).toContain('# 无人机巡检报告')
    expect(markdown).toContain('## 汇总')
    expect(markdown).toContain('## 缺陷清单')
    expect(markdown).toContain('## 逐塔小结')
    expect(markdown).toContain('仅用于对账')
    expect(markdown).toContain(String(report.summary.partsTotal))
  })
})

// ————————————————————————————— ⑦ 作业评价 —————————————————————————————

describe('作业评价', () => {
  it('四条指标直接取自报告汇总,不做二次口径', () => {
    const report = sharedRun({ weather: 'clear' }).report
    const metrics = missionMetrics(report)
    expect(metrics.map((metric) => metric.key)).toEqual(['coverage', 'recall', 'precision', 'dataQuality'])

    const at = (key: string): number | null | undefined => metrics.find((metric) => metric.key === key)?.value
    expect(at('coverage')).toBe(report.summary.coverage)
    expect(at('recall')).toBe(report.summary.recall)
    expect(at('precision')).toBe(report.summary.precision)
    expect(at('dataQuality')).toBe(report.summary.averageQuality)

    // 每条都有达标线 —— 没设目标线的指标不参与评分,那样「总分」说不清分母
    for (const metric of metrics) expect(metric.target, `${metric.key} 缺达标线`).not.toBeNull()
  })

  it('评分恒在 0~1、四项权重和为 1,且同一份报告永远同一个分', () => {
    const report = sharedRun({ weather: 'clear' }).report
    const score = missionScore(report)
    expect(score.value).not.toBeNull()
    expect(score.value ?? 0).toBeGreaterThan(0)
    expect(score.value ?? 2).toBeLessThanOrEqual(1)
    // 基准工况四项都有值 ⇒ 权重全参与
    expect(score.weight).toBe(1)
    for (const value of Object.values(score.byMetric)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
    expect(missionScore(report)).toEqual(score)
  })

  it('雾天评分必然低于晴天:掉的是召回与画质,不是随机抖动', () => {
    const clear = missionScore(sharedRun({ weather: 'clear' }).report)
    const fog = missionScore(sharedRun({ weather: 'fog' }).report)
    expect(fog.value).not.toBeNull()
    expect(clear.value).not.toBeNull()
    expect(fog.value ?? 1).toBeLessThan(clear.value ?? 0)
    expect(fog.byMetric.dataQuality ?? 1).toBeLessThan(clear.byMetric.dataQuality ?? 0)
    // 4 条真值缺陷漏了至少 1 条 ⇒ 召回 ≤ 0.75,归一化后必然小于 1
    expect(fog.byMetric.recall ?? 1).toBeLessThan(1)
    // 覆盖率与天气无关:判不出来是判定的事,不是没拍到
    expect(fog.byMetric.coverage).toBe(clear.byMetric.coverage)
  })

  it('评价结果可由报告复算:标识、生成时刻、指标与评分全部来自报告', () => {
    const report = sharedRun({ weather: 'clear' }).report
    const evaluation = evaluateInspection({ report })
    expect(evaluation.subjectId).toBe(report.id)
    expect(evaluation.evaluatorId).toBe('power-inspection')
    expect(evaluation.generatedAtS).toBe(report.finishedAtS)
    expect(evaluation.metrics).toEqual(missionMetrics(report))
    expect(evaluation.score).toEqual(missionScore(report))

    // 基准工况的四个数是可复算的:全覆盖 / 全召回 / 零误报 / 画质 0.89
    //
    // 画质随飞法变,这个数被改过一次:接近段原先一路满舵、冲过悬停位 8 米才停,
    // 机体离塔比计划远,同一拍点内几个部位的偏心角反而被「拉小」,画质虚高到 0.917。
    // 修好刹车曲线后机体停在计划位置上,画质落到 0.89 —— 掉的是虚高那一截。
    expect(report.summary.averageQuality).toBe(0.89)
    expect(evaluation.score).toEqual({
      value: 1,
      grade: 'good',
      byMetric: { coverage: 1, recall: 1, precision: 1, dataQuality: 1 },
      weight: 1,
    })
    // 四项全部达标 ⇒ 没有违规,状态「通过」
    expect(evaluation.violations).toEqual([])
    expect(evaluation.status).toBe('passed')
  })

  it('雾天的评价落下来:漏检一条 major,画质与误报各扣一分', () => {
    const report = sharedRun({ weather: 'fog' }).report
    const evaluation = evaluateInspection({ report })
    expect(evaluation.score).toEqual({
      value: 0.775,
      grade: 'fair',
      byMetric: { coverage: 1, recall: 0.833, precision: 0.375, dataQuality: 0.668 },
      weight: 1,
    })
    expect(evaluation.status).toBe('failed')
    expect(evaluation.violations.map((violation) => `${violation.rule}:${violation.severity}`)).toEqual([
      'missed-defect:major',
      'quality-gap:minor',
      'precision-gap:minor',
    ])
  })

  it('巡检途中取进度截面 ⇒ 「未完成」,不判「不通过」;覆盖缺口如实报出', () => {
    const report = sharedRun({ weather: 'clear' }).report
    const partial = {
      ...report,
      status: 'inProgress' as const,
      summary: { ...report.summary, coverage: 0.3, partsUnchecked: 40 },
    }
    const evaluation = evaluateInspection({ report: partial })
    expect(evaluation.status).toBe('incomplete')

    const gap = evaluation.violations.find((violation) => violation.rule === 'coverage-gap')
    // 3 成覆盖已经过了「补几个拍点」的量级,按 major 报
    expect(gap?.severity).toBe('major')
    expect(gap?.message).toContain('40')
  })

  it('漏检逐条报成 major 且带部位与位置 —— 现场最需要立刻知道的就是这一条', () => {
    const report = sharedRun({ weather: 'fog' }).report
    const evaluation = evaluateInspection({ report })
    const missed = report.records.filter((record) => record.outcome === 'missed')
    expect(missed.length).toBeGreaterThan(0)

    const rules = evaluation.violations.filter((violation) => violation.rule === 'missed-defect')
    expect(rules).toHaveLength(missed.length)
    for (const violation of rules) {
      expect(violation.severity).toBe('major')
      expect(violation.ref).not.toBeNull()
      expect(violation.at).not.toBeNull()
      expect(violation.message).toContain('漏检')
    }

    // 违规清单从重到轻 —— 报告与界面共用同一个顺序
    const rank = (severity: string): number =>
      severity === 'critical' ? 3 : severity === 'major' ? 2 : severity === 'minor' ? 1 : 0
    const ranks = evaluation.violations.map((violation) => rank(violation.severity))
    expect(ranks).toEqual(ranks.slice().sort((a, b) => b - a))
  })
})

// ————————————————————————————— ⑧ 检查点状态与启用/禁用 —————————————————————————————

describe('检查点状态(产品规格 §5.1 / §5.2)', () => {
  it('基准工况:24 个检查点全部拍到,通过 23 / 警告 1 —— 没有失败也没有跳过', () => {
    const report = sharedRun({ weather: 'clear' }).report
    expect(report.points).toHaveLength(report.summary.shotsPlanned)
    expect(summarizePointStatuses(report.points)).toEqual({
      planned: report.summary.shotsPlanned,
      passed: report.summary.pointsPassed,
      warning: report.summary.pointsWarning,
      failed: report.summary.pointsFailed,
      skipped: report.summary.pointsSkipped,
    })
    expect(report.summary.pointsFailed).toBe(0)
    expect(report.summary.pointsSkipped).toBe(0)
    expect(report.summary.pointsPassed + report.summary.pointsWarning).toBe(report.summary.shotsPlanned)

    // 唯一的警告是 T05/S3 的 ins-2-b:它没有真值缺陷,但这一拍点内两个绝缘子相隔
    // 21.3°,成像质量 0.78,判定器的假警概率 (1−0.78)×0.18 恰好命中该部位的种子。
    // 这正是 §5.2 要的语义 —— 六条检查条条成立(拍到了、距离对、航向对、云台在容差内、
    // 证据齐全),所以不是「失败」;但结论里带着一个「疑似」,所以也不能算「通过」。
    const warned = report.points.filter((point) => point.status === 'warning')
    expect(warned.map((point) => point.pointId)).toEqual(['T05/S3'])
    expect(warned[0]?.checks.every((check) => check.ok)).toBe(true)
    expect(warned[0]?.problems).toEqual([])
  })

  it('基准工况:没有任何检查点因为「飞不到 / 拍不清」被判失败', () => {
    // 这条是飞行侧的护栏:接近段一旦刹不住,机体就会冲过悬停位,观测距离超出要求,
    // 检查点成片判失败(实测过 6 个 S3 拍点偏 8.3 米)。断言的是**六条检查同时成立**,
    // 而不是某个笼统的「成功」。
    const report = sharedRun({ weather: 'clear' }).report
    for (const point of report.points) {
      expect(point.status, `${point.pointId} 未拍到`).not.toBe('failed')
      if (point.status === 'skipped') continue
      for (const check of point.checks) {
        expect(check.ok, `${point.pointId} ${check.label}:${check.detail}`).toBe(true)
      }
    }
  })

  it('逐点结果可由航线与记录直接推导 —— 报告里的那份不是另算的', () => {
    const run = sharedRun({ weather: 'clear' })
    const route = planInspectionRoute(gridInspectionLine(), { home: gridLaunchSite() })
    expect(derivePointResults(route, run.report.records)).toEqual(run.report.points)
  })

  it('每条检查点结果都带六条独立检查,失败原因写成可读整句', () => {
    const report = sharedRun({ weather: 'clear' }).report
    const point = report.points[0]
    expect(point?.checks.map((check) => check.kind)).toEqual([
      'arrival',
      'distance',
      'heading',
      'gimbal',
      'capture',
      'link',
    ])
    for (const check of point?.checks ?? []) {
      expect(check.label.length).toBeGreaterThan(0)
      expect(check.detail.length).toBeGreaterThan(0)
    }
    expect(point?.captureIds.length).toBeGreaterThan(0)
    // 全部通过的点不该带任何「未通过原因」
    expect(point?.problems).toEqual([])
    expect(point?.checks.every((check) => check.ok)).toBe(true)
  })

  it('检查点 CSV 一行一个检查点,列头是中文', () => {
    const report = sharedRun({ weather: 'clear' }).report
    const csv = reportPointsToCsv(report)
    const rows = csv.trim().split('\r\n')
    expect(rows).toHaveLength(report.points.length + 1)
    expect(rows[0]?.replace('\ufeff', '')).toContain('检查点')
  })

  it('Markdown 报告写明数据来源与检查点结果(§10 不能混淆来源)', () => {
    const report = sharedRun({ weather: 'clear' }).report
    const markdown = reportToMarkdown(report)
    expect(markdown).toContain('数据来源:仿真数据')
    expect(markdown).toContain('## 检查点结果')
  })

  it('禁用一个检查点:它判「跳过」、不被飞到,但部位仍计入总数', () => {
    const line = gridInspectionLine()
    const launch = gridLaunchSite()
    const full = planInspectionRoute(line, { home: launch })
    const disabledId = full.shots[2]?.id ?? ''
    const plan = planInspectionRoute(line, { home: launch, disabledShotIds: [disabledId] })

    expect(plan.shots.find((shot) => shot.id === disabledId)?.enabled).toBe(false)
    // 航线与部位清单一条不少 —— 覆盖率没被悄悄抬高
    expect(plan.shots).toHaveLength(full.shots.length)
    expect(plan.parts).toHaveLength(full.parts.length)
    // 也不会被飞到,所以预估里程变小
    expect(plan.transitLengthM).toBeLessThan(full.transitLengthM)
  })

  it('无头跑一次带禁用点的巡检:状态是「跳过」,覆盖率必然小于 100%', () => {
    const line = gridInspectionLine()
    const launch = gridLaunchSite()
    const planned = planInspectionRoute(line, { home: launch })
    const disabledId = planned.shots[2]?.id ?? ''
    const disabledParts = planned.shots.find((shot) => shot.id === disabledId)?.parts.length ?? 0

    const run = sharedRun({ weather: 'clear', disabledShotIds: [disabledId] })
    const point = run.report.points.find((entry) => entry.pointId === disabledId)
    expect(point?.status).toBe('skipped')
    expect(point?.problems.join()).toContain('禁用')
    expect(run.report.summary.pointsSkipped).toBeGreaterThanOrEqual(1)
    expect(run.report.summary.coverage).toBeLessThan(1)
    expect(run.report.summary.partsUnchecked).toBeGreaterThanOrEqual(disabledParts)
  })

  it('禁用的点排在队首时,后面那条长腿照常飞抵 —— 避障读数按世界坐标对齐', () => {
    // 回归护栏。禁掉第一个拍点会凭空造出一条长腿:机体从起飞点 (34,0,70) 直接飞去
    // T01/S2 的悬停位 (0,13.85,26),水平 55.6 米。
    //
    // 这条腿曾经走不完 —— 不是飞得慢,是被自己的避障刹停了:DroneSim 的 position 是
    // 「以起飞点为原点」的局部坐标,而障碍盒直接按世界坐标塞进了仿真,于是机体在
    // 世界 (33.7,14,69.7) —— 离所有杆塔 30 米开外 —— 被判「贴着障碍物」,一路
    // 0.14 m/s 爬行 50 秒,最后 T01/S2 以「转场超时」判失败。沙盒场景的机体出生在
    // 世界原点、平移量为零,所以这个错位只在巡检场景里露得出来。
    const run = sharedRun({ weather: 'clear', disabledShotIds: ['T01/S1'] })

    expect(run.status).toBe('completed')
    expect(run.report.points.find((point) => point.pointId === 'T01/S1')?.status).toBe('skipped')

    const next = run.report.points.find((point) => point.pointId === 'T01/S2')
    expect(next?.status, `T01/S2:${(next?.problems ?? []).join('/')}`).toBe('passed')
    expect(next?.checks.every((check) => check.ok)).toBe(true)
    // 被禁用的那一条是计划内取舍,不该带出第二个失败点
    expect(run.report.summary.pointsFailed).toBe(0)
  })
})

// ————————————————————————————— ⑨ 任务预检查 —————————————————————————————

describe('任务预检查(产品规格 §3.2 / §13.4)', () => {
  const line = gridInspectionLine()
  const launch = gridLaunchSite()

  it('合格航线零问题', () => {
    const issues = validateMission({ route: planInspectionRoute(line, { home: launch }) })
    expect(issues).toEqual([])
    expect(canRunMission(issues)).toBe(true)
  })

  it('没有杆塔 ⇒ 报「资产不存在」,并说明怎么补', () => {
    const empty = { ...line, towers: [] }
    const issues = validateMission({ route: planInspectionRoute(empty, { home: launch }) })
    const issue = issues.find((entry) => entry.code === 'no-assets')
    expect(issue?.severity).toBe('error')
    expect(issue?.field).toContain('台账')
    expect((issue?.fix ?? '').length).toBeGreaterThan(0)
    expect(canRunMission(issues)).toBe(false)
  })

  it('未设起飞点 ⇒ error;起飞点贴着杆塔 ⇒ warning 且说清距离', () => {
    const route = planInspectionRoute(line, { home: launch })
    expect(validateMission({ route, home: null }).find((entry) => entry.code === 'no-home')?.severity).toBe('error')

    const first = line.towers[0]
    const close = validateMission({ route, home: { x: first?.x ?? 0, y: 0, z: (first?.z ?? 0) + 5 } })
    const warn = close.find((entry) => entry.code === 'home-too-close')
    expect(warn?.severity).toBe('warning')
    expect(warn?.field).toBe('巡航线.home')
  })

  it('禁用了检查点 ⇒ 提示覆盖率上限,但放行(是 warning 不是 error)', () => {
    const base = planInspectionRoute(line, { home: launch })
    const disabledId = base.shots[0]?.id ?? ''
    const issues = validateMission({ route: planInspectionRoute(line, { home: launch, disabledShotIds: [disabledId] }) })
    const warn = issues.find((entry) => entry.code === 'points-disabled')
    expect(warn?.severity).toBe('warning')
    expect(warn?.message).toContain(disabledId)
    expect(canRunMission(issues)).toBe(true)
  })

  it('转场高度压不过塔头 ⇒ error,并给出该提到多少', () => {
    const issues = validateMission({ route: planInspectionRoute(line, { home: launch, cruiseAltitudeM: 12 }) })
    const issue = issues.find((entry) => entry.code === 'cruise-too-low')
    expect(issue?.severity).toBe('error')
    expect(issue?.field).toContain('cruiseAltitudeM')
    expect(issue?.fix).toMatch(/\d/)
  })

  it('镜头倍率非法 ⇒ error 且定位到作业方案字段', () => {
    const issues = validateMission({ route: planInspectionRoute(line, { home: launch, lensZoom: 0 }) })
    const issue = issues.find((entry) => entry.code === 'bad-lens-zoom')
    expect(issue?.severity).toBe('error')
    expect(issue?.field).toBe('作业方案.lensZoom')
  })
})
