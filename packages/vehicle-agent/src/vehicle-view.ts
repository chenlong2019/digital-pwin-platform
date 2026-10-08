/**
 * 轮式载具的渲染投影 —— 把 VehicleSnapshot 收成中性的 AgentRenderView。
 *
 * 这一层是「领域包不认识渲染层」的关键:投影只产出契约层定义的 AgentBodyPose /
 * AgentRigState / AgentLightState,不出现任何 three 术语。于是换渲染器(Cesium)
 * 时这个文件一个字都不用改,换载具时渲染层也一个字都不用改。
 *
 * 车身可动件走 `rig.parts` 具名通道,而不是往 AgentRigState 上加 door_FL 之类的字段 ——
 * 否则每加一种载具契约层都要长新字段,契约会被领域细节撑爆。
 */
import type { AgentRenderView, AgentSnapshot } from '@simulation/contracts'
import { readVehicleTelemetry } from './vehicle-agent'

export function projectVehicleRenderView(agent: AgentSnapshot): AgentRenderView | null {
  const telemetry = readVehicleTelemetry(agent)
  if (!telemetry) return null
  return {
    agentId: agent.id,
    type: agent.type,
    label: agent.label,
    visible: true,
    pose: {
      x: agent.position.x,
      y: agent.position.y,
      z: agent.position.z,
      headingDeg: agent.headingDeg,
      // 汽车的俯仰/横滚来自地形坡度(平地时为 0)
      pitchDeg: telemetry.pitchDeg,
      rollDeg: telemetry.rollDeg,
    },
    rig: {
      motorLoad: telemetry.throttle,
      armFold: 0,
      gimbalPitchDeg: 0,
      gimbalRollDeg: 0,
      gimbalYawDeg: 0,
      cameraZoom: 1,
      parts: {
        door_FL: telemetry.doors.FL,
        door_FR: telemetry.doors.FR,
        door_RL: telemetry.doors.RL,
        door_RR: telemetry.doors.RR,
        mirror_L: telemetry.mirrors.L,
        mirror_R: telemetry.mirrors.R,
        steer: telemetry.steerDeg,
        wheelSpin: telemetry.wheelSpinDeg,
      },
    },
    lights: {
      pattern: telemetry.lightPattern,
      batteryLevel: telemetry.batteryPercent,
      flying: false,
    },
    // 上电与否决定车灯是否工作
    powered: telemetry.powered,
  }
}
