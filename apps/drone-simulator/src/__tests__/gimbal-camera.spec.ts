/**
 * 云台与相机的无头验证。
 *
 * 这两样都是**设备状态**:界面拖滑杆、渲染层摆机载相机,底层都是同一条
 * 「Command → Agent → 快照」的通路。这里把这条通路本身钉住 ——
 * 尤其是行程夹取(云台 −90°~+60°、变焦 1~4×)与「投影到渲染视图时
 * cameraZoom 必须跟着走」(机载视角取景靠它)。
 */
import { describe, expect, it } from 'vitest'
import { PLATFORM_COMMAND } from '@simulation/contracts'
import type { SimulationDomainAPI } from '@simulation/domain-api'
import { createDroneSandboxSession } from '@simulation/domain-api'
import type { DroneSnapshot } from '@simulation/drone-agent'
import { DRONE_COMMAND, projectDroneRenderView, readDroneTelemetry } from '@simulation/drone-agent'

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

describe('云台与相机', () => {
  it('俯仰命令下达后立刻反映到快照,并夹在 −90°~+60° 行程内', () => {
    const { session, droneId } = createSession()
    session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId })
    session.step(300)

    // 出厂默认 −10°(略微俯视)
    expect(droneOf(session, droneId).gimbalPitch).toBe(-10)

    session.executeCommand({ type: DRONE_COMMAND.setGimbalPitch, agentId: droneId, payload: { pitch: -90 } })
    session.step(1)
    expect(droneOf(session, droneId).gimbalPitch).toBe(-90)

    session.executeCommand({ type: DRONE_COMMAND.setGimbalPitch, agentId: droneId, payload: { pitch: 0 } })
    session.step(1)
    expect(droneOf(session, droneId).gimbalPitch).toBe(0)

    // 超程:向上到 120° 应被夹到 +60°,向下到 −180° 应被夹到 −90°
    session.executeCommand({ type: DRONE_COMMAND.setGimbalPitch, agentId: droneId, payload: { pitch: 120 } })
    session.step(1)
    expect(droneOf(session, droneId).gimbalPitch).toBe(60)

    session.executeCommand({ type: DRONE_COMMAND.setGimbalPitch, agentId: droneId, payload: { pitch: -180 } })
    session.step(1)
    expect(droneOf(session, droneId).gimbalPitch).toBe(-90)

    session.dispose()
  })

  it('微调云台是相对量', () => {
    const { session, droneId } = createSession()
    session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId })
    session.step(300)

    session.executeCommand({
      type: DRONE_COMMAND.nudgeGimbal,
      agentId: droneId,
      payload: { deltaPitch: -15 },
    })
    session.step(1)
    expect(droneOf(session, droneId).gimbalPitch).toBe(-25)

    session.executeCommand({
      type: DRONE_COMMAND.nudgeGimbal,
      agentId: droneId,
      payload: { deltaPitch: 5, deltaYaw: 3 },
    })
    session.step(1)
    expect(droneOf(session, droneId).gimbalPitch).toBe(-20)
    // 偏航行程只有 ±5°
    expect(Math.abs(droneOf(session, droneId).gimbalYaw)).toBeLessThanOrEqual(5)

    session.dispose()
  })

  it('变焦夹在 1~4×,并随投影进入渲染视图(机载视角取景靠它)', () => {
    const { session, droneId } = createSession()
    session.executeCommand({ type: PLATFORM_COMMAND.powerOn, agentId: droneId })
    session.step(300)

    expect(droneOf(session, droneId).cameraZoom).toBe(1)

    session.executeCommand({ type: DRONE_COMMAND.setZoom, agentId: droneId, payload: { zoom: 2.5 } })
    session.step(1)
    expect(droneOf(session, droneId).cameraZoom).toBe(2.5)

    session.executeCommand({ type: DRONE_COMMAND.setZoom, agentId: droneId, payload: { zoom: 9 } })
    session.step(1)
    expect(droneOf(session, droneId).cameraZoom).toBe(4)

    session.executeCommand({ type: DRONE_COMMAND.setZoom, agentId: droneId, payload: { zoom: 0.2 } })
    session.step(1)
    expect(droneOf(session, droneId).cameraZoom).toBe(1)

    // 渲染适配器不认识无人机遥测,变焦必须由领域层的投影函数带过去
    const agent = session.getAgentState(droneId)
    expect(agent).toBeDefined()
    if (!agent) return
    const view = projectDroneRenderView(agent)
    expect(view?.rig?.cameraZoom).toBe(1)
    expect(view?.rig?.gimbalPitchDeg).toBe(-10)

    session.dispose()
  })
})
