/**
 * 非功能验收(README §75 · §76 · §77)。
 *
 * 这是这套平台唯一真正的卖点所在 —— 模块数量不是。README 通篇承诺:
 *
 *   §75 Determinism:相同 Seed + Scenario + Initial State + Command Sequence
 *                   ⇒ 等价最终结果(Position ≤ 0.5 m / Attitude ≤ 2° / Battery ≤ 1%)
 *   §76 Task 验收:  重复执行确定性测试,Task Success Rate ≥ 99%
 *   §77 Recorder:   Event 不丢失、Command 可追踪、Track 数据完整、时间戳连续
 *   §77 Replay:     在相同输入数据下应与记录状态保持规定容差内一致
 *
 * 这些承诺此前只靠一个「4 个标量相等」的无头用例兜着。这里把它们落成可执行的验收:
 * 每条断言都对着 README 写明的指标,而不是「看起来没问题」。
 *
 * 之所以能在无头环境里测:仿真内核里没有 Math.random / Date.now / 真实帧率 ——
 * 时间只从固定步长来,推进方式(一次大步还是多次小步)因此不影响结果。
 */
import { describe, expect, it } from 'vitest'
import type { MoveCommandPayload, TaskStatus } from '@simulation/contracts'
import { PLATFORM_COMMAND, distance3 } from '@simulation/contracts'
import type { SimulationDomainAPI } from '@simulation/domain-api'
import { createDroneSandboxSession } from '@simulation/domain-api'
import { readDroneTelemetry } from '@simulation/drone-agent'
import { defaultScenario } from '@simulation/sandbox-core'
import { createReplayData, sampleReplayData } from '@simulation/replay'

// ————————————————————————————— 夹具 —————————————————————————————

const TICKS_PER_SECOND = 60

function createSession(): { session: SimulationDomainAPI; droneId: string } {
  const session = createDroneSandboxSession({ drone: { factoryFolded: false } })
  const droneId = session.primaryDroneId()
  if (droneId === undefined) throw new Error('默认场景应当包含一架无人机')
  return { session, droneId }
}

/** 一段固定的命令序列 —— 确定性验收的「相同输入」 */
const COMMAND_SCRIPT: ReadonlyArray<MoveCommandPayload> = [
  { forward: 0.8, right: 0, up: 0, yawRate: 0 },
  { forward: 0.6, right: 0.4, up: 0.2, yawRate: 0.3 },
  { forward: 0, right: 0, up: -0.3, yawRate: 0.8 },
  { forward: 0.5, right: -0.5, up: 0.1, yawRate: -0.4 },
  { forward: 0.7, right: 0.2, up: 0, yawRate: 0 },
]

interface FlightOutcome {
  readonly position: { x: number; y: number; z: number }
  readonly attitude: { pitch: number; roll: number; heading: number }
  readonly battery: number
  readonly trackPoints: number
  readonly events: number
  readonly commands: number
}

/** 跑一遍完整脚本:上电 → 起飞 → 按固定序列机动 → 悬停 */
function runScriptedFlight(): FlightOutcome {
  const { session, droneId } = createSession()

  session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId })
  session.step(6 * TICKS_PER_SECOND)
  session.executeCommand({ type: PLATFORM_COMMAND.takeOff, agentId: droneId })
  session.step(8 * TICKS_PER_SECOND)

  for (const payload of COMMAND_SCRIPT) {
    session.executeCommand({ type: PLATFORM_COMMAND.move, agentId: droneId, payload })
    session.step(90)
  }
  session.executeCommand({ type: PLATFORM_COMMAND.hover, agentId: droneId })
  session.step(2 * TICKS_PER_SECOND)

  const telemetry = readDroneTelemetry(session.getAgentState(droneId))
  if (!telemetry) throw new Error('读取无人机遥测失败')

  const outcome: FlightOutcome = {
    position: { x: telemetry.positionX, y: telemetry.altitude, z: telemetry.positionZ },
    attitude: { pitch: telemetry.tiltPitch, roll: telemetry.tiltRoll, heading: telemetry.heading },
    battery: telemetry.batteryPercent,
    trackPoints: session.getAgentTrack(droneId)?.points.length ?? 0,
    events: session.getEventLog().length,
    commands: session.getCommandLog().length,
  }
  session.dispose()
  return outcome
}

