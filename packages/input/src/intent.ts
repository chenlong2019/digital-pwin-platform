/**
 * 输入意图 —— 输入层与平台之间的唯一接触面(README §66):
 *
 *   Input → InputIntent → Command
 *
 * 输入层**不直接操作 Agent**(§66 最后一句),也不直接进 Runtime:
 * 它只把「用户/程序想干什么」表达成一条意图,再由 Domain API(§24 唯一业务入口)
 * 落成 Command。这样键盘、摇杆盘、手柄、触摸、回放脚本、AI Agent 走的是同一条路 ——
 * 与 §69「Human 与 AI 走完全相同的路径」是同一件事。
 *
 * 意图是可序列化的纯数据:它不带 Vue 实例、不带监听器,所以能直接进录像、
 * 进回放脚本(§22)、经 WebSocket 发给另一个客户端(§60)。
 */
import type { AgentId, Command, SessionId } from '@simulation/contracts'
import { PLATFORM_COMMAND, createCommand } from '@simulation/contracts'
import type { StickAxes } from './axes'
import { isNeutralAxes } from './axes'

export type InputIntentKind = 'move' | 'hover' | 'reset'

export interface InputIntent {
  readonly kind: InputIntentKind
  /** 仅 kind === 'move' 时有值 */
  readonly axes?: StickAxes
  /** 产生这条意图的输入源:virtual-stick / keyboard / gamepad / replay / ai… */
  readonly source: string
}

export function moveIntent(axes: StickAxes, source = 'input'): InputIntent {
  return { kind: 'move', axes, source }
}

export function hoverIntent(source = 'input'): InputIntent {
  return { kind: 'hover', source }
}

export function resetIntent(source = 'input'): InputIntent {
  return { kind: 'reset', source }
}

/**
 * 由当前摇杆量推导意图。
 * 全归中 ⇒ 悬停(hover,显式归中);否则 ⇒ 移动(move)。
 * 这是输入层对「松手即悬停」这条约定的唯一表达处。
 */
export function intentFromAxes(axes: StickAxes, source = 'virtual-stick'): InputIntent {
  return isNeutralAxes(axes) ? hoverIntent(source) : moveIntent(axes, source)
}

/** 意图对应的平台指令类型(§51 的平台指令词汇表) */
export function intentCommandType(intent: InputIntent): string {
  switch (intent.kind) {
    case 'move':
      return PLATFORM_COMMAND.move
    case 'hover':
      return PLATFORM_COMMAND.hover
    case 'reset':
      return PLATFORM_COMMAND.reset
  }
}

export interface IntentContext {
  readonly sessionId: SessionId
  readonly actorId: string
  /** 下发时刻的仿真时间,不是墙上时钟(§51) */
  readonly simulationTime: number
  readonly agentId?: AgentId
}

/** 把意图落成一条 Command —— 交给 Domain API 提交,输入层到此为止 */
export function intentToCommand(intent: InputIntent, context: IntentContext): Command {
  return createCommand({
    type: intentCommandType(intent),
    sessionId: context.sessionId,
    actorId: context.actorId,
    simulationTime: context.simulationTime,
    agentId: context.agentId,
    payload: intent.kind === 'move' ? intent.axes : {},
  })
}
