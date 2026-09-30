/**
 * 简单场景的无头端到端验证。
 *
 * 这个用例不需要浏览器、不需要 WebGL,却把整条链路都走了一遍:
 *   Command → Authority → Runtime(7 步 tick)→ Agent → Sandbox → Snapshot → Recorder
 *
 * 之所以敢这么断言,是因为仿真内核里没有任何 Math.random / Date.now ——
 * 同 Scenario + 同 Seed + 同 Command 序列必然得到等价结果(README §13)。
 */
import { describe, expect, it } from 'vitest'
import { PLATFORM_COMMAND } from '@simulation/contracts'
import type { SimulationDomainAPI } from '@simulation/domain-api'
import { createDroneSandboxSession } from '@simulation/domain-api'
import type { DroneSnapshot } from '@simulation/drone-agent'
import { readDroneTelemetry } from '@simulation/drone-agent'
import { defaultWaypoints } from '@simulation/task-core'

function createSession(): { session: SimulationDomainAPI; droneId: string } {
  const session = createDroneSandboxSession({ drone: { factoryFolded: false } })
  const droneId = session.primaryDroneId()
  if (droneId === undefined) throw new Error('默认场景应当包含一架无人机')
  return { session, droneId }
}

function droneOf(session: SimulationDomainAPI, droneId: string): DroneSnapshot {
  const telemetry = readDroneTelemetry(session.getAgentState(droneId))
  if (!telemetry) throw new Error('读取无人机遥测失败')
  return telemetry
}

function advance(session: SimulationDomainAPI, seconds: number): void {
  session.step(Math.round(seconds * 60))
}

/** 推进直到条件成立,返回是否在预算内成立 */
function advanceUntil(
  session: SimulationDomainAPI,
  predicate: () => boolean,
  maxSeconds: number,
  chunkSeconds = 1,
): boolean {
  const chunk = Math.round(chunkSeconds * 60)
  const budget = Math.ceil(maxSeconds / chunkSeconds)
  for (let index = 0; index < budget; index += 1) {
    if (predicate()) return true
    session.step(chunk)
  }
  return predicate()
}

describe('简单场景 · 无头端到端', () => {
  it('上电 → 自检 → 起飞 → 航点任务 → 自动降落', () => {
    const { session, droneId } = createSession()

    expect(droneOf(session, droneId).phase).toBe('powerOff')

    session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId })
    expect(
      advanceUntil(session, () => droneOf(session, droneId).phase === 'standby', 15),
      '自检(2.6 s)+ 传感器预热(2.4 s)后应进入地面待机',
    ).toBe(true)

    session.executeCommand({ type: PLATFORM_COMMAND.takeOff, agentId: droneId })
    expect(
      advanceUntil(session, () => droneOf(session, droneId).airborne, 15),
      '一键起飞应当离地',
    ).toBe(true)
    expect(droneOf(session, droneId).altitude).toBeGreaterThan(0.5)

    const taskId = session.createWaypointTask({
      agentId: droneId,
      waypoints: defaultWaypoints(),
      holdSeconds: 1,
      landAtEnd: true,
    })
    expect(taskId).not.toBeNull()
    if (taskId === null) return

    session.startTask(taskId)
    const finished = advanceUntil(
      session,
      () => (session.getTaskResult(taskId)?.status ?? 'pending') !== 'pending' && !droneOf(session, droneId).airborne,
      420,
    )

    const result = session.getTaskResult(taskId)
    expect(finished, `任务应在预算内完成,实际状态:${result?.status ?? 'pending'}`).toBe(true)
    expect(result?.status).toBe('completed')
    // 报告的最大高度高于任何航点高度(最高 16 m)⇒ 途中确实为了飞越障碍物爬升过。
    // 这是回归护栏:如果「探测 → 爬升 → 飞越」被拿掉,1 号航点航线会穿过 13 米高的建筑 A,
    // 机体被避障刹停,任务将超时失败。
    expect(result?.metrics['maxAltitude'] ?? 0).toBeGreaterThan(16)
    expect(result?.metrics['waypointsReached']).toBe(3)
    // 任务结束时机体应已回到地面
    expect(droneOf(session, droneId).airborne).toBe(false)

    // 记录器跟着整条链路工作了:轨迹点、事件、指令都有
    const recorderStats = session.recorderStats
    expect(recorderStats.samples).toBeGreaterThan(0)
    expect(recorderStats.commands).toBeGreaterThanOrEqual(2)
    expect(session.getAgentTrack(droneId)?.points.length ?? 0).toBeGreaterThan(0)

    session.dispose()
  })

  it('同 Seed + 同 Command 序列 ⇒ 等价结果', () => {
    function run(): { x: number; y: number; z: number; battery: number } {
      const { session, droneId } = createSession()
      session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId })
      advance(session, 6)
      session.executeCommand({ type: PLATFORM_COMMAND.takeOff, agentId: droneId })
      advance(session, 10)
      session.executeCommand({
        type: PLATFORM_COMMAND.move,
        agentId: droneId,
        payload: { forward: 0.8, right: 0.2, up: 0.1, yawRate: 0.3 },
      })
      advance(session, 12)
      const telemetry = droneOf(session, droneId)
      const result = {
        x: telemetry.positionX,
        y: telemetry.altitude,
        z: telemetry.positionZ,
        battery: telemetry.batteryPercent,
      }
      session.dispose()
      return result
    }

    const first = run()
    const second = run()

    expect(second.x).toBe(first.x)
    expect(second.y).toBe(first.y)
    expect(second.z).toBe(first.z)
    expect(second.battery).toBe(first.battery)
  })

  it('Authority 拦住非法指令:目标 Agent 不存在时不下发', () => {
    const { session } = createSession()
    const rejected = session.executeCommand({ type: PLATFORM_COMMAND.takeOff, agentId: 'drone-does-not-exist' })
    expect(rejected).toBeNull()
    session.dispose()
  })

  it('未展开机臂时,检查单会拦住起飞', () => {
    // 出厂机臂收纳
    const session = createDroneSandboxSession({ drone: { factoryFolded: true } })
    const droneId = session.primaryDroneId()
    expect(droneId).toBeDefined()
    if (droneId === undefined) return

    session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId })
    advance(session, 6)
    expect(droneOf(session, droneId).phase).toBe('standby')

    session.executeCommand({ type: PLATFORM_COMMAND.takeOff, agentId: droneId })
    advance(session, 6)
    expect(droneOf(session, droneId).airborne).toBe(false)
    expect(droneOf(session, droneId).checklist.some((item) => item.blocking && !item.ok)).toBe(true)

    session.dispose()
  })
})
