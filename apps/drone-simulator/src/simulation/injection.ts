/**
 * 沙盒会话的注入点。
 *
 * 会话在页面层创建一次,面板组件通过 inject 取用 —— 避免一路 prop 传递,
 * 也让每个面板可以独立成文件而不需要知道彼此的层级。
 */
import { inject } from 'vue'
import type { InjectionKey } from 'vue'
import type { SandboxSimulation } from './use-sandbox-simulation'

export const SANDBOX_SIMULATION_KEY: InjectionKey<SandboxSimulation> = Symbol('sandbox-simulation')

export function useSandbox(): SandboxSimulation {
  const simulation = inject(SANDBOX_SIMULATION_KEY)
  if (!simulation) {
    throw new Error('useSandbox() 必须在提供了 SANDBOX_SIMULATION_KEY 的页面内使用')
  }
  return simulation
}
