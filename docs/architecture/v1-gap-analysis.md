# V1 目标架构 · 现状差距分析

> 对照文档：`docs/architecture/无人机巡检.md`（下文所有 `§n` 均指该文档章节）
> 分析对象：本仓库现有实现（17 个包 + 1 个应用）
> 日期：2026-10-09（阶段 1、2 已落地，见 §7）

---

## 0. 一句话结论

**本仓库就是那份文档的实现，不是它的前身、也不是它的替代品。** 所有差距都是
「拆分 / 改名 / 补包」三类，没有一条要求需要重写代码。因此**不新建项目**，
按下文第 6 节的增量顺序推进即可。

---

## 1. 为什么判定为「同一个项目」（证据）

| 证据 | 内容 |
| --- | --- |
| 项目名 | 根 `package.json` 的 `name` = **`simulation-platform`**，与 §1 的目录名逐字相同 |
| 包清单 | 文档列 17 个包；现有 17 个包中有 **15 个逐字重合** |
| 依赖方向 | 现有 `drone-agent` 只依赖 `contracts` —— 比 §77 要求的（`drone-agent → agent-core → contracts`）更干净 |
| 验收 §119-1 | 「换 Agent 不改 Core」**已实际通过**：`vehicle-agent` 已存在，而 `simulation-core` / `task-core` / `recorder` / `result` / `replay` / `three-adapter` 的依赖表中都没有它 |
| 规模 | `packages/*/src` 约 **15.3k 行** TypeScript；单测 173 / e2e 29 / build 全绿 |

新建项目 = 把这 12 个已实现包与全部测试验证作废，再重做一遍同名同构的东西。

---

## 2. 逐包对照

图例：✅ 已达成 · ⚠️ 部分达成 · ❌ 缺失

| §  | 文档包 | 现状 | 差距 |
| --- | --- | --- | --- |
| 4  | `contracts` | ✅ `src/index.ts`（单文件 522 行） | 仅**目录组织**差异：文档要 `common/ agent/ command/ event/ task/ session/ snapshot/ result/` 八个目录，现状是单文件。内容反而更全（多出 `MediaAsset`、`AgentRenderView`、`AgentPartChannel`、`SessionDescriptor`） |
| 5  | `simulation-core` | ✅ `clock.ts` `runtime.ts` `random.ts` `streams.ts` | 达成（`random` / `streams` 是文档没有的确定性基建） |
| 16 | `agent-core` | ✅ `registry.ts` | 达成 |
| 21 | `sandbox-core` | ✅ `sandbox.ts` `raycast.ts` `scenario.ts` | 达成 |
| 23 | `task-core` | ✅ `waypoint-task.ts` | 达成 |
| 27 | `scenario-core` | ⚠️ 部分在 `sandbox-core/scenario.ts` + 应用层 | **需抽包**（或明确决定不做） |
| 29 | `evaluation-core` | ✅ `violation.ts` `metric.ts` `score.ts` `evaluation.ts` `evaluation-result.ts` | **已建**（阶段 2）。文件与 §29 逐个对应；零行业知识，只依赖 `contracts` |
| 30 | `drone-agent` | ✅ `drone-agent.ts` `drone-sim.ts` `aim.ts` | 达成；文档的 `flight/ camera/ gimbal/ battery/` 子目录在现状里是类内聚，未拆文件 |
| 37 | `power-domain` | ✅ `power-asset-type.ts` `power-tower.ts` `power-line.ts` `insulator.ts` `geometry/power-line-geometry.ts` | **已拆出**（阶段 1 落地）。文件布局按 §37，主类型按 §39/§40 定名 `PowerLine` / `PowerTower` |
| 41 | `power-mission` | ⚠️ 剩下 5 个文件仍在 `grid-inspection`（1576 行） | **需拆出 + 改名**（阶段 3） |
| 53 | `power-evaluation` | ✅ `metric/data-quality-metric.ts` `point/inspection-point-result.ts` `report/` `score/mission-score.ts` `mission/inspection-evaluator.ts` | **已拆出**（阶段 2）。比 §53 多一个 `report/`（报告 ≠ 评分，见 §3） |
| 57 | `recorder` | ✅ `recorder.ts` | 达成；文档的 `track/ telemetry/ event/ command/` 子目录未拆 |
| 61 | `result` | ✅ `report.ts` `exporter.ts` | 达成 |
| 62 | `replay` | ✅ `controller.ts` `data.ts` `series.ts` `view.ts` | 达成 |
| 63 | `domain-api` | ✅ `domain-api.ts`（单文件） | 达成；文档的 `scenario/ mission/ inspection/ drone/ result/` 子模块未拆 |
| 65 | `input` | ✅ `axes.ts` `controller.ts` `intent.ts` | 达成 |
| 67 | `three-adapter` | ✅ 11 个文件 | 达成；文档的 `agent/ task/ asset/` 分组在现状里按载体分（`drone-*` / `car-*` / `body-view`） |
| —  | *(文档外)* `vehicle-agent` | ✅ `vehicle-agent.ts` `vehicle-sim.ts` `vehicle-view.ts` | 文档没有；这是**超出目标的增量**，也是 §119-1 的活证据 |

