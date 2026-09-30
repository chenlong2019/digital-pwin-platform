/**
 * 键盘 + 摇杆盘虚拟摇杆的行为约束。
 *
 * 重点验证那条「摇杆是 Agent 状态,不是一次性动作」的设计:
 * 按住键只发一条 move;松开才发归中;多种输入叠加时各通道独立但被夹在 ±1 内。
 *
 * 键位与 firstapp 对齐:W/S 升降、A/D 偏航、↑↓←→ 前后左右。
 */
import { describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import type { StickAxes } from '../simulation/use-flight-stick'
import { useFlightStick } from '../simulation/use-flight-stick'

function setup() {
  const changes: StickAxes[] = []
  const neutrals = vi.fn()
  const scope = effectScope()
  const stick = scope.run(() =>
    useFlightStick({
      onChange: (axes) => changes.push(axes),
      onNeutral: neutrals,
    }),
  )
  if (!stick) throw new Error('effectScope 未返回摇杆实例')
  return { stick, changes, neutrals, dispose: () => scope.stop() }
}

function key(type: 'keydown' | 'keyup', code: string): void {
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }))
}

describe('useFlightStick', () => {
  it('按住 D 只发偏航(水平旋转),松开归中', () => {
    const { stick, changes, neutrals, dispose } = setup()

    key('keydown', 'KeyD')
    expect(changes).toHaveLength(1)
    expect(changes[0]?.yawRate).toBeGreaterThan(0)
    // 偏航是绕垂直轴转:A/D 不该带出任何平移分量
    expect(changes[0]?.forward).toBe(0)
    expect(changes[0]?.right).toBe(0)

    // 长按不会重复发指令 —— 摇杆量是状态,不是动作
    key('keydown', 'KeyD')
    key('keyup', 'KeyA')
    expect(changes).toHaveLength(1)

    key('keyup', 'KeyD')
    expect(stick.axes.value).toEqual({ forward: 0, right: 0, up: 0, yawRate: 0 })
    expect(neutrals).toHaveBeenCalledTimes(1)

    dispose()
  })

  it('四个通道互不干扰', () => {
    const { stick, dispose } = setup()

    key('keydown', 'KeyW')
    key('keydown', 'KeyA')
    key('keydown', 'ArrowUp')
    key('keydown', 'ArrowRight')

    expect(stick.axes.value.up).toBeGreaterThan(0)
    expect(stick.axes.value.yawRate).toBeLessThan(0)
    expect(stick.axes.value.forward).toBeGreaterThan(0)
    expect(stick.axes.value.right).toBeGreaterThan(0)

    key('keyup', 'KeyW')
    expect(stick.axes.value.up).toBe(0)
    expect(stick.axes.value.forward).toBeGreaterThan(0)

    dispose()
  })

  it('摇杆盘与键盘落在同一通道上相加,并夹在 ±1 内', () => {
    const { stick, changes, dispose } = setup()

    // 右盘右推 = 横滚/横移
    stick.setDial('right', { x: 0.8, y: 0 })
    expect(stick.axes.value.right).toBeCloseTo(0.8, 5)

    // 左盘右推 = 偏航(水平旋转),不是横移
    stick.setDial('left', { x: 1, y: 0 })
    expect(stick.axes.value.yawRate).toBeCloseTo(1, 5)
    expect(stick.axes.value.right).toBeCloseTo(0.8, 5)

    // 左盘上推 = 升降
    stick.setDial('left', { x: 0, y: 1 })
    expect(stick.axes.value.up).toBeCloseTo(1, 5)

    // 盘位 + 键位叠加超过满舵时夹到 1
    stick.setDial('left', { x: 1, y: 1 })
    key('keydown', 'KeyD')
    expect(stick.axes.value.yawRate).toBe(1)

    // 松杆回中:盘归零、键还按着,所以只剩键那一份
    stick.setDial('left', { x: 0, y: 0 })
    expect(stick.axes.value.yawRate).toBeCloseTo(0.55, 5)
    expect(stick.axes.value.up).toBe(0)

    key('keyup', 'KeyD')
    expect(stick.axes.value.yawRate).toBe(0)
    // 右盘还推着,所以横移不受影响
    expect(stick.axes.value.right).toBeCloseTo(0.8, 5)

    stick.setDial('right', { x: 0, y: 0 })
    expect(stick.axes.value).toEqual({ forward: 0, right: 0, up: 0, yawRate: 0 })
    expect(changes.length).toBeGreaterThan(0)

    dispose()
  })

  it('空格立刻归中,键盘与摇杆盘一起清', () => {
    const { stick, dispose } = setup()

    key('keydown', 'ArrowUp')
    stick.setDial('left', { x: 0.6, y: 0 })
    expect(stick.axes.value.forward).toBeGreaterThan(0)
    expect(stick.axes.value.yawRate).toBeGreaterThan(0)

    key('keydown', 'Space')
    expect(stick.axes.value).toEqual({ forward: 0, right: 0, up: 0, yawRate: 0 })
    expect(stick.dials.left.x).toBe(0)
    // 空格已清空按键集合,再松开 ArrowUp 不应该又触发一次归中
    key('keyup', 'ArrowUp')
    expect(stick.activeKeys.value).toHaveLength(0)

    dispose()
  })

  it('enabled 为 false 时忽略输入', () => {
    const changes: StickAxes[] = []
    const scope = effectScope()
    const stick = scope.run(() => useFlightStick({ onChange: (axes) => changes.push(axes), enabled: ref(false) }))
    if (!stick) throw new Error('effectScope 未返回摇杆实例')

    key('keydown', 'KeyW')
    expect(changes).toHaveLength(0)
    expect(stick.activeKeys.value).toHaveLength(0)

    scope.stop()
  })
})
