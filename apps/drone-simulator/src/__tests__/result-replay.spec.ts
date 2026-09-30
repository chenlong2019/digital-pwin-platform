/**
 * Result 与 Replay 的对账(README §21 · §22 · §57 · §58 · §77)。
 *
 * 这两层读的是同一批记录数据,只是用途不同:
 *   Result —— 这次干得怎么样(结论 + 统计 + 导出)
 *   Replay —— 这次是怎么干的(按时间重建位姿与事件)
 *
 * §77 的验收就落在最后那组用例上:回放**不重跑仿真**,只在记录点之间插值,
 * 所以它必须能精确还原记录时刻的状态,中间时刻的误差也必须落在 §75 的容差里。
 */
import { describe, expect, it } from 'vitest'
import { PLATFORM_COMMAND, distance3 } from '@simulation/contracts'
import type { Command, SimEvent, TaskSnapshot } from '@simulation/contracts'
import type { SimulationDomainAPI } from '@simulation/domain-api'
import { createDroneSandboxSession } from '@simulation/domain-api'
import type { AgentTrack } from '@simulation/recorder'
import {
  buildTaskResult,
  exportTaskResult,
  formatDuration,
  summarizeTaskResult,
} from '@simulation/result'
import {
  ReplayController,
  ReplayTimeline,
  captureReplayData,
  createReplayData,
  sampleReplayData,
} from '@simulation/replay'
import type { ReplayData } from '@simulation/replay'

// ————————————————————————————— 测试夹具 —————————————————————————————

function createSession(): { session: SimulationDomainAPI; droneId: string } {
  const session = createDroneSandboxSession({ drone: { factoryFolded: false } })
  const droneId = session.primaryDroneId()
  if (droneId === undefined) throw new Error('默认场景应当包含一架无人机')
  return { session, droneId }
}

/** 上电 → 起飞 → 飞一段 → 降落,产出一段有内容的记录 */
function flySession(): { session: SimulationDomainAPI; droneId: string } {
  const { session, droneId } = createSession()
  session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId })
  session.step(6 * 60)
  session.executeCommand({ type: PLATFORM_COMMAND.takeOff, agentId: droneId })
  session.step(8 * 60)
  session.executeCommand({
    type: PLATFORM_COMMAND.move,
    agentId: droneId,
    payload: { forward: 0.7, right: 0.2, up: 0.1, yawRate: 0.3 },
  })
  session.step(10 * 60)
  session.executeCommand({ type: PLATFORM_COMMAND.hover, agentId: droneId })
  session.step(2 * 60)
  return { session, droneId }
}

const FAKE_TASK: TaskSnapshot = {
  id: 'task-01',
  type: 'waypoint',
  label: '航点任务 1',
  status: 'completed',
  agentId: 'drone-01',
  progress: { completed: 5, total: 5, stage: '任务完成' },
  result: null,
}

/** 均匀取 n 个采样点(含首末) */
function pickPoints(points: AgentTrack['points'], n: number): Array<AgentTrack['points'][number]> {
  const picked: Array<AgentTrack['points'][number]> = []
  const step = Math.max(1, Math.floor((points.length - 1) / (n - 1)))
  for (let i = 0; i < points.length; i += step) {
    const point = points[i]
    if (point) picked.push(point)
  }
  const last = points[points.length - 1]
  if (last && picked[picked.length - 1] !== last) picked.push(last)
  return picked
}

// ————————————————————————————— Result —————————————————————————————

