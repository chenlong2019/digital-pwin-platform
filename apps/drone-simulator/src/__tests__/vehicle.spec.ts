import { describe, expect, it } from 'vitest'
import type { AgentUpdateContext, Command, SandboxQuery } from '@simulation/contracts'
import { PLATFORM_COMMAND, createCommand } from '@simulation/contracts'
import type { VehicleAgentOptions } from '@simulation/vehicle-agent'
import {
  DEFAULT_VEHICLE_CONFIG,
  VEHICLE_COMMAND,
  VehicleAgent,
  projectVehicleRenderView,
  readVehicleTelemetry,
} from '@simulation/vehicle-agent'

// ————————————————————————————— 测试脚手架 —————————————————————————————

const FLAT_WORLD: SandboxQuery = {
  id: 'test-sandbox',
  obstacles: [],
  getTerrainHeight: () => 0,
  queryObstacle: () => null,
  raycast: () => null,
  getWind: () => ({ speed: 0, directionDeg: 0 }),
  getWeather: () => 'clear',
  getWaterDepth: () => 0,
  isInsideGeofence: () => true,
}

function command(type: string, payload?: unknown): Command {
  return createCommand({ type, sessionId: 's-test', actorId: 'test', simulationTime: 0, payload })
}

/**
 * 默认一台 Model 3。
 *
 * 覆盖参数里刻意排掉 `id`:测试里车永远是 `vehicle-01`,允许改 id 只会让
 * `{ id: 'vehicle-01', ...options }` 这类写法出现「写了又被覆盖」的歧义。
 */
function makeAgent(overrides: Partial<Omit<VehicleAgentOptions, 'id'>> = {}): VehicleAgent {
  return new VehicleAgent({ id: 'vehicle-01', label: 'Model 3', ...overrides })
}

function context(agent: VehicleAgent, overrides: Partial<AgentUpdateContext> = {}): AgentUpdateContext {
  const sandbox = overrides.sandbox ?? FLAT_WORLD
  return {
    tick: 0,
    simulationTime: 0,
    deltaTime: 1 / 60,
    commands: [],
    sandbox,
    ...overrides,
  }
}

/** 按固定步长推进 N 秒 —— 与内核 60 Hz 的确定性约定一致 */
function runFor(agent: VehicleAgent, seconds: number, sandbox?: SandboxQuery): void {
  const steps = Math.round(seconds * 60)
  // 注意:不能写 { sandbox } —— 那会以显式 undefined 覆盖掉默认的平地世界
  const overrides: Partial<AgentUpdateContext> = sandbox ? { sandbox } : {}
  for (let i = 0; i < steps; i += 1) agent.update(context(agent, overrides))
}

function telemetryOf(agent: VehicleAgent) {
  return readVehicleTelemetry(agent.getSnapshot())!
}

// ————————————————————————————— 行驶 —————————————————————————————

