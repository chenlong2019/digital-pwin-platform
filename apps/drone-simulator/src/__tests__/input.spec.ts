/**
 * 输入层行为约束(README §66)。
 *
 * 这一组测的是 `@simulation/input` 本身 —— 纯逻辑、不挂 Vue、不碰 DOM 事件。
 * 之所以强调这点:输入是平台能力(回放 / MCP / AI Agent 都要复用同一条输入通道),
 * 所以它必须能在没有浏览器环境的宿主里跑起来。
 *
 * 核心约定:摇杆量是 **Agent 状态**,不是一次性动作 ——
 * 按住键只产生一次通道变化;松开才归中;多种输入同通道相加并被夹在 ±1 内。
 */
import { describe, expect, it, vi } from 'vitest'
import { PLATFORM_COMMAND } from '@simulation/contracts'
import type { StickState } from '@simulation/input'
import {
  DEFAULT_KEY_BINDINGS,
  NEUTRAL_AXES,
  VirtualStickController,
  combineAxes,
  intentCommandType,
  intentFromAxes,
  intentToCommand,
  isNeutralAxes,
  moveIntent,
  resetIntent,
} from '@simulation/input'

/** 收集控制器的每一次状态通知 */
function setup(): {
  controller: VirtualStickController
  states: StickState[]
  /** 只有「四通道量变化」的那些通知 —— 对应应用层真正会下发指令的次数 */
  axisChanges: StickState[]
  dispose: () => void
} {
  const controller = new VirtualStickController()
  const states: StickState[] = []
  const axisChanges: StickState[] = []
  const unsubscribe = controller.subscribe((state) => {
    states.push(state)
    if (state.axesChanged) axisChanges.push(state)
  })
  return {
    controller,
    states,
    axisChanges,
    dispose: () => {
      unsubscribe()
      controller.dispose()
    },
  }
}

describe('通道合成', () => {
  it('同通道的按键叠加后夹在 ±1 内', () => {
    const w = DEFAULT_KEY_BINDINGS['KeyW']
    const arrowUp = DEFAULT_KEY_BINDINGS['ArrowUp']
    if (!w || !arrowUp) throw new Error('默认键位表缺少 W / ↑')

    // 两个键落在不同通道上
    const axes = combineAxes([w, arrowUp], { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } })
    expect(axes.up).toBeCloseTo(0.65, 5)
    expect(axes.forward).toBeCloseTo(0.65, 5)

    // 同通道叠加三次:夹到 1 而不是 1.95
    const same = combineAxes([w, w, w], { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } })
    expect(same.up).toBe(1)
  })

  it('左右盘各自映射到不同通道:左=偏航/升降,右=横滚/俯仰', () => {
    const axes = combineAxes([], { left: { x: 1, y: -0.5 }, right: { x: 0.25, y: 1 } })
    expect(axes.yawRate).toBeCloseTo(1, 5)
    expect(axes.up).toBeCloseTo(-0.5, 5)
    expect(axes.right).toBeCloseTo(0.25, 5)
    expect(axes.forward).toBeCloseTo(1, 5)
  })
})

