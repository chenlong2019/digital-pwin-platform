/**
 * VirtualStickController —— 框架无关的虚拟摇杆(README §66)。
 *
 *   Keyboard ┐
 *   Joystick ├─→ 通道合成 ─→ StickAxes ─→ InputIntent ─→ Command
 *   Touch    ┘
 *
 * 为什么从 Vue 里拆出来:摇杆量是 Agent 状态,而「哪些输入叠加成了多少量」
 * 这件事本身与界面无关。抽成独立包之后,回放(§22)、MCP(§63)、AI Agent(§69)
 * 可以复用同一条输入通道 —— 它们不需要挂一个 Vue 实例,也不需要认识键盘事件。
 *
 * 宿主(应用层)负责把真实事件喂进来:keydown / keyup / 指针拖拽 / 手柄采样。
 * 本类只回答「现在四个通道各是多少」。
 */
import type { DialAxes, KeyBinding, StickAxes, StickDials, StickSide } from './axes'
import {
  DEFAULT_KEY_BINDINGS,
  IGNORED_INPUT_CODES,
  NEUTRAL_AXES,
  NEUTRAL_DIALS,
  NEUTRAL_KEY,
  clampUnit,
  combineAxes,
  sameAxes,
  sameDials,
} from './axes'

export interface VirtualStickOptions {
  /** 覆盖默认键位表 */
  readonly bindings?: Readonly<Record<string, KeyBinding>>
  /** 不接管的键(宿主有别的用途) */
  readonly ignoredCodes?: ReadonlySet<string>
  /** 归中键 */
  readonly neutralKey?: string
}

/** 一次状态通知:输入层内部状态的完整快照 */
export interface StickState {
  readonly axes: StickAxes
  readonly activeKeys: ReadonlyArray<string>
  readonly dials: StickDials
  /**
   * 本次通知是否由「四通道量变化」引起。
   *
   * 与 dials 变化区分开是必要的:摇杆盘满舵时再按键,通道被夹在 ±1 不再变化,
   * 但旋钮位置确实动了 —— 界面要重画,而**指令不该重发**(摇杆量是状态)。
   */
  readonly axesChanged: boolean
}

export class VirtualStickController {
  private readonly bindings: Readonly<Record<string, KeyBinding>>
  private readonly ignoredCodes: ReadonlySet<string>
  private readonly neutralKey: string
  private readonly pressed = new Map<string, KeyBinding>()
  private readonly listeners = new Set<(state: StickState) => void>()

  private currentAxes: StickAxes = NEUTRAL_AXES
  private currentDials: StickDials = NEUTRAL_DIALS

  constructor(options: VirtualStickOptions = {}) {
    this.bindings = options.bindings ?? DEFAULT_KEY_BINDINGS
    this.ignoredCodes = options.ignoredCodes ?? IGNORED_INPUT_CODES
    this.neutralKey = options.neutralKey ?? NEUTRAL_KEY
  }

  get axes(): StickAxes {
    return this.currentAxes
  }

  get dials(): StickDials {
    return this.currentDials
  }

  get activeKeys(): ReadonlyArray<string> {
    return [...this.pressed.keys()]
  }

  subscribe(listener: (state: StickState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get hasListeners(): boolean {
    return this.listeners.size > 0
  }

  /**
   * 按下一个键。
   * 返回 true 表示本键属于输入层 —— 宿主据此决定要不要 preventDefault,
   * 免得方向键把页面滚走。
   */
  keyDown(code: string): boolean {
    if (code === this.neutralKey) {
      this.reset()
      return true
    }
    if (this.ignoredCodes.has(code)) return false
    const binding = this.bindings[code]
    if (!binding) return false
    // 长按的重复事件不改变按压集合,所以不会重复通知 —— 摇杆量是状态,不是动作
    const changed = !this.pressed.has(code)
    this.pressed.set(code, binding)
    this.commit(changed)
    return true
  }

  keyUp(code: string): boolean {
    if (!this.pressed.delete(code)) return false
    this.commit(true)
    return true
  }

  /** 拖拽摇杆盘。按下/移动/抬起都走这里(抬头发 {x:0,y:0} 自回中) */
  setDial(side: StickSide, value: DialAxes): void {
    const x = clampUnit(value.x)
    const y = clampUnit(value.y)
    const previous = this.currentDials
    const next: StickDials = {
      left: side === 'left' ? { x, y } : previous.left,
      right: side === 'right' ? { x, y } : previous.right,
    }
    this.currentDials = next
    this.commit(!sameDials(previous, next))
  }

  /**
   * 手动归中(空格 / 失焦 / 摇杆台按钮 / 任务结束)。
   * 已经归中时**不补发通知** —— 否则指令日志里会出现一条没有内容的空指令。
   */
  reset(): void {
    const alreadyNeutral =
      this.pressed.size === 0 &&
      sameAxes(this.currentAxes, NEUTRAL_AXES) &&
      sameDials(this.currentDials, NEUTRAL_DIALS)
    this.pressed.clear()
    this.currentDials = NEUTRAL_DIALS
    if (alreadyNeutral) return
    this.currentAxes = NEUTRAL_AXES
    this.publish(true)
  }

  /** 丢弃全部输入并静默回到中位,不通知订阅者(宿主卸载时用) */
  dispose(): void {
    this.pressed.clear()
    this.currentDials = NEUTRAL_DIALS
    this.currentAxes = NEUTRAL_AXES
    this.listeners.clear()
  }

  // ————————————————————————————— 内部 —————————————————————————————

  /**
   * 输入状态变了才通知。
   *
   * 触发条件是「按键集合或盘位变了」而不是「四通道量变了」:盘位已经满舵时再按键,
   * 通道被夹在 ±1 不再变化 —— 界面上的高亮与旋钮该跟着动,但**指令不该重发**。
   * 所以通知里带上 axesChanged,由宿主决定要不要下发。
   */
  private commit(inputChanged: boolean): void {
    const next = combineAxes(this.pressed.values(), this.currentDials)
    const axesChanged = !sameAxes(this.currentAxes, next)
    this.currentAxes = next
    if (!inputChanged && !axesChanged) return
    this.publish(axesChanged)
  }

  private publish(axesChanged: boolean): void {
    const state: StickState = {
      axes: this.currentAxes,
      activeKeys: this.activeKeys,
      dials: this.currentDials,
      axesChanged,
    }
    for (const listener of [...this.listeners]) listener(state)
  }
}