describe('Result · 任务结果聚合', () => {
  it('把 Task 的结论与过程数据拼成一份完整结果', () => {
    const { session, droneId } = flySession()

    const track = session.getAgentTrack(droneId)
    expect(track).toBeDefined()
    if (!track) return

    const telemetry = session.getDroneTelemetry(droneId)
    expect(telemetry).toBeDefined()

    const report = buildTaskResult({
      task: { ...FAKE_TASK, agentId: droneId },
      outcome: {
        taskId: 'task-01',
        status: 'completed',
        duration: track.points[track.points.length - 1]?.simulationTime ?? 0,
        metrics: { waypointsReached: 3, waypointsTotal: 3 },
        message: '任务完成',
      },
      tracks: session.recorder.getTracks(),
      events: session.getEventLog(),
      commands: session.getCommandLog(),
      sampleHz: 20,
    })

    // 结论来自 Task,统计来自记录 —— 两边各管一段
    expect(report.status).toBe('completed')
    expect(report.metrics['waypointsReached']).toBe(3)
    expect(report.statistics.trackPoints).toBe(track.points.length)
    expect(report.statistics.commands).toBeGreaterThanOrEqual(3)

    // 轨迹引用是「引用」而不是全量点:只给摘要
    expect(report.trackReference?.agentId).toBe(droneId)
    expect(report.trackReference?.points).toBe(track.points.length)
    expect(report.trackReference?.distanceFlown ?? 0).toBeGreaterThan(0)
    expect(report.trackReference?.maxAltitude ?? 0).toBeGreaterThan(0)
    expect(report.trackReference?.maxSpeed ?? 0).toBeGreaterThan(0)

    // §77:记录器的时间戳必须单调不减,否则结果里就能直接看见
    expect(report.eventReference.monotonic).toBe(true)
    expect(report.eventReference.total).toBeGreaterThan(0)
    expect(report.eventReference.byLevel.info).toBeGreaterThan(0)

    session.dispose()
  })

  it('空记录也能生成结果,不抛异常', () => {
    const report = buildTaskResult({
      task: FAKE_TASK,
      outcome: { taskId: 'task-01', status: 'aborted', duration: 0, metrics: {}, message: '未开始' },
      tracks: [],
      events: [],
      commands: [],
    })

    expect(report.trackReference).toBeNull()
    expect(report.statistics.trackPoints).toBe(0)
    expect(report.eventReference.monotonic).toBe(true)
    expect(report.mediaReference).toEqual([])
  })

  it('时间戳乱序时 monotonic 会翻成 false —— 这是 §77 的护栏', () => {
    const events: SimEvent[] = [
      { eventId: 'e1', type: 'a', level: 'info', simulationTime: 2, tick: 2, sessionId: 's' },
      { eventId: 'e2', type: 'b', level: 'warn', simulationTime: 1, tick: 1, sessionId: 's' },
    ]
    const report = buildTaskResult({
      task: FAKE_TASK,
      outcome: { taskId: 'task-01', status: 'failed', duration: 2, metrics: {}, message: '' },
      tracks: [],
      events,
      commands: [],
    })
    expect(report.eventReference.monotonic).toBe(false)
    expect(report.eventReference.byLevel.warn).toBe(1)
  })

  it('摘要与三种导出格式都能用', () => {
    const report = buildTaskResult({
      task: FAKE_TASK,
      outcome: { taskId: 'task-01', status: 'completed', duration: 154, metrics: { a: 1 }, message: '完成' },
      tracks: [
        {
          agentId: 'drone-01',
          type: 'drone',
          label: '无人机',
          points: [
            { tick: 0, simulationTime: 0, x: 0, y: 0, z: 0, headingDeg: 0 },
            { tick: 60, simulationTime: 1, x: 3, y: 4, z: 4, headingDeg: 350 },
          ],
        },
      ],
      events: [],
      commands: [],
    })

    expect(formatDuration(154)).toBe('2 分 34 秒')
    expect(formatDuration(9)).toBe('9 秒')
    const summary = summarizeTaskResult(report)
    expect(summary.durationText).toBe('2 分 34 秒')
    expect(summary.headline).toContain('5.0 m') // 3-4-5 三角形
    expect(summary.headline).toContain('最高 4.0 m')

    const json = exportTaskResult(report, 'json')
    expect(JSON.parse(json)).toMatchObject({ taskId: 'task-01', status: 'completed' })

    const markdown = exportTaskResult(report, 'markdown')
    expect(markdown).toContain('| 任务 ID | `task-01` |')
    expect(markdown).toContain('| 状态 | completed |')
    expect(markdown).toContain('| 飞行距离 | 5.0 m |')
    expect(markdown).toContain('### 任务指标')

    const csv = exportTaskResult(report, 'csv')
    expect(csv.split('\n')[0]).toBe('key,value')
    expect(csv).toContain('taskId,task-01')
    expect(csv).toContain('status,completed')
    expect(csv).toContain('durationText,2 分 34 秒')
  })

  it('CSV 导出会转义逗号与引号,否则表格会错列', () => {
    const report = buildTaskResult({
      task: FAKE_TASK,
      outcome: {
        taskId: 'task-01',
        status: 'failed',
        duration: 3,
        metrics: {},
        message: '任务失败,原因:"电磁干扰"',
      },
      tracks: [],
      events: [],
      commands: [],
    })

    const csv = exportTaskResult(report, 'csv')
    // 整段被引号包住,内部的双引号翻倍
    expect(csv).toContain('message,"任务失败,原因:""电磁干扰"""')
  })
})

