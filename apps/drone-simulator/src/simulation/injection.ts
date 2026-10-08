/**
 * 沙盒会话的注入点。
 *
 * 会话在页面层创建一次,面板组件通过 inject 取用 —— 避免一路 prop 传递,
 * 也让每个面板可以独立成文件而不需要知道彼此的层级。
 *
 * 注入的**类型**是通用会话能力(SimulationSessionView),不是无人机会话:
 * 视口组件因此对载具一无所知,同一套组件既能画无人机也能画汽车。
 */
import { inject } from 'vue'
import type { InjectionKey } from 'vue'
import type { SandboxSimulation } from './use-sandbox-simulation'
import type { GridInspectionSession } from './use-grid-inspection'
import type { VehicleSimulation } from './use-vehicle-simulation'
import type { SimulationSessionView } from './session-types'

export const SANDBOX_SIMULATION_KEY: InjectionKey<SimulationSessionView> = Symbol('sandbox-simulation')

/**
 * 电网巡检会话的注入点。
 *
 * 为什么要有第二个 key:巡检页除了「通用会话能力」,还需要作业方案、航线、
 * 巡检报告这几项 —— 那些不属于沙盒,只属于巡检。有了它,巡检面板与沙盒面板
 * 之间就不需要靠 props 一路穿透,页面只负责 provide。
 */
export const GRID_INSPECTION_KEY: InjectionKey<GridInspectionSession> = Symbol('grid-inspection')

/** 通用取用 —— 视口等与载具无关的组件用这个 */
export function useSession(): SimulationSessionView {
  const simulation = inject(SANDBOX_SIMULATION_KEY)
  if (!simulation) {
    throw new Error('useSession() 必须在提供了 SANDBOX_SIMULATION_KEY 的页面内使用')
  }
  return simulation
}

/**
 * 无人机专属面板用 —— 取回完整会话(含雷达 / 云台 / 灯光 / 任务读数)。
 *
 * 这里做一次收窄是**有约束前提的**:这些面板只在提供无人机会话的页面里渲染,
 * 汽车场景用的是另一套面板。所以收窄成立,不需要在每个面板里写运行时类型判断。
 */
export function useSandbox(): SandboxSimulation {
  return useSession() as SandboxSimulation
}

/**
 * 汽车专属面板用 —— 取回车辆会话。
 * 理由是上面那条的镜像:车辆面板只在提供汽车会话的页面里渲染。
 */
export function useVehicle(): VehicleSimulation {
  return useSession() as VehicleSimulation
}

/**
 * 电网巡检面板用 —— 取回巡检会话。
 * 同一条约束前提:这些面板只在提供巡检会话的 `/grid` 页里渲染。
 */
export function useGridSession(): GridInspectionSession {
  const simulation = inject(GRID_INSPECTION_KEY)
  if (!simulation) {
    throw new Error('useGridSession() 必须在提供了 GRID_INSPECTION_KEY 的页面内使用')
  }
  return simulation
}
