/**
 * 平台流程图数据。
 *
 * 每张图对应 README 的某几节,数据口径与代码保持一致:
 *   · 分层依赖 / 包依赖 —— 节点是真实存在的包,边取自 `scripts/check-architecture.mjs`
 *     的 MANIFEST 白名单(那份白名单就是架构守卫强制执行的依赖方向,不是愿望清单)
 *   · Tick / 指令流 / 数据流 —— 步骤顺序取自 `simulation-core/src/runtime.ts`
 *     的 runTick 与 `domain-api` 的 executeCommand
 *
 * 所以这些图是会「过期」的资料:**代码改了要回来改这里**。
 * `src/__tests__/flow-graphs.spec.ts` 会拿包清单跟实际目录对账,漏了会红。
 */
import type { FlowGraph } from './types'

// ————————————————————————————— ① 分层依赖 —————————————————————————————

const layering: FlowGraph = {
  id: 'layering',
  title: '分层依赖',
  caption:
    '六层的职责与依赖方向(README §40 · §41)。箭头恒指向内层:外层认识内层,内层不认识外层,所以换渲染器、换产品都不需要动内核。',
  refs: '§40 六层架构 · §41 总体架构与依赖方向',
  direction: 'TB',
  canvas: { width: 860, height: 680 },
  nodes: [
    { id: 'mcp', x: 0, y: 0, w: 180, label: 'MCP 接入', sublabel: 'AI Agent → Domain API', ref: '§63', tone: 'muted' },
    { id: 'app', x: 220, y: 0, w: 180, label: 'Application 应用层', sublabel: 'drone-simulator', ref: '§27', tone: 'accent' },
    { id: 'api', x: 220, y: 110, w: 180, label: 'Domain API', sublabel: '所有业务操作的统一入口', ref: '§24 · §62' },
    { id: 'cap', x: 0, y: 220, w: 180, label: 'Capability 能力层', sublabel: 'task-core · recorder · input · result · replay', ref: '§32' },
    { id: 'adapter', x: 420, y: 220, w: 200, label: 'Renderer Adapter', sublabel: 'Snapshot → 三维场景', ref: '§64' },
    { id: 'device', x: 640, y: 220, w: 180, label: 'Device Adapter', sublabel: 'Command → 真机 SDK', ref: '§65', tone: 'muted' },
    { id: 'domain', x: 220, y: 330, w: 180, label: 'Domain 领域层', sublabel: 'drone-agent · vehicle-agent', ref: '§31' },
    { id: 'core', x: 0, y: 440, w: 180, label: 'Core 内核', sublabel: 'agent-core · simulation-core', ref: '§30' },
    { id: 'sandbox', x: 440, y: 440, w: 180, label: 'Sandbox 世界', sublabel: '地形 · 障碍 · 环境', ref: '§7 · §50' },
    { id: 'contracts', x: 220, y: 550, w: 180, label: 'Contracts 契约', sublabel: '全层共用的稳定接口', ref: '§44', tone: 'accent' },
  ],
  edges: [
    { from: 'mcp', to: 'api' },
    { from: 'app', to: 'api' },
    { from: 'api', to: 'cap' },
    { from: 'api', to: 'adapter', dash: true, label: 'Snapshot' },
    { from: 'api', to: 'device', dash: true, label: 'Command' },
    { from: 'cap', to: 'domain' },
    { from: 'domain', to: 'core' },
    { from: 'domain', to: 'sandbox' },
    { from: 'core', to: 'contracts' },
    { from: 'sandbox', to: 'contracts' },
  ],
}

// ————————————————————————————— ② 包依赖明细 —————————————————————————————

