/**
 * @simulation/grid-inspection —— 电网巡检的**作业侧**(ARCHITECTURE §41 / §50 / §51)。
 *
 * 它是 README §31「领域 Agent Packages」之外的另一类领域包:不是某种载具,
 * 而是**某个行业的作业能力**。所以它落在 Capability 层、不依赖任何载体包 ——
 * 换载具不受影响:今天的任务是无人机飞的,明天换成机器人沿线走,任务实现换掉即可,
 * 资产模型、判定器、报告一个字不用改。
 *
 * 一条完整的链路,现在分成两个包,各管一段:
 *
 *   power-domain      资产台账与地面真值(Domain · 只依赖 contracts)
 *        ↓
 *   inspection-route  航线规划:资产几何 → 拍点序列(Route,与 AgentTrack 相对)
 *        ↓
 *   flight-control    三段控制律:飞过去 / 转机身 / 按住悬停位(纯函数,可单测)
 *        ↓
 *   inspection-task   GridInspectionTask:转场 → 对准 → 采集 → 落记录
 *        ↓
 *   grid-scenario     场景装配:同一份台账 → Sandbox 的实体障碍物
 *
 *   ┈┈┈ 以下在 `@simulation/power-evaluation`(评价侧,只读、纯函数)┈┈┈
 *   detect            判定:成像质量模型 + 确定性漏检/误检(同种子必然同结论)
 *   buildInspection…  汇总与导出:覆盖率 / 召回 / 精度 / 缺陷清单(JSON / CSV / Markdown)
 *   evaluateInspection 作业评价:指标 + 评分 + 违规清单
 *
 * 为什么作业与评价要分成两个包:**作业要认识沙盒与任务,评价不需要**。分家之后
 * 「换一套评分口径」与「换一种执行方式」互不影响,而且评价可以在测试里对着一份
 * 造出来的报告直接跑,不用飞一遍。
 *
 * 唯一「是假的」的地方是判定器:真实系统那里是视觉模型或人工看图。它被刻意做成
 * 可替换的纯函数,并且把「为什么没看出来」量化成成像质量,这样换算法时上层的
 * 航线、任务、报告都不用动。
 *
 * ⚠️ 台账本身的类型与函数(`PowerLine` / `PowerTower` / `deriveInspectionParts` / …)
 * 在 `@simulation/power-domain`;判定与报告在 `@simulation/power-evaluation`。
 * 这里**都不转发** —— 需要它们就直接从那个包拿(§105 三层 Export 边界)。
 */
export * from './inspection-route'
export * from './mission-validation'
export * from './flight-control'
export * from './inspection-task'
export * from './grid-scenario'