describe('VirtualStickController', () => {
  it('按住 D 只发偏航,松开归中', () => {
    const { controller, axisChanges, dispose } = setup()

    expect(controller.keyDown('KeyD')).toBe(true)
    expect(axisChanges).toHaveLength(1)
    expect(axisChanges[0]?.axes.yawRate).toBeGreaterThan(0)
    // 偏航是绕垂直轴转:A/D 不该带出任何平移分量
    expect(axisChanges[0]?.axes.forward).toBe(0)
    expect(axisChanges[0]?.axes.right).toBe(0)

    // 长按不会重复发指令 —— 摇杆量是状态,不是动作
    expect(controller.keyDown('KeyD')).toBe(true)
    expect(controller.keyUp('KeyA')).toBe(false)
    expect(axisChanges).toHaveLength(1)

    expect(controller.keyUp('KeyD')).toBe(true)
    expect(controller.axes).toEqual(NEUTRAL_AXES)
    // 归中的那一次通知也算「通道变化」:它要落成一条 hover
    expect(axisChanges).toHaveLength(2)
    expect(isNeutralAxes(axisChanges[1]?.axes ?? NEUTRAL_AXES)).toBe(true)

    dispose()
  })

  it('四个通道互不干扰', () => {
    const { controller, dispose } = setup()

    controller.keyDown('KeyW')
    controller.keyDown('KeyA')
    controller.keyDown('ArrowUp')
    controller.keyDown('ArrowRight')

    expect(controller.axes.up).toBeGreaterThan(0)
    expect(controller.axes.yawRate).toBeLessThan(0)
    expect(controller.axes.forward).toBeGreaterThan(0)
    expect(controller.axes.right).toBeGreaterThan(0)

    controller.keyUp('KeyW')
    expect(controller.axes.up).toBe(0)
    expect(controller.axes.forward).toBeGreaterThan(0)

    dispose()
  })

  it('摇杆盘与键盘落在同一通道上相加,并夹在 ±1 内', () => {
    const { controller, axisChanges, dispose } = setup()

    // 右盘右推 = 横滚/横移
    controller.setDial('right', { x: 0.8, y: 0 })
    expect(controller.axes.right).toBeCloseTo(0.8, 5)

    // 左盘右推 = 偏航(水平旋转),不是横移
    controller.setDial('left', { x: 1, y: 0 })
    expect(controller.axes.yawRate).toBeCloseTo(1, 5)
    expect(controller.axes.right).toBeCloseTo(0.8, 5)

    // 左盘上推 = 升降
    controller.setDial('left', { x: 0, y: 1 })
    expect(controller.axes.up).toBeCloseTo(1, 5)

    // 盘位 + 键位叠加超过满舵时夹到 1
    controller.setDial('left', { x: 1, y: 1 })
    controller.keyDown('KeyD')
    expect(controller.axes.yawRate).toBe(1)

    // 松杆回中:盘归零、键还按着,所以只剩键那一份
    controller.setDial('left', { x: 0, y: 0 })
    expect(controller.axes.yawRate).toBeCloseTo(0.55, 5)
    expect(controller.axes.up).toBe(0)

    controller.keyUp('KeyD')
    expect(controller.axes.yawRate).toBe(0)
    // 右盘还推着,所以横移不受影响
    expect(controller.axes.right).toBeCloseTo(0.8, 5)

    controller.setDial('right', { x: 0, y: 0 })
    expect(controller.axes).toEqual(NEUTRAL_AXES)
    expect(axisChanges.length).toBeGreaterThan(0)

    dispose()
  })

  it('空格立刻归中,键盘与摇杆盘一起清', () => {
    const { controller, dispose } = setup()

    controller.keyDown('ArrowUp')
    controller.setDial('left', { x: 0.6, y: 0 })
    expect(controller.axes.forward).toBeGreaterThan(0)
    expect(controller.axes.yawRate).toBeGreaterThan(0)

    expect(controller.keyDown('Space')).toBe(true)
    expect(controller.axes).toEqual(NEUTRAL_AXES)
    expect(controller.dials.left.x).toBe(0)
    // 空格已清空按键集合,再松开 ArrowUp 不应该又触发一次归中
    expect(controller.keyUp('ArrowUp')).toBe(false)
    expect(controller.activeKeys).toHaveLength(0)

    dispose()
  })

  it('已归中时再归中不补发通知', () => {
    const { controller, states, dispose } = setup()

    controller.reset()
    expect(states).toHaveLength(0)

    controller.keyDown('KeyW')
    const before = states.length
    controller.reset()
    controller.reset()
    // 只有第一次归中产生了通知;第二次已经是中位,不该再发一条空指令
    expect(states.length).toBe(before + 1)

    dispose()
  })

  it('满舵叠加时:旋钮动了要通知,但通道没变就不再下发指令', () => {
    const { controller, states, axisChanges, dispose } = setup()

    // 键盘先按住偏航,再把左盘推到底 —— 通道被夹在 1
    controller.keyDown('KeyD')
    controller.setDial('left', { x: 1, y: 0 })
    expect(controller.axes.yawRate).toBe(1)

    const axisChangesBefore = axisChanges.length
    const statesBefore = states.length

    // 盘位从 1 收到 0.8:摇杆量仍被夹在 1 不变,但旋钮位置确实动了
    controller.setDial('left', { x: 0.8, y: 0 })
    expect(controller.axes.yawRate).toBe(1)
    expect(states.length).toBe(statesBefore + 1)
    expect(axisChanges.length).toBe(axisChangesBefore)
    expect(states[states.length - 1]?.axesChanged).toBe(false)
    expect(states[states.length - 1]?.dials.left.x).toBeCloseTo(0.8, 5)

    dispose()
  })

  it('不认领没有映射的键与保留键', () => {
    const { controller, states, dispose } = setup()

    expect(controller.keyDown('KeyZ')).toBe(false)
    expect(controller.keyDown('Tab')).toBe(false)
    expect(controller.keyDown('Escape')).toBe(false)
    expect(states).toHaveLength(0)

    dispose()
  })

  it('订阅者能收到完整快照,退订后不再收到', () => {
    const controller = new VirtualStickController()
    const listener = vi.fn<(state: StickState) => void>()
    const unsubscribe = controller.subscribe(listener)

    controller.keyDown('KeyW')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0].activeKeys).toEqual(['KeyW'])

    unsubscribe()
    controller.keyUp('KeyW')
    expect(listener).toHaveBeenCalledTimes(1)

    controller.dispose()
  })
})

describe('InputIntent(§66: Input → InputIntent → Command)', () => {
  it('全归中推出 hover,否则推出 move', () => {
    expect(intentFromAxes(NEUTRAL_AXES).kind).toBe('hover')
    expect(intentFromAxes({ forward: 0.5, right: 0, up: 0, yawRate: 0 }).kind).toBe('move')
  })

  it('意图翻译成平台指令,载荷只在 move 时携带', () => {
    const context = {
      sessionId: 'session-01',
      actorId: 'pilot',
      simulationTime: 12.5,
      agentId: 'drone-01',
    }

    const move = intentToCommand(moveIntent({ forward: 1, right: 0, up: 0, yawRate: -1 }), context)
    expect(move.type).toBe(PLATFORM_COMMAND.move)
    expect(move.actorId).toBe('pilot')
    expect(move.agentId).toBe('drone-01')
    expect(move.simulationTime).toBe(12.5)
    expect(move.payload).toEqual({ forward: 1, right: 0, up: 0, yawRate: -1 })

    expect(intentCommandType(resetIntent())).toBe(PLATFORM_COMMAND.reset)
    const hover = intentToCommand(intentFromAxes(NEUTRAL_AXES), context)
    expect(hover.type).toBe(PLATFORM_COMMAND.hover)
  })
})
