/**
 * @simulation/power-evaluation —— 电网巡检的**评价侧**(架构文档 §53–§56)。
 *
 * 它回答三个问题,一个都不多:
 *
 *   point/     一个部位一次采集的**事实**:位姿、观测几何、成像质量、判定、地面真值
 *        ↓
 *   metric/    怎么从这些事实里**判**:成像质量模型 + 确定性漏检/误检
 *        ↓
 *   report/    怎么**汇总与交付**:逐塔小结、覆盖率/召回/精度、JSON / CSV / Markdown
 *        ↓
 *   score/     怎么**打分**:四条指标 → 一个 0~1 的分(evaluation-core 的口径)
 *        ↓
 *   mission/   怎么**评价整场作业**:evaluateInspection → 指标 + 分 + 违规 + 状态
 *
 * 两条边界,是这个包能独立存在的全部理由:
 *
 *   ① **不依赖任务**。航线只按 `report/inspection-route-facts.ts` 的「事实面」读 ——
 *      调用方直接传 `InspectionRoute` 即可(结构兼容),而本包不认识状态机、沙盒与载具。
 *      于是「换巡检执行方式」不需要动这里一行。
 *   ② **不依赖 runtime**。全是纯函数:同输入同输出,不取墙钟、不用随机数
 *      (§54「Input Data → Pure Evaluation → Result」)。所以评价逻辑可以在测试里
 *      对着一份造出来的报告直接跑。
 *
 * 依赖(§74 / §86):`contracts` · `evaluation-core` · `power-domain` · `simulation-core`。
 * `simulation-core` 只用其中的**纯函数** `createSeededRandom`(确定性仿真的硬要求),
 * 不碰 Clock / Runtime —— 与 §54 「不要依赖 SimulationRuntime」是同一件事。
 * §86 里列的 `result` 尚未用到(报告自带导出),等导出统一收口到 `result` 时再接线。
 *
 * 谁在上游:巡检任务每采集一个部位就调一次 `detect`,并在结束时组装报告;
 * 界面读报告与评价(`evaluateInspection`)。任务侧那一半现在是 `grid-inspection`
 * (阶段 3 收敛为 `power-mission`)。
 */
export * from './metric/data-quality-metric'
export * from './point/inspection-point-result'
export * from './point/point-status'
export * from './report/inspection-route-facts'
export * from './report/inspection-report'
export * from './score/mission-score'
export * from './mission/inspection-evaluator'