const packages: FlowGraph = {
  id: 'packages',
  title: '包依赖明细',
  caption:
    '十三个已实现包的真实依赖边(取自架构守卫的白名单)。读法:从左往右是「依赖谁」,所以这一列一列正好是 README 的六层。contracts 被所有包直接依赖(§44),为避免连线淹没图,只画了主干那几条。',
  refs: '§42 Package 静态依赖规则 · §43 Package 依赖矩阵 · §74 架构静态检查',
  direction: 'LR',
  edgeType: 'default',
  canvas: { width: 1360, height: 880 },
  nodes: [
    { id: 'app', x: 0, y: 280, w: 176, label: 'drone-simulator', sublabel: 'Application · 唯一 UI 宿主', ref: '§27', tone: 'accent' },
    { id: 'api', x: 200, y: 280, w: 176, label: 'domain-api', sublabel: 'API · Session / Command / Task', ref: '§24' },
    { id: 'three', x: 200, y: 520, w: 176, label: 'three-adapter', sublabel: 'Adapter · 只依赖 contracts', ref: '§64' },
    { id: 'drone', x: 400, y: 20, w: 176, label: 'drone-agent', sublabel: 'Domain · 无人机能力', ref: '§31' },
    { id: 'vehicle', x: 400, y: 740, w: 176, label: 'vehicle-agent', sublabel: 'Domain · 轮式载具', ref: '§31' },
    { id: 'task', x: 400, y: 140, w: 176, label: 'task-core', sublabel: 'Capability · 领域无关', ref: '§10' },
    { id: 'recorder', x: 400, y: 260, w: 176, label: 'recorder', sublabel: 'Capability · 过程记录', ref: '§20' },
    { id: 'result', x: 400, y: 380, w: 176, label: 'result', sublabel: 'Capability · TaskResult 聚合', ref: '§21 · §57' },
    { id: 'replay', x: 400, y: 500, w: 176, label: 'replay', sublabel: 'Capability · 历史回放', ref: '§22 · §58' },
    { id: 'input', x: 400, y: 620, w: 176, label: 'input', sublabel: 'Capability · 输入意图', ref: '§66' },
    { id: 'agentcore', x: 640, y: 40, w: 176, label: 'agent-core', sublabel: 'Core · Agent 契约', ref: '§30' },
    { id: 'sandbox', x: 640, y: 420, w: 176, label: 'sandbox-core', sublabel: 'Core · 世界与环境', ref: '§50' },
    { id: 'simcore', x: 880, y: 180, w: 176, label: 'simulation-core', sublabel: 'Core · Clock / Tick / Runtime', ref: '§12' },
    { id: 'contracts', x: 1120, y: 180, w: 176, label: 'contracts', sublabel: 'Core · 零依赖的契约层', ref: '§44', tone: 'accent' },
  ],
  edges: [
    { from: 'app', to: 'api' },
    { from: 'app', to: 'three' },
    { from: 'app', to: 'input', label: 'InputIntent' },
    { from: 'app', to: 'result', label: 'TaskResult' },
    { from: 'app', to: 'replay', label: 'ReplaySnapshot' },
    { from: 'api', to: 'drone' },
    { from: 'api', to: 'vehicle' },
    { from: 'api', to: 'task' },
    { from: 'api', to: 'recorder' },
    { from: 'api', to: 'agentcore' },
    { from: 'api', to: 'sandbox' },
    { from: 'api', to: 'simcore' },
    { from: 'drone', to: 'agentcore' },
    { from: 'drone', to: 'sandbox' },
    { from: 'drone', to: 'simcore' },
    { from: 'vehicle', to: 'contracts' },
    { from: 'agentcore', to: 'simcore' },
    { from: 'task', to: 'simcore' },
    { from: 'sandbox', to: 'simcore' },
    { from: 'simcore', to: 'contracts' },
    { from: 'recorder', to: 'contracts' },
    { from: 'three', to: 'contracts' },
    { from: 'result', to: 'recorder' },
    { from: 'replay', to: 'recorder' },
    { from: 'input', to: 'contracts' },
  ],
}

// ————————————————————————————— ③ 固定 Tick —————————————————————————————