**小结：16 个达标（其中 6 个仅目录组织未细分），1 个待拆/改名（`power-mission`），1 个可选未做（`scenario-core`）。**

---

## 3. 核心工作量：拆 `grid-inspection`

原 `packages/grid-inspection`（拆前 2683 行 / 8 文件）恰好是文档里
`power-domain` + `power-mission` + `power-evaluation` 三个包的**合体态**。
按职责逐文件映射：

| 现有文件 | 应归属 | 依据 | 状态 |
| --- | --- | --- | --- |
| `grid-assets.ts` | **`power-domain`** | 资产台账与地面真值（杆塔、部位、缺陷真值），纯数据 + 几何（§38–§40） | ✅ 阶段 1 已迁出 |
| `grid-scenario.ts` | **`power-mission`**（或留在应用 bootstrap） | 同一份台账 → Sandbox 实体障碍物，要认识 `sandbox-core`；§84 规定 `power-domain` 只依赖 `contracts`，所以它**不能**跟着台账走 | 阶段 3 随 mission 一起过去 |
| `inspection-route.ts` | **`power-mission`** / generator | §51 `InspectionRouteGenerator`：资产几何 → 拍点序列 | 待拆 |
| `flight-control.ts` | **`power-mission`** / execution | 三段控制律（纯函数，可单测） | 待拆 |
| `inspection-task.ts` | **`power-mission`** / execution | §50 `InspectionExecutor`：转场 → 对准 → 采集 → 落记录 | 待拆 |
| `defect-detector.ts` | **`power-evaluation`** / metric | §56 判定 + 成像质量模型 | ✅ 阶段 2 已迁为 `metric/data-quality-metric.ts` |
| `inspection-report.ts` | **`power-evaluation`** + `result` | §56 汇总、`result` 导出 | ✅ 阶段 2 已拆为 `point/inspection-point-result.ts`（记录与对账）+ `report/inspection-report.ts`（汇总与导出）；`result` 收口待定 |

> **一处与初稿的分歧已按文档纠正**：本分析初稿把 `grid-scenario.ts` 也划进了
> `power-domain`。但 §37 / §84 明确写死 `power-domain` 只依赖 `contracts`，
> 而场景装配必须认识 `sandbox-core`（`Scenario` / `ObstacleDefinition`）。
> 因此以文档为准：装配留在作业侧，阶段 3 并入 `power-mission`（§85 允许它依赖 `sandbox-core`）。

`power-domain` 拆出后（阶段 1 已完成），依赖方向自动变干净：

```text
power-domain ───────────────────→ contracts

evaluation-core ────────────────→ contracts

power-evaluation（阶段 2 已拆出）→ contracts · evaluation-core · power-domain · simulation-core

grid-inspection（作业侧，阶段 3 收敛为 power-mission）
    → contracts · power-domain · power-evaluation · sandbox-core · simulation-core
```

**一处必须用端口解决的真实环**：作业侧每采集一个部位就要调一次 `detect()`，
而报告要读航线 —— 直接互引就成了 `grid-inspection ⇄ power-evaluation`。
解法不是绕开，而是把评价侧的依赖**收窄成一个「事实面」**：
`power-evaluation/report/inspection-route-facts.ts` 只声明它需要读的几项
（航线 id / 标签、线路台账、部位清单 id 与塔号、拍点数、转场里程）。
`InspectionRoute` 结构上完全满足它，所以作业侧**直接传航线对象**即可，不用适配、
不用 new。评价侧因此既不认识任务、也不认识沙盒（§54 那句「Input Data → Pure
Evaluation → Result」的落地）。

拆分完成后的目标形态（阶段 3 收尾）：

