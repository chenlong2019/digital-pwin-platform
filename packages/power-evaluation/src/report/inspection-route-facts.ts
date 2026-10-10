/**
 * 航线的「事实面」 —— 报告只读航线的这几项,不读它的其余部分(§51 InspectionRoute)。
 *
 * 为什么要有这层端口,而不是直接 import 航线类型:
 *   文档 §74 允许 `power-evaluation → power-mission`,但**不允许反向**。航线是
 *   任务侧的概念,而「任务」要调用判定与报告(它每采集一个部位就要判一次)。
 *   直接互引就成了环,架构守卫会立刻红。
 *
 *   解法不是绕过去,而是把依赖收窄:评价侧只声明「我需要知道什么」——
 *   航线 id / 标签、线路台账、部位清单、检查点清单(含有效条件与是否启用)、
 *   转场里程。`InspectionRoute` 结构上完全满足它,所以调用方**直接传航线对象即可,
 *   不用适配、不用 new**。评价侧因此彻底不认识任务、状态机与沙盒。
 *
 * 这也是 §54 那句建议的落地:「power-evaluation 应该尽量成为 Input Data →
 * Pure Evaluation → Result」。
 */
import type { PowerLine } from '@simulation/power-domain'

/** 报告只需要「部位属于哪基塔」与「它的全局 id」—— 不需要位姿与拍摄配方 */
export interface InspectionRoutePartRef {
  /** 全局部位 id:`<塔号>/<部位 id>` */
  readonly id: string
  readonly towerId: string
}

/**
 * 检查点的有效条件(§5.1)。
 *
 * 同样只是**结构声明**:作业侧的 `InspectionRequirement` 逐字兼容它,所以传进来
 * 不用适配。评价侧因此不需要 import 作业包 —— 那样就成环了。
 */
export interface RequirementFacts {
  readonly distanceRangeM: readonly [number, number]
  readonly headingToleranceDeg: number
  readonly gimbalToleranceDeg: number
  readonly captureCount: number
}

/** 一个检查点的事实面 —— 够评价侧判「这个点算不算有效采集」 */
export interface InspectionRouteShotFacts {
  readonly id: string
  readonly label: string
  readonly towerId: string
  readonly towerLabel: string
  /** 是否执行(禁用的点仍然在清单里,只是没飞) */
  readonly enabled: boolean
  readonly requirement: RequirementFacts
}

export interface InspectionRouteFacts {
  readonly id: string
  readonly label: string
  /** 线路台账:报告里的塔清单、电压等级、真实缺陷总数都来自它 */
  readonly line: PowerLine
  /** 全部待检部位(只用到 id 与塔号) */
  readonly parts: ReadonlyArray<InspectionRoutePartRef>
  /** 拍点:报告与点位状态都要逐点判,所以这里读到 id / 有效条件 / 是否启用 */
  readonly shots: ReadonlyArray<InspectionRouteShotFacts>
  /** 转场里程(米) */
  readonly transitLengthM: number
}