describe('VehicleAgent · 行驶(自行车模型)', () => {
  it('上电后踩油门:车沿正北前进(0° 航向 = −Z),不横漂', () => {
    const agent = makeAgent()
    agent.handleCommand(command(PLATFORM_COMMAND.powerOn))
    agent.handleCommand(command(PLATFORM_COMMAND.move, { forward: 1, right: 0, up: 0, yawRate: 0 }))
    runFor(agent, 3)

    const telemetry = telemetryOf(agent)
    expect(telemetry.powered).toBe(true)
    expect(telemetry.gear).toBe('D')
    expect(telemetry.speedMps).toBeGreaterThan(5)
    // 契约约定:0° = 北 = −Z,所以只有 z 在动,x 必须几乎不动
    expect(telemetry.positionZ).toBeLessThan(-5)
    expect(Math.abs(telemetry.positionX)).toBeLessThan(0.5)
    expect(telemetry.heading).toBeCloseTo(0, 0)
  })

  it('松开油门后靠阻力自然停住,不会倒着溜车', () => {
    const agent = makeAgent()
    agent.handleCommand(command(PLATFORM_COMMAND.powerOn))
    agent.handleCommand(command(PLATFORM_COMMAND.move, { forward: 1, right: 0, up: 0, yawRate: 0 }))
    runFor(agent, 2)
    agent.handleCommand(command(PLATFORM_COMMAND.hover))
    runFor(agent, 30)

    const telemetry = telemetryOf(agent)
    expect(telemetry.speedMps).toBe(0)
    // 阻力只减速不反向:停车后位置不再变化,也没有倒退
    expect(telemetry.positionZ).toBeLessThan(0)
  })

  it('转向用 move 载荷的 right 字段:左转后位置向西偏,航向逆时针走', () => {
    const agent = makeAgent()
    agent.handleCommand(command(PLATFORM_COMMAND.powerOn))
    // right 为负 = 想往左
    agent.handleCommand(command(PLATFORM_COMMAND.move, { forward: 1, right: -1, up: 0, yawRate: 0 }))
    runFor(agent, 2)

    // 前轮打死也不能越过物理限位 —— 显示在仪表上的角度必须说得通
    expect(Math.abs(telemetryOf(agent).steerDeg)).toBeLessThanOrEqual(
      DEFAULT_VEHICLE_CONFIG.maxSteerDeg,
    )
    const telemetry = telemetryOf(agent)
    // 左转 = 朝西(-X)偏;如果实现把左右写反了,这里会立刻红
    expect(telemetry.positionX).toBeLessThan(-0.5)
    // 航向逆时针减少,0° 之后 wrap 到 360 附近(2 秒内转 60~90° 的量级)
    expect(telemetry.heading).toBeGreaterThan(270)
    expect(telemetry.heading).toBeLessThan(359)
    // 前轮转角是负的(左)
    expect(telemetry.steerDeg).toBeLessThan(0)
  })

  it('倒车:forward 为负时自动挂 R,车向南退', () => {
    const agent = makeAgent()
    agent.handleCommand(command(PLATFORM_COMMAND.powerOn))
    agent.handleCommand(command(PLATFORM_COMMAND.move, { forward: -1, right: 0, up: 0, yawRate: 0 }))
    runFor(agent, 2)

    const telemetry = telemetryOf(agent)
    expect(telemetry.gear).toBe('R')
    expect(telemetry.positionZ).toBeGreaterThan(0.5)
    expect(telemetry.speedMps).toBeLessThan(0)
  })

  it('熄火后滑行减速,不能踩油门', () => {
    const agent = makeAgent()
    agent.handleCommand(command(PLATFORM_COMMAND.powerOn))
    agent.handleCommand(command(PLATFORM_COMMAND.move, { forward: 1, right: 0, up: 0, yawRate: 0 }))
    runFor(agent, 2)
    agent.handleCommand(command(PLATFORM_COMMAND.powerOff))
    agent.handleCommand(command(PLATFORM_COMMAND.move, { forward: 1, right: 0, up: 0, yawRate: 0 }))
    const afterIgnitionOff = telemetryOf(agent).speedMps

    runFor(agent, 20)
    const telemetry = telemetryOf(agent)
    // 断电那一刻起油门失效,此后只受阻力:速度单调下降到 0
    expect(telemetry.speedMps).toBe(0)
    expect(telemetry.powered).toBe(false)
    expect(afterIgnitionOff).toBeGreaterThan(0)
  })

  it('撞上实体障碍物会停住,而不是穿过去', () => {
    // 车正前方 3~5 米放一堵墙
    const world: SandboxQuery = {
      ...FLAT_WORLD,
      obstacles: [
        {
          name: 'WALL',
          minX: -3,
          maxX: 3,
          minY: 0,
          maxY: 5,
          minZ: -5,
          maxZ: -3,
          solid: true,
        },
      ],
    }
    const agent = makeAgent()
    agent.handleCommand(command(PLATFORM_COMMAND.powerOn))
    agent.handleCommand(command(PLATFORM_COMMAND.move, { forward: 1, right: 0, up: 0, yawRate: 0 }))
    runFor(agent, 6, world)

    const telemetry = telemetryOf(agent)
    expect(telemetry.speedMps).toBe(0)
    // 车头最多顶到墙沿,不能出现在墙体内部
    expect(telemetry.positionZ).toBeGreaterThan(-5)
  })
})

// ————————————————————————————— 挡位与检查单 —————————————————————————————

describe('VehicleAgent · 挡位', () => {
  it('未停稳时不允许挂 P(真车规则)', () => {
    const agent = makeAgent()
    agent.handleCommand(command(PLATFORM_COMMAND.powerOn))
    agent.handleCommand(command(PLATFORM_COMMAND.move, { forward: 1, right: 0, up: 0, yawRate: 0 }))
    runFor(agent, 2)

    agent.handleCommand(command(VEHICLE_COMMAND.setGear, { gear: 'P' }))
    expect(telemetryOf(agent).gear).toBe('D')
  })

  it('停稳后可以挂 P', () => {
    const agent = makeAgent()
    agent.handleCommand(command(PLATFORM_COMMAND.powerOn))
    agent.handleCommand(command(VEHICLE_COMMAND.setGear, { gear: 'D' }))
    agent.handleCommand(command(VEHICLE_COMMAND.setGear, { gear: 'P' }))
    expect(telemetryOf(agent).gear).toBe('P')
  })

  it('电量耗尽自动驻车,不再接受驱动', () => {
    const agent = makeAgent()
    agent.handleCommand(command(PLATFORM_COMMAND.powerOn))
    agent.handleCommand(command(VEHICLE_COMMAND.forceBattery, { percent: 0.05 }))
    agent.handleCommand(command(PLATFORM_COMMAND.move, { forward: 1, right: 0, up: 0, yawRate: 0 }))
    runFor(agent, 4)

    const telemetry = telemetryOf(agent)
    expect(telemetry.batteryPercent).toBe(0)
    expect(telemetry.gear).toBe('P')
    expect(telemetry.speedMps).toBe(0)
  })
})

// ————————————————————————————— 车身可动件 —————————————————————————————