const fixedTick: FlowGraph = {
  id: 'tick',
  title: '固定 Tick 七步',
  caption:
    '一个 tick 里七个步骤的严格顺序(README §14)。顺序不能换:环境先更新,Agent 才能读到本 tick 的世界;State Commit 必须晚于碰撞判定,否则会提交一个「已经撞了」的合法状态。',
  refs: '§13 Simulation Clock · §14 Fixed Tick · 代码见 simulation-core/src/runtime.ts',
  direction: 'TB',
  canvas: { width: 800, height: 760 },
  nodes: [
    { id: 't0', x: 240, y: 0, w: 250, label: 'Tick 开始', sublabel: '固定 1/60 s,不用真实时间', ref: '§13', tone: 'accent' },
    { id: 't1', x: 240, y: 90, w: 250, label: '① Environment Update', sublabel: '风 / 天气 / 时间推进' },
    { id: 't2', x: 240, y: 180, w: 250, label: '② Task Update', sublabel: 'Task 只能 emitCommand,不直接改状态' },
    { id: 't3', x: 240, y: 270, w: 250, label: '③ Agent Update', sublabel: '先消费指令,再推进动力学' },
    { id: 't4', x: 240, y: 360, w: 250, label: '④ Collision / Safety', sublabel: '碰撞 · 电子围栏 · 越界' },
    { id: 't5', x: 240, y: 450, w: 250, label: '⑤ State Commit', sublabel: '在 tick 边界提交权威状态' },
    { id: 't6', x: 240, y: 540, w: 250, label: '⑥ Snapshot', sublabel: '对外只读视图,不可回写' },
    { id: 't7', x: 240, y: 630, w: 250, label: '⑦ Event', sublabel: '表示已经发生的事实' },
    { id: 'query', x: 540, y: 270, w: 220, label: 'SandboxQuery', sublabel: 'Agent 读世界的唯一入口', tone: 'muted' },
  ],
  edges: [
    { from: 't0', to: 't1' },
    { from: 't1', to: 't2' },
    { from: 't2', to: 't3' },
    { from: 't3', to: 't4' },
    { from: 't4', to: 't5' },
    { from: 't5', to: 't6' },
    { from: 't6', to: 't7' },
    { from: 't3', to: 'query', dash: true },
  ],
}

// ————————————————————————————— ④ 指令流 —————————————————————————————

const commandFlow: FlowGraph = {
  id: 'command',
  title: '指令流',
  caption:
    '一次操作从输入到状态的完整路径(README §52)。关键约束是 Authority 在 Command 之前:不合法就直接拒掉,不会有半截指令流进仿真。',
  refs: '§18 Authority · §51 Command · §52 Command 流程 · 代码见 domain-api/executeCommand',
  direction: 'TB',
  canvas: { width: 800, height: 760 },
  nodes: [
    { id: 'u0', x: 200, y: 0, w: 220, label: '用户输入', sublabel: '摇杆盘 · 键盘 · 面板按钮', ref: '§66', tone: 'accent' },
    { id: 'u1', x: 200, y: 95, w: 220, label: '输入合成', sublabel: '同通道相加后夹在 ±1' },
    { id: 'u2', x: 200, y: 190, w: 220, label: 'Domain API', sublabel: 'executeCommand()' },
    { id: 'u3', x: 200, y: 285, w: 220, label: 'Authority 校验', sublabel: '会话在跑?Agent 存在?', ref: '§18' },
    { id: 'reject', x: 520, y: 285, w: 220, label: '拒绝', sublabel: 'command.rejected 告警事件', tone: 'warn' },
    { id: 'u5', x: 200, y: 380, w: 220, label: 'Command', sublabel: '携带 actorId 与 tick 时间戳', ref: '§51' },
    { id: 'u6', x: 200, y: 475, w: 220, label: 'Runtime 指令队列', sublabel: '下一 tick 统一消费' },
    { id: 'u7', x: 0, y: 570, w: 200, label: 'Task 生命周期', sublabel: 'pending → … → done', ref: '§10' },
    { id: 'u8', x: 400, y: 570, w: 220, label: 'Agent 消费指令', sublabel: 'DroneAgent.update()' },
    { id: 'u9', x: 200, y: 665, w: 220, label: 'Agent State', sublabel: '本 tick 的权威状态', tone: 'done' },
  ],
  edges: [
    { from: 'u0', to: 'u1' },
    { from: 'u1', to: 'u2' },
    { from: 'u2', to: 'u3' },
    { from: 'u3', to: 'u5', label: '允许' },
    { from: 'u3', to: 'reject', dash: true, label: '不允许' },
    { from: 'u5', to: 'u6' },
    { from: 'u6', to: 'u7' },
    { from: 'u6', to: 'u8' },
    { from: 'u7', to: 'u8', dash: true, label: '同 tick 生效' },
    { from: 'u8', to: 'u9' },
  ],
}

