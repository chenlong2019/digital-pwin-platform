/**
 * 流程图的数据描述 —— 只描述「有什么节点、怎么连」,不碰 vue-flow 的类型。
 *
 * 这样拆的原因:图是**资料**(对应 README 某几节),渲染是**画法**。以后换成别的
 * 绘图库、或者把这些图导出成 mermaid / DOT,都不需要动这份数据。
 */

/** 节点色调 —— 语义而非颜色,配色交给渲染层 */
export type NodeTone =
  /** 已实现 / 主干 */
  | 'solid'
  /** 规划中 / 次要 */
  | 'muted'
  /** 强调(当前这一步) */
  | 'accent'
  /** 需要注意的分支(拒绝、降级) */
  | 'warn'
  /** 终态 */
  | 'done'

export interface NodeSpec {
  readonly id: string
  /** 手摆布局时的坐标。autoLayout 的图会忽略这两个值 */
  readonly x?: number
  readonly y?: number
  readonly label: string
  readonly sublabel?: string
  /** 右上角小标,一般填 README 章节号 */
  readonly ref?: string
  readonly tone?: NodeTone
  /** 节点宽度,默认 168 */
  readonly w?: number
}

export interface EdgeSpec {
  readonly from: string
  readonly to: string
  readonly label?: string
  /** 虚线 = 规划中的依赖,或「非直连」的说明性连线 */
  readonly dash?: boolean
  readonly tone?: NodeTone
}

export interface FlowGraph {
  readonly id: string
  readonly title: string
  /** 一句话说明这张图在讲什么 */
  readonly caption: string
  /** 图对应的 README 章节 */
  readonly refs: string
  /** 主走向:TB = 自上而下,LR = 自左向右 */
  readonly direction: 'TB' | 'LR'
  /**
   * 交给 dagre 自动分层布局。
   *
   * 节点少、走向单一的图手摆更可控;但节点一多、一个节点扇出七八条边时,
   * 手摆必然出现连线穿过节点 —— 这种图交给 dagre 按层级排,以后加包也不用回来调坐标。
   */
  readonly autoLayout?: boolean
  /**
   * 连线样式。直角(smoothstep)适合步骤清晰的流水线;贝塞尔(default)适合
   * 边又多又长的依赖图 —— 直角会在中途拉出一条笔直的长竖线,正好怼在中间的节点上。
   */
  readonly edgeType?: 'smoothstep' | 'default'
  readonly nodes: ReadonlyArray<NodeSpec>
  readonly edges: ReadonlyArray<EdgeSpec>
  /** 画布建议尺寸,用于初始 viewport */
  readonly canvas: { readonly width: number; readonly height: number }
}
