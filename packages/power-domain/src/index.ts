/**
 * @simulation/power-domain —— 电力领域模型包(README §37 · 架构文档 §37–§40)。
 *
 * 它只做一件事:**描述输电资产**。线路、杆塔、由几何推导出的检查部位、以及
 * 资产上真实存在的缺陷(地面真值)。因此它只依赖 `contracts`(§84)——
 * 不认识 Sandbox、不认识 Task、不认识渲染,也不认识任何载具。
 *
 *   power-asset-type        行业口径的枚举与标签(缺陷 / 部件 / 塔型)
 *        ↓
 *   power-tower             杆塔几何 + 缺陷真值(PowerTower / PartDefect)
 *        ↓
 *   power-line              线路台账(PowerLine)+ 平台默认的 220 kV 西岭线
 *        ↓
 *   insulator               绝缘子串常量:同时定「部位观察点」与「导线挂点」
 *        ↓
 *   geometry/power-line-…   纯几何推导:检查部位清单 + 导线段
 *
 * 谁在上游:评价侧(`power-evaluation` 的判定、报告、评分)读它,作业侧
 * (`grid-inspection`,阶段 3 收敛为 `power-mission`)的航线规划与场景装配也读它。
 * 谁不该读:渲染层与沙盒 —— 场景装配由作业侧把这份台账翻成障碍物,而不是反过来。
 */
export * from './power-asset-type'
export * from './power-tower'
export * from './power-line'
export * from './insulator'
export * from './geometry/power-line-geometry'