// ————————————————————————————— ⑤ 数据与记录流 —————————————————————————————

const dataFlow: FlowGraph = {
  id: 'data',
  title: '数据与记录流',
  caption:
    'Snapshot 是唯一的数据出口(README §55)。三条支流互不认识:渲染只认渲染契约,UI 只读快照不复算,Recorder 只往下游沉淀过程数据。',
  refs: '§15 Snapshot · §55 Event / Snapshot 数据流 · §20 Recorder · §56 Recorder',
  direction: 'TB',
  canvas: { width: 780, height: 600 },
  nodes: [
    { id: 'd0', x: 240, y: 0, w: 220, label: 'Runtime tick', sublabel: '每 tick 产出一次', tone: 'accent' },
    { id: 'd1', x: 240, y: 95, w: 220, label: 'Snapshot', sublabel: '只读视图,不可回写', ref: '§54' },
    { id: 'd2', x: 0, y: 200, w: 220, label: 'Renderer Adapter', sublabel: 'AgentRenderView 投影', ref: '§64' },
    { id: 'd3', x: 250, y: 200, w: 220, label: 'UI 面板', sublabel: '遥测 · 状态条 · 雷达', ref: '§38' },
    { id: 'd4', x: 500, y: 200, w: 220, label: 'Recorder', sublabel: '20 Hz 采样', ref: '§20' },
    { id: 'd5', x: 0, y: 305, w: 220, label: 'Three.js 场景', sublabel: '机体 · 灯光 · 雷达锥' },
    { id: 'd6', x: 250, y: 305, w: 220, label: 'HUD 读数', sublabel: '不复算,只显示' },
    { id: 'd7', x: 500, y: 305, w: 220, label: 'AgentTrack / EventLog', sublabel: '轨道 · 事件 · 指令日志', ref: '§56' },
    { id: 'd8', x: 500, y: 400, w: 220, label: 'result · TaskResult', sublabel: '任务结论 + 统计', ref: '§21 · §57', tone: 'done' },
    { id: 'd9', x: 500, y: 495, w: 220, label: 'replay · ReplayController', sublabel: '按记录数据重建位姿', ref: '§22 · §58', tone: 'done' },
  ],
  edges: [
    { from: 'd0', to: 'd1' },
    { from: 'd1', to: 'd2' },
    { from: 'd1', to: 'd3' },
    { from: 'd1', to: 'd4' },
    { from: 'd2', to: 'd5' },
    { from: 'd3', to: 'd6' },
    { from: 'd4', to: 'd7' },
    { from: 'd7', to: 'd8' },
    { from: 'd7', to: 'd9' },
  ],
}

export const FLOW_GRAPHS: ReadonlyArray<FlowGraph> = [
  layering,
  packages,
  fixedTick,
  commandFlow,
  dataFlow,
]

/** 包依赖图里出现的包名 —— 给测试拿去跟真实目录对账用 */
export const PACKAGES_GRAPH_NODES: ReadonlyArray<string> = packages.nodes
  .map((node) => node.label)
  .filter((label) => !label.includes(' '))
