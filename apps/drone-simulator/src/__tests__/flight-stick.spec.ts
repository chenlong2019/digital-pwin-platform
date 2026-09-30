/**
 * 应用层宿主的行为约束。
 *
 * 输入逻辑本身(键位映射 / 通道合成 / 夹紧 / 归中语义)已经在
 * `@simulation/input` 里被单独测过(input.spec.ts)。这里只测这一层额外承担的
 * 三件事 —— 也就是「挂到浏览器上」才会出现的问题:
 *   · 真实键盘事件怎么转发、界面 ref 怎么跟着更新
 *   · 输入框里打字不该被当成飞行输入
 *   · 失焦 / 切标签页 / 组件卸载时怎么收干净
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

describe('useFlightStick · 宿主适配', () => {
  it('键盘事件转发给输入层,界面 ref 跟着更新', () => {
    const { stick, changes, dispose } = setup()

    key('keydown', 'KeyD')
    expect(changes).toHaveLength(1)
    expect(stick.axes.value.yawRate).toBeGreaterThan(0)
    expect(stick.activeKeys.value).toEqual(['KeyD'])

    key('keyup', 'KeyD')
    expect(stick.axes.value).toEqual({ forward: 0, right: 0, up: 0, yawRate: 0 })
    expect(stick.activeKeys.value).toHaveLength(0)

    dispose()
  })

  it('摇杆盘拖拽直接反映到界面盘位与通道量上', () => {
    const { stick, changes, dispose } = setup()

    stick.setDial('left', { x: 0.8, y: 0 })
    expect(stick.dials.left.x).toBeCloseTo(0.8, 5)
    expect(stick.axes.value.yawRate).toBeCloseTo(0.8, 5)

    // 松杆回中(StickDial 抬起时发的就是全零)
    stick.setDial('left', { x: 0, y: 0 })
    expect(stick.dials.left.x).toBe(0)
    expect(stick.axes.value.yawRate).toBe(0)

    expect(changes.length).toBeGreaterThan(0)
    dispose()
  })

  it('在输入框里打字不会被当成飞行输入', () => {
    const { changes, dispose } = setup()

    const input = document.createElement('input')
    document.body.append(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }))

    expect(changes).toHaveLength(0)
    input.remove()
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

  it('窗口失焦时自动归中(不会把杆量一直卡在满舵)', () => {
    const { stick, neutrals, dispose } = setup()

    key('keydown', 'ArrowUp')
    expect(stick.axes.value.forward).toBeGreaterThan(0)

    window.dispatchEvent(new Event('blur'))
    expect(stick.axes.value).toEqual({ forward: 0, right: 0, up: 0, yawRate: 0 })
    expect(stick.dials.left.x).toBe(0)
    expect(neutrals).toHaveBeenCalledTimes(1)

    dispose()
  })

  it('卸载后不再监听键盘,也不会再发出指令', () => {
    const { stick, changes, dispose } = setup()

    key('keydown', 'KeyD')
    expect(changes).toHaveLength(1)

    dispose()
    key('keyup', 'KeyD')
    key('keydown', 'KeyW')
    expect(changes).toHaveLength(1)
    expect(stick.axes.value.yawRate).toBeCloseTo(0.55, 5)
  })
})
