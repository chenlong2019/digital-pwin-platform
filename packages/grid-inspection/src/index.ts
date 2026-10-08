/**
 * @simulation/grid-inspection —— 电网巡检行业能力包。
 *
 * 它是 README §31「领域 Agent Packages」之外的另一类领域包:不是某种载具,
 * 而是**某个行业的作业能力**。所以它落在 Capability 层、只依赖 contracts /
 * sandbox-core / simulation-core —— 换载具不受影响:今天的任务是无人机飞的,
 * 明天换成机器人沿线走,任务实现换掉即可,资产模型、检测器、报告一个字不用改。
 *
 * 一条完整的链路,六个模块各管一段:
 *
 *   grid-assets      资产台账与地面真值(缺陷藏在哪、部位长什么样)
 *        ↓
 *   inspection-route 航线规划:资产几何 → 拍点序列(Route,与 AgentTrack 相对)
 *        ↓
 *   flight-control   三段控制律:飞过去 / 转机身 / 按住悬停位(纯函数,可单测)
 *        ↓
 *   inspection-task  GridInspectionTask:转场 → 对准 → 采集 → 落记录
 *        ↓
 *   defect-detector  判定:成像质量模型 + 确定性漏检/误检(同种子必然同结论)
 *        ↓
 *   inspection-report 汇总与导出:覆盖率 / 召回 / 精度 / 缺陷清单(JSON / CSV / Markdown)
 *
 *   grid-scenario    场景装配:同一份台账 → Sandbox 的实体障碍物
 *
 * 唯一「是假的」的地方是 `defect-detector`:真实系统那里是视觉模型或人工看图。
 * 它被刻意做成可替换的纯函数,并且把「为什么没看出来」量化成成像质量,
 * 这样换算法时上层的航线、任务、报告都不用动。
 */
export * from './grid-assets'
export * from './inspection-route'
export * from './flight-control'
export * from './defect-detector'
export * from './inspection-report'
export * from './inspection-task'
export * from './grid-scenario'