```text
power-mission ─────────────→ contracts · task-core · sandbox-core · power-domain
power-evaluation ──────────→ contracts · evaluation-core · result · power-mission
```

注意 §78 的硬约束：`power-mission` **不要**直接依赖 `drone-agent`，
只经 `CommandBus` 驱动机体。现有 `grid-inspection` 已经遵守（它依赖的是
`contracts` / `sandbox-core` / `simulation-core`，不是 `drone-agent`），
拆分时保持这一条即可。

---

## 4. 需要新建的包

| 包 | 内容 | 说明 |
| --- | --- | --- |
| `evaluation-core` | ✅ **已落地（阶段 2）**：`violation.ts` `metric.ts` `score.ts` `evaluation.ts` `evaluation-result.ts` | §29。契约与实现分开：这篇契约不认识任何行业，`power-evaluation` 是它的第一个实现者 |
| `power-evaluation` | ✅ **已落地（阶段 2）**：`point/inspection-point-result.ts` `metric/data-quality-metric.ts` `report/inspection-route-facts.ts` `report/inspection-report.ts` `score/mission-score.ts` `mission/inspection-evaluator.ts` | §53–§56。从 `grid-inspection` 拆出（见 §3）；目录比 §53 多一个 `report/` —— 报告是「交付物」不是「评分」，硬塞进 `score/` 会让下一个读代码的人先困惑一次 |
| `power-domain` | ✅ **已落地（阶段 1）**：`power-asset-type.ts` `power-tower.ts` `power-line.ts` `insulator.ts` `geometry/power-line-geometry.ts`。只依赖 `contracts` |
| `scenario-core` | §27 的 `scenario.ts` `scenario-definition.ts` `scenario-loader.ts` `scenario-saver.ts` `scenario-validator.ts` | 可选。现状 `sandbox-core/scenario.ts` 已承担一部分；是否独立成包取决于要不要「存/读/校验场景」成为公共能力 |

---

## 5. 文档与现状不一致、需要拍板的地方

| # | 事项 | 文档 | 现状 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | 包管理器 | pnpm（§1 `pnpm-workspace.yaml`、§83+ 用 `workspace:*`） | npm workspaces（根 `package.json` 的 `workspaces: ["packages/*","apps/*"]`，依赖写 `*`） | 与「是否新建项目」无关的独立决策。现有链路（`npm install` + `check:arch` + 测试）已跑通，不建议为对齐文档而换 |
| 2 | 应用名 | `apps/drone-inspection`（§69） | `apps/drone-simulator` | 现状名字更宽（同时承载无人机与汽车沙盒）。改名是纯体力活，可延后 |
| 3 | §75 方向表述 | 先写 `simulation-core ↓ task-core`，随后又说 `task-core ↓ simulation-core` 必须禁止 | 两者**平级**，都只依赖 `contracts` | **以 §74 矩阵为准**：`simulation-core` 与 `task-core` 互不依赖。现状已符合，无需改 |
| 4 | 契约扩展 | §4 只列 8 组 | 多出 `MediaAsset`、`AgentRenderView` / `AgentPartChannel` / `AgentLightState`、`SessionDescriptor`、`CommandRejection` | 现状是文档的超集，**保留**。文档 §23 的「媒体不进 Agent Core」正是 `MediaAsset` 的由来 |
| 5 | `SimulationSnapshot` | §4.6 无 `sessionId` | 有 `sessionId` | 保留（快照要能回答「这是哪个会话」） |
| 6 | Safety 归属 | §42 明确「V1 暂放 `power-mission`」，等共用规则出现再抽 `safety-core` | 安全判定散在 `flight-control` / `inspection-task`，**未按 §41 的 `safety/` 结构建模** | 按文档补：先落在 `power-mission/safety/`（`safety-engine` + `rules/`），不急着抽包 |
| 7 | `power-evaluation` 依赖表 | §86 列 `contracts` / `evaluation-core` / `result` / `power-mission` | 实际还需要 `power-domain`（取部位/缺陷标签）与 `simulation-core`（**只**取纯函数 `createSeededRandom`） | 以现状为准并登记进白名单。§54 的本意是「不要依赖 `SimulationRuntime`」—— 取一个确定性纯函数不违背它。`result` 暂未用到（报告自带导出），先留在白名单里不声明 |
| 8 | 评价侧 ↔ 作业侧 | §74 允许 `power-evaluation → power-mission`，禁止反向 | 作业侧每采集一个部位就调一次 `detect()`，两边直接互引即成为环 | 用「事实面端口」收窄评价侧的依赖（见 §3）。阶段 3 若 `power-mission` 建成，可评估是否改回直接引用 `InspectionRoute` —— 现状的端口本身已经是「依赖最小化」，保留也合理 |

