/**
 * useFlightStick —— 键盘 + 摇杆盘合成的虚拟摇杆(美国手 Mode 2)。
 *
 * 关键设计:摇杆量是 **Agent 状态**,不是一次性动作(见 DroneAgent.handleCommand)。
 * 所以这里维护「当前按住了哪些键」与「两个摇杆盘推到哪」,任一变化就重算一遍四个通道;
 * 全部归中时显式发一条 hover 归中 —— 归中这件事由**输入层**决定,
 * 而不是由仿真内核在每个 tick 偷偷替玩家回中。这样指令频率永远不会影响飞行品质。
 *
 * 键位与 firstapp 对齐:W/S 升降、A/D 偏航、↑↓←→ 前后左右。
 */
import { onScopeDispose, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import type { MoveCommandPayload } from '@simulation/contracts'

/** 单通道按满键时的归一化量 */
const CHANNEL_STEP = 0.65
/** 偏航稍小一点,方便对准航点 */
const YAW_STEP = 0.55

/** 键盘虚拟摇杆的通道量。刻意与平台指令载荷同形,输入层不需要再做一次搬运。 */
export type StickAxes = MoveCommandPayload

export const NEUTRAL_AXES: StickAxes = { forward: 0, right: 0, up: 0, yawRate: 0 }

/** 单个摇杆盘的行程(右/上为正,−1~1) */
export interface DialAxes {
  x: number
  y: number
}

/** 左盘 = 偏航/升降,右盘 = 横滚/俯仰(与真机两个自回中摇杆一致) */
export interface StickDials {
  left: DialAxes
  right: DialAxes
}

/** 键位映射:code → 通道与方向 */
const KEY_MAP: Record<string, { channel: keyof StickAxes; sign: number; step: number }> = {
  KeyW: { channel: 'up', sign: 1, step: CHANNEL_STEP },
  KeyS: { channel: 'up', sign: -1, step: CHANNEL_STEP },
  KeyA: { channel: 'yawRate', sign: -1, step: YAW_STEP },
  KeyD: { channel: 'yawRate', sign: 1, step: YAW_STEP },
  ArrowUp: { channel: 'forward', sign: 1, step: CHANNEL_STEP },
  ArrowDown: { channel: 'forward', sign: -1, step: CHANNEL_STEP },
  ArrowLeft: { channel: 'right', sign: -1, step: CHANNEL_STEP },
  ArrowRight: { channel: 'right', sign: 1, step: CHANNEL_STEP },
}

/** 这些键在沙盒里有别的用途,不参与飞行输入 */
const IGNORED_CODES = new Set(['Tab', 'Escape'])

export interface FlightStickOptions {
  /** 通道变化时回调。全部归中时不会触发,改走 onNeutral */
  readonly onChange: (axes: StickAxes) => void
  /** 归中时额外回调一次(用来发 hover,让指令日志语义清楚) */
  readonly onNeutral?: () => void
  /** 为 false 时忽略所有键盘输入 */
  readonly enabled?: Readonly<Ref<boolean>>
}

export interface FlightStick {
  readonly axes: Ref<StickAxes>
  readonly activeKeys: Ref<ReadonlyArray<string>>
  /** 两个摇杆盘的当前行程,界面据此画旋钮位置 */
  readonly dials: StickDials
  /** 拖拽摇杆盘。按下/移动/抬起都走这里(抬头发 {x:0,y:0} 自回中) */
  setDial(side: 'left' | 'right', value: DialAxes): void
  /** 手动归中(空格 / 失焦 / 摇杆台按钮) */
  reset(): void
}

function sameAxes(a: StickAxes, b: StickAxes): boolean {
  return a.forward === b.forward && a.right === b.right && a.up === b.up && a.yawRate === b.yawRate
}

function isNeutral(axes: StickAxes): boolean {
  return axes.forward === 0 && axes.right === 0 && axes.up === 0 && axes.yawRate === 0
}

const clampUnit = (value: number): number => Math.min(1, Math.max(-1, value))

export function useFlightStick(options: FlightStickOptions): FlightStick {
  const axes = ref<StickAxes>(NEUTRAL_AXES)
  const activeKeys = ref<ReadonlyArray<string>>([])
  const dials = reactive<StickDials>({ left: { x: 0, y: 0 }, right: { x: 0, y: 0 } })
  const pressed = new Map<string, { channel: keyof StickAxes; sign: number; step: number }>()

  /**
   * 键盘与摇杆盘合成一路摇杆量 —— 两种输入落在同一通道上相加后夹到 ±1,
   * 所以「按住 D 的同时把左盘推到底」不会超过满舵。
   */
  function combine(): StickAxes {
    const keys: Record<keyof StickAxes, number> = { forward: 0, right: 0, up: 0, yawRate: 0 }
    for (const entry of pressed.values()) {
      keys[entry.channel] = clampUnit(keys[entry.channel] + entry.sign * entry.step)
    }
    return {
      forward: clampUnit(keys.forward + dials.right.y),
      right: clampUnit(keys.right + dials.right.x),
      up: clampUnit(keys.up + dials.left.y),
      yawRate: clampUnit(keys.yawRate + dials.left.x),
    }
  }

  function commit(): void {
    const next = combine()
    if (sameAxes(axes.value, next)) return
    axes.value = next
    if (isNeutral(next)) options.onNeutral?.()
    else options.onChange(next)
  }

  function recompute(): void {
    activeKeys.value = [...pressed.keys()]
    commit()
  }

  function setDial(side: 'left' | 'right', value: DialAxes): void {
    const target = dials[side]
    target.x = clampUnit(value.x)
    target.y = clampUnit(value.y)
    commit()
  }

  function reset(): void {
    const alreadyNeutral = sameAxes(axes.value, NEUTRAL_AXES)
    pressed.clear()
    dials.left.x = 0
    dials.left.y = 0
    dials.right.x = 0
    dials.right.y = 0
    activeKeys.value = []
    // 已归中就不再补一条 hover,免得指令日志里出现空指令
    if (alreadyNeutral) return
    axes.value = NEUTRAL_AXES
    options.onNeutral?.()
  }

  function isBlockedTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    const tag = target.tagName
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (options.enabled && !options.enabled.value) return
    if (isBlockedTarget(event.target)) return
    if (event.code === 'Space') {
      event.preventDefault()
      reset()
      return
    }
    if (IGNORED_CODES.has(event.code) || event.repeat) return
    const mapping = KEY_MAP[event.code]
    if (!mapping) return
    event.preventDefault()
    pressed.set(event.code, mapping)
    recompute()
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (!pressed.delete(event.code)) return
    recompute()
  }

  function onBlur(): void {
    reset()
  }

  const target = window
  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  target.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onBlur)

  onScopeDispose(() => {
    target.removeEventListener('keydown', onKeyDown)
    target.removeEventListener('keyup', onKeyUp)
    target.removeEventListener('blur', onBlur)
    document.removeEventListener('visibilitychange', onBlur)
  })

  return { axes, activeKeys, dials, setDial, reset }
}