/** 推进到任务不再是 running/pending,返回最终状态 */
function runTaskToEnd(session: SimulationDomainAPI, maxSeconds = 150): TaskStatus {
  for (let second = 0; second < maxSeconds; second += 1) {
    const status = session.getTaskSnapshots()[0]?.status
    if (status === 'completed' || status === 'failed' || status === 'aborted') return status
    session.step(TICKS_PER_SECOND)
  }
  return session.getTaskSnapshots()[0]?.status ?? 'pending'
}

// ————————————————————————————— §75 Determinism —————————————————————————————

describe('§75 Determinism', () => {
  it('相同 Seed / Scenario / 初始状态 / 命令序列 ⇒ 5 次运行结果一致', () => {
    const runs = Array.from({ length: 5 }, () => runScriptedFlight())
    const base = runs[0]
    expect(base).toBeDefined()
    if (!base) return

    for (const [index, run] of runs.entries()) {
      // 先按 README 写明的容差断言 —— 这是验收标准
      expect(
        distance3(run.position, base.position),
        `第 ${index + 1} 次运行位置偏离 ${distance3(run.position, base.position).toFixed(3)} m`,
      ).toBeLessThanOrEqual(0.5)
      expect(
        Math.abs(run.attitude.pitch - base.attitude.pitch),
        `第 ${index + 1} 次运行俯仰角超差`,
      ).toBeLessThanOrEqual(2)
      expect(Math.abs(run.attitude.roll - base.attitude.roll)).toBeLessThanOrEqual(2)
      expect(Math.abs(run.battery - base.battery)).toBeLessThanOrEqual(1)

      // 再断言「实测是严格相等」—— 容差是给不同实现留的余量,不是给本实现留的
      expect(run, `第 ${index + 1} 次运行与基准不完全一致`).toEqual(base)
    }

    expect(base.trackPoints).toBeGreaterThan(0)
    expect(base.commands).toBe(COMMAND_SCRIPT.length + 3)
  })

  it('推进方式不影响结果:一次大步与多次小步等价', () => {
    function run(chunks: ReadonlyArray<number>): number {
      const { session, droneId } = createSession()
      session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId })
      session.executeCommand({ type: PLATFORM_COMMAND.takeOff, agentId: droneId })
      for (const chunk of chunks) session.step(chunk)
      const telemetry = readDroneTelemetry(session.getAgentState(droneId))
      const value = telemetry?.positionX ?? 0
      session.dispose()
      return value
    }

    const total = 600
    const oneShot = run([total])
    const manySmall = run(new Array(total).fill(1) as number[])
    const uneven = run([17, 233, 1, 349])
    expect(manySmall).toBe(oneShot)
    expect(uneven).toBe(oneShot)
  })

  it('固定步长:投入 5 秒真实时间产生 300 个 tick,且不掉步', () => {
    const { session } = createSession()
    session.start()

    const frames = 300
    for (let i = 0; i < frames; i += 1) session.advance(1 / 60)

    const stats = session.stats
    // 浮点累加允许 ±1 步误差,但绝不允许成片丢步
    expect(Math.abs(stats.ticks - frames)).toBeLessThanOrEqual(1)
    expect(stats.droppedSteps, '§75 要求长时间运行不掉步').toBe(0)
    expect(stats.simulationTime).toBeCloseTo(stats.ticks / 60, 6)

    session.dispose()
  })

  it('单帧投入超长时间也不会追帧爆炸(时钟钳制在 maxFrameTime)', () => {
    const { session } = createSession()
    session.start()

    // 切走标签页 10 分钟后回来:真实时间会被钳到 0.25 s,一步最多补 15 tick
    session.advance(600)
    expect(session.stats.ticks).toBeLessThanOrEqual(15)
    expect(session.stats.droppedSteps).toBe(0)

    session.dispose()
  })

  it('随机源可种子化:同 seed 同流,不同 seed 不同流', () => {
    const sample3 = (source: { next(): number }): number[] => [source.next(), source.next(), source.next()]

    const first = createSession()
    const same = createDroneSandboxSession({ drone: { factoryFolded: false } })

    const values = sample3(first.session.runtime.random)
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
    // 同一 seed 重建一条流,前缀应当完全相同 —— 这是 §75 的底座
    expect(sample3(same.runtime.random)).toEqual(values)

    const scenario = defaultScenario()
    const other = createDroneSandboxSession({
      scenario: { ...scenario, seed: scenario.seed + 1 },
      drone: { factoryFolded: false },
    })
    expect(sample3(other.runtime.random)).not.toEqual(values)

    first.session.dispose()
    same.dispose()
    other.dispose()
  })
})