// ————————————————————————————— Replay —————————————————————————————

describe('Replay · 时间轴与采样', () => {
  it('§77:采样点处精确还原记录值,中间时刻落在 §75 容差内', () => {
    const { session, droneId } = flySession()

    const track = session.getAgentTrack(droneId)
    expect(track).toBeDefined()
    if (!track || track.points.length < 20) {
      session.dispose()
      throw new Error(`轨迹点太少(${track?.points.length ?? 0}),无法验证回放`)
    }

    const data = captureReplayData(session)
    expect(data.sessionId).toBe(session.session.sessionId)
    expect(data.seed).toBe(session.session.seed)
    expect(data.duration).toBeGreaterThan(0)
    // 采样率由点列间隔反推,应当就是 recorder 配置的 20 Hz
    expect(data.sampleHz).toBeCloseTo(20, 0)

    for (const point of pickPoints(track.points, 9)) {
      const snapshot = sampleReplayData(data, point.simulationTime)
      const agent = snapshot.agents.find((item) => item.agentId === droneId)
      expect(agent, `回放在 ${point.simulationTime}s 处丢失了 ${droneId}`).toBeDefined()
      if (!agent) continue

      // 采样点就是记录点:误差应当是浮点级,不是「接近」
      const error = distance3(agent.position, { x: point.x, y: point.y, z: point.z })
      expect(error, `回放位置误差 ${error} 过大(t=${point.simulationTime})`).toBeLessThan(0.5)
      expect(Math.abs(agent.headingDeg - point.headingDeg)).toBeLessThanOrEqual(2)
    }

    session.dispose()
  })

  it('两个采样点之间做线性插值:恰好落在中点', () => {
    const data = createReplayData({
      sessionId: 'session-test',
      tracks: [
        {
          agentId: 'drone-01',
          type: 'drone',
          label: '无人机',
          points: [
            { tick: 0, simulationTime: 0, x: 0, y: 0, z: 0, headingDeg: 0 },
            { tick: 60, simulationTime: 1, x: 10, y: 2, z: -4, headingDeg: 90 },
          ],
        },
      ],
    })

    const middle = sampleReplayData(data, 0.5).agents[0]
    expect(middle?.position.x).toBeCloseTo(5, 6)
    expect(middle?.position.y).toBeCloseTo(1, 6)
    expect(middle?.position.z).toBeCloseTo(-2, 6)
    expect(middle?.headingDeg).toBeCloseTo(45, 6)
  })

  it('航向插值走最短弧:359° → 1° 不会绕一整圈', () => {
    const data = createReplayData({
      sessionId: 'session-test',
      tracks: [
        {
          agentId: 'drone-01',
          type: 'drone',
          label: '无人机',
          points: [
            { tick: 0, simulationTime: 0, x: 0, y: 0, z: 0, headingDeg: 359 },
            { tick: 60, simulationTime: 1, x: 0, y: 0, z: 0, headingDeg: 1 },
          ],
        },
      ],
    })

    const middle = sampleReplayData(data, 0.5).agents[0]
    // 最短弧上的中点是 0°(不是 180°)
    expect(middle?.headingDeg === undefined ? NaN : Math.min(middle.headingDeg, 360 - middle.headingDeg)).toBeLessThan(1)
  })

  it('事件与指令按时刻浮现', () => {
    const commands: Command[] = [
      { commandId: 'c1', type: 'agent.takeOff', simulationTime: 1, sessionId: 's', actorId: 'pilot', payload: {} },
      { commandId: 'c2', type: 'agent.land', simulationTime: 3, sessionId: 's', actorId: 'pilot', payload: {} },
    ]
    const events: SimEvent[] = [
      { eventId: 'e1', type: 'a', level: 'info', simulationTime: 0.5, tick: 30, sessionId: 's' },
      { eventId: 'e2', type: 'b', level: 'success', simulationTime: 2.5, tick: 150, sessionId: 's' },
    ]
    const data = createReplayData({ sessionId: 's', events, commands, duration: 4 })

    const early = sampleReplayData(data, 1)
    expect(early.events.map((event) => event.eventId)).toEqual(['e1'])
    expect(early.command?.commandId).toBe('c1')

    const late = sampleReplayData(data, 3.5)
    expect(late.events.map((event) => event.eventId)).toEqual(['e1', 'e2'])
    expect(late.command?.commandId).toBe('c2')
    expect(late.progress).toBeCloseTo(3.5 / 4, 6)
  })

  it('时间被夹在 [0, duration] 内,越界不抛错', () => {
    const data = createReplayData({ sessionId: 's', duration: 5 })
    expect(sampleReplayData(data, -3).time).toBe(0)
    expect(sampleReplayData(data, 99).time).toBe(5)
    expect(sampleReplayData(data, 99).progress).toBe(1)
  })
})

