/**
 * useFlightStick —— 把框架无关的 VirtualStickController 挂到浏览器事件上。
 *
 * 真正的输入逻辑(键位映射 / 通道合成 / 夹紧 / 归中)在 `@simulation/input` 里,
 * 这一层只做三件属于宿主的事:
 *   ① 把 keydown / keyup / blur / visibilitychange 转发给控制器
 *   ② 把控制器的状态通知映射成 ref / reactive,供界面渲染
 *   ③ 用 onScopeDispose 把监听器收干净
 *
 * 之所以要拆开:输入是**平台能力**(回放 §22、MCP §63、AI Agent §69 都要用同一条
 * 输入通道),不该长在某个 UI 组件的生命周期里。抽走之后,这里的代码量少了三分之二,
 * 而且输入行为可以在没有浏览器事件的纯 Node 环境里被完整测出来。
 */
import { onScopeDispose, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import type { DialAxes, StickAxes, StickDials } from '@simulation/input'
import { NEUTRAL_AXES, VirtualStickController, isNeutralAxes } from '@simulation/input'

export type { DialAxes, StickAxes, StickDials }
export { NEUTRAL_AXES }

/** 盘位在界面侧是可写的响应式对象(控制器内部仍保持不可变) */
interface MutableDial {
  x: number
  y: number
}

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

export function useFlightStick(options: FlightStickOptions): FlightStick {
  const controller = new VirtualStickController()
  const axes = ref<StickAxes>(NEUTRAL_AXES)
  const activeKeys = ref<ReadonlyArray<string>>([])
  const dials = reactive<{ left: MutableDial; right: MutableDial }>({
    left: { x: 0, y: 0 },
    right: { x: 0, y: 0 },
  })

  const unsubscribe = controller.subscribe((state) => {
    axes.value = state.axes
    activeKeys.value = state.activeKeys
    dials.left.x = state.dials.left.x
    dials.left.y = state.dials.left.y
    dials.right.x = state.dials.right.x
    dials.right.y = state.dials.right.y

    // 旋钮动了但通道被夹在 ±1 时不下发指令 —— 摇杆量是状态,不是动作
    if (!state.axesChanged) return
    if (isNeutralAxes(state.axes)) options.onNeutral?.()
    else options.onChange(state.axes)
  })

  function isBlockedTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    const tag = target.tagName
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (options.enabled && !options.enabled.value) return
    if (isBlockedTarget(event.target)) return
    // 控制器认领了这个键才拦截默认行为,免得方向键把页面滚走
    if (controller.keyDown(event.code)) event.preventDefault()
  }

  function onKeyUp(event: KeyboardEvent): void {
    controller.keyUp(event.code)
  }

  function onBlur(): void {
    controller.reset()
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
    unsubscribe()
    controller.dispose()
  })

  return {
    axes,
    activeKeys,
    dials,
    setDial: (side, value) => controller.setDial(side, value),
    reset: () => controller.reset(),
  }
}