// ————————————————————————————— §76 Task 验收 —————————————————————————————

describe('§76 Task 验收', () => {
  it('重复执行航点任务:成功率 ≥ 99%', () => {
    const attempts = 5
    const statuses: TaskStatus[] = []
    const failures: string[] = []

    for (let i = 0; i < attempts; i += 1) {
      const { session, droneId } = createSession()

      // 真机流程:上电 → 自检 → 预热搜星,然后才轮到任务接管
      session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId })
      session.step(6 * TICKS_PER_SECOND)

      const taskId = session.createWaypointTask({
        agentId: droneId,
        // 单点近航点:把「任务是否成功」与「任务有多耗时」解耦,
        // 免得重复验收被长航线拖成慢测试
        waypoints: [{ id: 'wp-1', label: '近点', x: 8, z: 0, altitude: 4 }],
        holdSeconds: 0.5,
        landAtEnd: true,
      })
      if (taskId === null) throw new Error('创建任务失败')

      session.startTask(taskId)
      statuses.push(runTaskToEnd(session))

      const result = session.getTaskResult(taskId)
      if (result?.status === 'completed') {
        expect(result.metrics['waypointsReached']).toBe(1)
      } else {
        failures.push(`第 ${i + 1} 次:${result?.message ?? '任务未产出结果'}`)
      }
      session.dispose()
    }

    const succeeded = statuses.filter((status) => status === 'completed').length
    const rate = succeeded / attempts
    expect(
      rate,
      `任务成功率 ${(rate * 100).toFixed(0)}%,低于 §76 要求的 99%;${failures.join(' / ')}`,
    ).toBeGreaterThanOrEqual(0.99)
  })
})

// ————————————————————————————— §77 Recorder / Replay —————————————————————————————

