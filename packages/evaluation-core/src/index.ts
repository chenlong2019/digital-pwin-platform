/**
 * @simulation/evaluation-core —— 通用评价契约包(架构文档 §29 · §74)。
 *
 * 它回答的是所有行业都会碰到的一个问题:**「这次干得怎么样」用什么词说**。
 * 在它出现之前,这套词是长在业务包里的 —— 每个作业包自己定义「覆盖率」、
 * 自己决定「多少算合格」、自己排告警的轻重。于是同一个平台的两次作业,
 * 结论不可比,也没法换算法。
 *
 *   metric             指标:值(可为缺失)+ 量纲 + 方向 + 达标线 + 权重
 *        ↓
 *   score              评分:以达标线为满分归一化,按权重加权
 *        ↓
 *   violation          违规:固定四档严重度,规则 id + 一句话 + 对象
 *        ↓
 *   evaluation         评价器契约:evaluate(input) → result,必须是纯函数
 *        ↓
 *   evaluation-result  评价结果:指标 / 分 / 违规 / 状态
 *
 * 边界:**它不认识任何行业**。没有杆塔、没有线路、没有无人机 —— 只有「指标」
 * 「违规」「分」这三个中性概念。所以电网巡检的评价(`power-evaluation`)
 * 与将来任何行业的评价共用同一套词,而它自己一行都不用改。
 *
 * 依赖:只有 `contracts`(§74)。没有 SimulationRuntime、没有随机数、没有时钟 ——
 * 评价是「拿着数据算」,不是「跑一遍再看」。
 */
export * from './evaluation'
export * from './metric'
export * from './score'
export * from './violation'
export * from './evaluation-result'
