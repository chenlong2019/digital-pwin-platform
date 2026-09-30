/**
 * 输入通道与键位映射(README §66)。
 *
 * 这里只放「数据 + 纯函数」:哪些键落到哪个通道、多路输入怎么合成一路摇杆量。
 * 不含任何框架、不含事件监听 —— 那些属于宿主(应用层)的适配工作。
 *
 * 核心约定:摇杆量是 **Agent 状态**而不是一次性动作(见 DroneAgent.handleCommand)。
 * 所以输入层的产物是「当前四个通道各是多少」,而不是「刚才按了一下」。
 * 好处是指令频率永远不会影响飞行品质 —— 归中这件事由输入层显式决定,
 * 而不是由仿真内核在每个 tick 偷偷替玩家回中。
 */
import type { MoveCommandPayload } from '@simulation/contracts'

/**
 * 四通道摇杆量。刻意与平台指令载荷同形,输入层不需要再做一次搬运;
 * 但它是**输入侧**的类型:将来换成手柄、触摸或 AI 直接写入,量的含义不变。
 */
export type StickAxes = MoveCommandPayload

export const NEUTRAL_AXES: StickAxes = { forward: 0, right: 0, up: 0, yawRate: 0 }

/** 单个摇杆盘的行程(右/上为正,−1~1) */
export interface DialAxes {
  readonly x: number
  readonly y: number
}

/** 左盘 = 偏航/升降,右盘 = 横滚/俯仰(与真机两个自回中摇杆一致) */
export interface StickDials {
  readonly left: DialAxes
  readonly right: DialAxes
}

export const NEUTRAL_DIALS: StickDials = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } }

export type StickSide = 'left' | 'right'

export type StickChannel = keyof StickAxes

/** 单通道按满键时的归一化量 */
export const CHANNEL_STEP = 0.65
/** 偏航稍小一点,方便对准航点 */
export const YAW_STEP = 0.55

/** 一个键落在哪个通道上、朝哪个方向、推多少 */
export interface KeyBinding {
  readonly channel: StickChannel
  readonly sign: number
  readonly step: number
}

/**
 * 默认键位(美国手 Mode 2,与 firstapp 对齐):
 * W/S 升降、A/D 偏航、↑↓←→ 前后左右。
 */
export const DEFAULT_KEY_BINDINGS: Readonly<Record<string, KeyBinding>> = {
  KeyW: { channel: 'up', sign: 1, step: CHANNEL_STEP },
  KeyS: { channel: 'up', sign: -1, step: CHANNEL_STEP },
  KeyA: { channel: 'yawRate', sign: -1, step: YAW_STEP },
  KeyD: { channel: 'yawRate', sign: 1, step: YAW_STEP },
  ArrowUp: { channel: 'forward', sign: 1, step: CHANNEL_STEP },
  ArrowDown: { channel: 'forward', sign: -1, step: CHANNEL_STEP },
  ArrowLeft: { channel: 'right', sign: -1, step: CHANNEL_STEP },
  ArrowRight: { channel: 'right', sign: 1, step: CHANNEL_STEP },
}

/** 归中键:一次把键盘与两个摇杆盘全部清回中位 */
export const NEUTRAL_KEY = 'Space'

/** 这些键在宿主里有别的用途,输入层不接管 */
export const IGNORED_INPUT_CODES: ReadonlySet<string> = new Set(['Tab', 'Escape'])

export function clampUnit(value: number): number {
  return Math.min(1, Math.max(-1, value))
}

export function isNeutralAxes(axes: StickAxes): boolean {
  return axes.forward === 0 && axes.right === 0 && axes.up === 0 && axes.yawRate === 0
}

export function sameAxes(a: StickAxes, b: StickAxes): boolean {
  return a.forward === b.forward && a.right === b.right && a.up === b.up && a.yawRate === b.yawRate
}

export function sameDials(a: StickDials, b: StickDials): boolean {
  return (
    a.left.x === b.left.x && a.left.y === b.left.y && a.right.x === b.right.x && a.right.y === b.right.y
  )
}

/**
 * 键盘与摇杆盘合成一路摇杆量 —— 两种输入落在**同一通道上相加**后夹到 ±1,
 * 所以「按住 D 的同时把左盘推到底」不会超过满舵,也不会互相顶掉。
 */
export function combineAxes(pressed: Iterable<KeyBinding>, dials: StickDials): StickAxes {
  let forward = 0
  let right = 0
  let up = 0
  let yawRate = 0
  for (const binding of pressed) {
    const delta = binding.sign * binding.step
    switch (binding.channel) {
      case 'forward':
        forward = clampUnit(forward + delta)
        break
      case 'right':
        right = clampUnit(right + delta)
        break
      case 'up':
        up = clampUnit(up + delta)
        break
      case 'yawRate':
        yawRate = clampUnit(yawRate + delta)
        break
    }
  }
  return {
    forward: clampUnit(forward + dials.right.y),
    right: clampUnit(right + dials.right.x),
    up: clampUnit(up + dials.left.y),
    yawRate: clampUnit(yawRate + dials.left.x),
  }
}