describe('§77 Recorder 验收', () => {
  it('Event 不丢失 / Command 可追踪 / Track 完整 / 时间戳连续', () => {
    const { session, droneId } = runScriptedSession()

    // —— Event 不丢失 ——
    // Runtime 发出的事件 eventId 形如 evt-N;记录器另外还会收割领域事件(按 eventId 去重),
    // 所以这里逐个核对 evt-1..evt-N 是否都在日志里,而不是只看总数
    const events = session.getEventLog()
    const runtimeIds = new Set(
      events.filter((event) => /^evt-\d+$/.test(event.eventId)).map((event) => event.eventId),
    )
    expect(runtimeIds.size, 'Runtime 发出的部分事件没进 EventLog').toBe(session.stats.eventsEmitted)

    // —— Command 可追踪 ——
    const types = session.getCommandLog().map((command) => command.type)
    expect(types).toContain(PLATFORM_COMMAND.powerOn)
    expect(types).toContain(PLATFORM_COMMAND.takeOff)
    expect(types).toContain(PLATFORM_COMMAND.move)
    expect(session.getCommandLog().every((command) => command.commandId.startsWith('cmd-'))).toBe(true)

    // —— Track 数据完整 ——
    const track = session.getAgentTrack(droneId)
    expect(track, '记录器没有产出 AgentTrack').toBeDefined()
    if (!track) return
    expect(track.points.length).toBeGreaterThan(30)
    expect(track.type).toBe('drone')

    // —— 时间戳连续:Track / Event / Command 三条日志都必须单调不减 ——
    const tracks = track.points.map((point) => point.simulationTime)
    const eventTimes = events.map((event) => event.simulationTime)
    const commandTimes = session.getCommandLog().map((command) => command.simulationTime)
    for (const [name, series] of [
      ['AgentTrack', tracks],
      ['EventLog', eventTimes],
      ['CommandLog', commandTimes],
    ] as const) {
      for (let i = 1; i < series.length; i += 1) {
        expect(
          (series[i] ?? 0) >= (series[i - 1] ?? 0),
          `${name} 时间戳在 ${i} 处倒退了`,
        ).toBe(true)
      }
    }

    // —— 采样率:§77 建议 20 Hz ——
    const first = track.points[0]
    const last = track.points[track.points.length - 1]
    if (first && last) {
      const span = last.simulationTime - first.simulationTime
      const hz = (track.points.length - 1) / span
      expect(hz, `实际采样率 ${hz.toFixed(2)} Hz,偏离 §77 建议的 20 Hz`).toBeGreaterThan(19)
      expect(hz).toBeLessThan(21)
    }

    session.dispose()
  })
})

describe('§77 Replay 验收', () => {
  it('回放数据与记录状态在规定容差内一致', () => {
    const { session, droneId } = runScriptedSession()
    const track = session.getAgentTrack(droneId)
    expect(track).toBeDefined()
    if (!track || track.points.length < 10) {
      session.dispose()
      throw new Error('轨迹点不足以验证回放一致性')
    }

    const data = createReplayData({
      sessionId: session.session.sessionId,
      scenarioId: session.session.scenarioId,
      seed: session.session.seed,
      tracks: [track],
      events: session.getEventLog(),
      commands: session.getCommandLog(),
      sampleHz: 20,
    })

    let checked = 0
    let worstDistance = 0
    let worstHeading = 0

    for (let i = 0; i < track.points.length; i += Math.max(1, Math.floor(track.points.length / 12))) {
      const point = track.points[i]
      if (!point) continue
      const agent = sampleReplayData(data, point.simulationTime).agents[0]
      expect(agent, `回放在 t=${point.simulationTime} 处没有该 Agent`).toBeDefined()
      if (!agent) continue

      worstDistance = Math.max(worstDistance, distance3(agent.position, { x: point.x, y: point.y, z: point.z }))
      worstHeading = Math.max(worstHeading, Math.abs(agent.headingDeg - point.headingDeg))
      checked += 1
    }

    expect(checked).toBeGreaterThan(5)
    expect(worstDistance, `回放位置最大偏差 ${worstDistance.toFixed(4)} m`).toBeLessThanOrEqual(0.5)
    expect(worstHeading, `回放航向最大偏差 ${worstHeading.toFixed(4)}°`).toBeLessThanOrEqual(2)

    session.dispose()
  })
})

/** 跑一段有内容的飞行,返回仍然活着的会话(供 §77 的两组用例读记录) */
function runScriptedSession(): { session: SimulationDomainAPI; droneId: string } {
  const { session, droneId } = createSession()
  session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId })
  session.step(6 * TICKS_PER_SECOND)
  session.executeCommand({ type: PLATFORM_COMMAND.takeOff, agentId: droneId })
  session.step(8 * TICKS_PER_SECOND)
  for (const payload of COMMAND_SCRIPT) {
    session.executeCommand({ type: PLATFORM_COMMAND.move, agentId: droneId, payload })
    session.step(60)
  }
  session.executeCommand({ type: PLATFORM_COMMAND.hover, agentId: droneId })
  session.step(TICKS_PER_SECOND)
  return { session, droneId }
}