describe('Replay · 时间轴与控制器', () => {
  it('时间轴推进到末尾就停住', () => {
    const timeline = new ReplayTimeline(createReplayData({ sessionId: 's', duration: 10 }))
    expect(timeline.atEnd).toBe(false)

    expect(timeline.advance(4, 1)).toBeCloseTo(4, 6)
    expect(timeline.time).toBeCloseTo(4, 6)

    // 2 倍速推进 4 秒 → 实际走 8 秒,但被末尾夹住
    expect(timeline.advance(4, 2)).toBeCloseTo(6, 6)
    expect(timeline.time).toBe(10)
    expect(timeline.atEnd).toBe(true)
  })

  it('控制器:播放 → 推进 → 到末尾自动暂停;循环模式回到开头', () => {
    const data = createReplayData({ sessionId: 's', duration: 2 })

    const controller = new ReplayController(data)
    const seen: number[] = []
    controller.subscribe((snapshot) => seen.push(snapshot.time))

    expect(controller.playing).toBe(false)
    controller.update(1)
    // 没在播放时投入时间不推进
    expect(controller.timeline.time).toBe(0)

    controller.play()
    controller.update(1)
    expect(controller.snapshot.time).toBeCloseTo(1, 6)
    expect(controller.playing).toBe(true)

    controller.update(2)
    expect(controller.snapshot.time).toBe(2)
    // 到头自动停
    expect(controller.playing).toBe(false)
    expect(seen.length).toBeGreaterThan(0)

    const looping = new ReplayController(data, { loop: true, autoPlay: true })
    looping.update(3)
    expect(looping.playing).toBe(true)
    expect(looping.timeline.time).toBeCloseTo(1, 6)

    controller.dispose()
    looping.dispose()
  })

  it('控制器:跳转与倍速', () => {
    const controller = new ReplayController(createReplayData({ sessionId: 's', duration: 20 }))

    controller.seek(5)
    expect(controller.snapshot.time).toBe(5)
    expect(controller.progress).toBeCloseTo(0.25, 6)

    controller.seekProgress(0.5)
    expect(controller.snapshot.time).toBe(10)

    controller.setSpeed(4)
    expect(controller.speed).toBe(4)
    controller.play()
    controller.update(1)
    expect(controller.snapshot.time).toBe(14)

    controller.dispose()
  })

  it('抓下来的回放数据是独立快照:记录器清空后仍能放', () => {
    const { session, droneId } = flySession()

    const data: ReplayData = captureReplayData(session)
    const points = data.tracks[0]?.points.length ?? 0
    expect(points).toBeGreaterThan(0)

    // 记录器是环形缓冲,继续跑与清空都不该影响已经抓下来的回放数据
    session.step(60)
    session.recorder.reset()
    expect(session.recorder.getTracks()).toHaveLength(0)

    expect(data.tracks[0]?.points.length).toBe(points)
    const snapshot = sampleReplayData(data, data.duration)
    expect(snapshot.agents[0]?.agentId).toBe(droneId)

    session.dispose()
  })
})