---

## 6. 验收标准对照（§119）

| 验收 | 文档要求 | 现状 |
| --- | --- | --- |
| 1 · 换 Agent | 加 `vehicle-agent`，不改 `simulation-core` / `task-core` / `recorder` / `result` / `replay` / `three-adapter` | ✅ **已通过**（无需等到将来） |
| 2 · 换 Renderer | 加 `cesium-adapter`，不改 `simulation-core` / `drone-agent` / `power-mission` / `power-evaluation` | ✅ 结构性满足：`three-adapter` 只依赖 `contracts`，渲染器看到的是中性的 `AgentRenderView`；`power-evaluation` 现在是一个真包，且**不依赖任何渲染器与沙盒** |
| 3 · 换路线算法 | 加 `optimized-route-generator`，不改 `PowerInspectionMission` / `DroneAgent` / `SimulationRuntime` | ⚠️ **待阶段 3**：资产台账（阶段 1）与评价（阶段 2）都已独立，但航线生成仍与任务状态机同处 `grid-inspection` |
| 4 · 迁移 Package | `drone-agent` 复制到新项目后 `install → import → run`，不依赖 Vue/Pinia/Router/Page | ✅ `drone-agent` 只依赖 `contracts`，可直接使用 |
| — · 换评价口径 | （文档 §119 未列，但这是本次拆分换来的能力） | ✅ **已通过**：`score/mission-score.ts` 换达标线与权重、`mission/inspection-evaluator.ts` 换规则，都不触碰飞行与判定。基准工况评分 1.000「良好」、雾天 0.778「一般」——同一份报告可复算 |

---

## 7. 建议的落地顺序

每阶段都可独立验证（`npm run verify` + `npm run test:unit` + e2e），做完一节再进下一节。

| 阶段 | 内容 | 风险 | 影响面 |
| --- | --- | --- | --- |
| **0** | 文档归档 + 本文（已完成） | — | `docs/architecture/` 新增 2 个文件 |
| **1** | ✅ **已完成**：抽 `power-domain`。`grid-assets.ts` 按 §37 拆成 6 个文件迁出，主类型按 §39/§40 改名 `PowerLine` / `PowerTower`；`grid-inspection` 改为依赖它；四处同步全部完成 | 低（纯数据与几何，无行为变更） | 新增 1 包；`grid-inspection` 六处 import 与 `index.ts` 导出调整；应用层 4 处 import 拆到新包；README 包清单 + 架构守卫 MANIFEST + 流程图 |
| **2** | ✅ **已完成**：新建 `evaluation-core`（§29 五个文件，只依赖 `contracts`）+ 抽 `power-evaluation`（判定 / 记录 / 报告 / 评分 / 评价器）。报告侧用「事实面端口」避开与作业侧的环；四处同步全部完成 | 低—中（判定与报告是纯函数，整体搬迁，行为零变更） | 新增 2 包；`grid-inspection` 与 `domain-api` 的 import 改道；新增单测 20 项（`evaluation.spec.ts` 14 + 评价链路 6）；README / MANIFEST / 流程图 / 差分文档 |
| **3** | 余下的 `grid-inspection` 收敛为 `power-mission`（`generator/` + `execution/` + `validator/`），`grid-scenario` 一并过去，并按 §41 补 `safety/` | 中（改名会牵动测试、e2e、README、流程图） | 包重命名；`apps/drone-simulator` 依赖与页面引用 |
| **4** | 可选：`scenario-core` 抽包；`contracts` 拆 8 目录；`domain-api` 拆子模块；`apps` 改名 | 低（纯组织） | 视范围而定 |

阶段 1–3 是「让文档与代码对齐」的实质工作；阶段 4 是锦上添花。

### 每阶段必须同步的四处（本项目既有约定）

1. `scripts/check-architecture.mjs` 的 MANIFEST 白名单（新包要登记 layer / allow / dir）
2. `apps/drone-simulator/src/flow/graphs.ts` 的包依赖图（节点、边、caption 数量）
3. `README.md` 的仓库结构表、页面表、实现状态计数
4. 相应单测与 e2e

> 这四处不同步会在 CI 里直接红掉（`check:arch` + `docs.spec` + `flow-graphs.spec`），
> 属于本项目已经踩过的坑。