describe('VehicleAgent · 车身可动件', () => {
  it('车门按机械速度平滑开合,而不是瞬移', () => {
    const agent = makeAgent()
    agent.handleCommand(command(VEHICLE_COMMAND.setDoor, { target: 'FL', open: 1 }))
    agent.update(context(agent))
    // 一个 tick(1/60 s)内只走了 doorSpeedPerSec 的一小步
    const firstTick = telemetryOf(agent).doors.FL
    expect(firstTick).toBeGreaterThan(0)
    expect(firstTick).toBeLessThan(0.1)

    runFor(agent, 1)
    expect(telemetryOf(agent).doors.FL).toBeCloseTo(1, 5)
  })

  it('后视镜与四门互不干扰,可以同时动', () => {
    const agent = makeAgent()
    agent.handleCommand(command(VEHICLE_COMMAND.setDoor, { target: 'all', open: 1 }))
    agent.handleCommand(command(VEHICLE_COMMAND.setMirror, { target: 'all', folded: 1 }))
    runFor(agent, 1.5)

    const telemetry = telemetryOf(agent)
    expect(telemetry.doors.FL).toBeCloseTo(1, 5)
    expect(telemetry.doors.RR).toBeCloseTo(1, 5)
    expect(telemetry.mirrors.L).toBeCloseTo(1, 5)
  })

  it('灯光是一档档位,不是连续量', () => {
    const agent = makeAgent()
    agent.handleCommand(command(VEHICLE_COMMAND.setLights, { pattern: 'hazard' }))
    expect(telemetryOf(agent).lightPattern).toBe('hazard')

    agent.handleCommand(command(VEHICLE_COMMAND.setLights, { pattern: 'low' }))
    expect(telemetryOf(agent).lightPattern).toBe('low')
  })

  it('reset 把车打回未上电的出厂状态', () => {
    const agent = makeAgent()
    agent.handleCommand(command(PLATFORM_COMMAND.powerOn))
    agent.handleCommand(command(VEHICLE_COMMAND.setDoor, { target: 'all', open: 1 }))
    agent.handleCommand(command(PLATFORM_COMMAND.move, { forward: 1, right: 0, up: 0, yawRate: 0 }))
    runFor(agent, 2)

    agent.handleCommand(command(PLATFORM_COMMAND.reset))
    const telemetry = telemetryOf(agent)
    expect(telemetry.powered).toBe(false)
    expect(telemetry.gear).toBe('P')
    expect(telemetry.speedMps).toBe(0)
    expect(telemetry.doors.FL).toBe(0)
    expect(telemetry.odometerM).toBe(0)
  })
})

// ————————————————————————————— 渲染投影 —————————————————————————————

describe('VehicleAgent · 渲染投影', () => {
  it('投影函数产出 parts 通道,车身可动件按具名映射', () => {
    const agent = makeAgent()
    agent.handleCommand(command(PLATFORM_COMMAND.powerOn))
    agent.handleCommand(command(VEHICLE_COMMAND.setDoor, { target: 'FL', open: 1 }))
    agent.handleCommand(command(VEHICLE_COMMAND.setMirror, { target: 'L', folded: 1 }))
    runFor(agent, 1.5)

    const view = projectVehicleRenderView(agent.getSnapshot())
    expect(view).not.toBeNull()
    const parts = view!.rig!.parts!
    expect(parts.door_FL).toBeCloseTo(1, 5)
    expect(parts.door_FR).toBe(0)
    expect(parts.mirror_L).toBeCloseTo(1, 5)
    // 转向与车轮自转走同一条通道
    expect(typeof parts.steer).toBe('number')
    expect(typeof parts.wheelSpin).toBe('number')
    // 汽车永远不「在飞」
    expect(view!.lights!.flying).toBe(false)
    expect(view!.powered).toBe(true)
  })

  it('readVehicleTelemetry 只认 vehicle 类型的快照(防御式收窄)', () => {
    const agent = makeAgent()
    expect(readVehicleTelemetry(agent.getSnapshot())).toBeDefined()

    const droneShaped = { ...agent.getSnapshot(), type: 'drone' as const }
    expect(readVehicleTelemetry(droneShaped)).toBeUndefined()
    expect(readVehicleTelemetry(undefined)).toBeUndefined()
  })
})

// ————————————————————————————— 地形 —————————————————————————————

describe('VehicleAgent · 地形贴合', () => {
  it('车贴地形,坡道上俯仰角反映坡度', () => {
    // 沿 -Z 方向上坡:越往北地势越高,车头应该抬起
    const world: SandboxQuery = {
      ...FLAT_WORLD,
      getTerrainHeight: (x, z) => -z * 0.1,
    }
    const agent = makeAgent()
    agent.handleCommand(command(PLATFORM_COMMAND.powerOn))
    agent.handleCommand(command(PLATFORM_COMMAND.move, { forward: 1, right: 0, up: 0, yawRate: 0 }))
    runFor(agent, 2, world)

    const telemetry = telemetryOf(agent)
    expect(telemetry.altitude).toBeGreaterThan(0)
    // 上坡时前方高、后方低 → 俯仰为正(抬头)
    expect(telemetry.pitchDeg).toBeGreaterThan(3)
  })
})
