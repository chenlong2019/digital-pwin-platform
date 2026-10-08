/**
 * 回放数据的渲染投影(README §22 · §58 · §64)。
 *
 *   ReplaySnapshot → SimulationSnapshot → 渲染适配器
 *
 * 为什么需要这一层:回放数据里**只有位置与航向**(recorder 的 TrackPoint 只采这两样),
 * 而渲染适配器吃的是 SimulationSnapshot。这一步转换放在 Capability 层最合适 ——
 * 既不该让应用层去手拼快照,也不该让适配器认识「回放」这个来源。
 * 于是适配器照旧只认 SimulationSnapshot,回放页与沙盒页共用同一个渲染适配器。
 *
 * 能力边界(必须写在代码里,而不是靠使用者猜):回放**只还原位姿**。
 * 机臂折叠、云台姿态、灯光、电量、桨叶转速都没有被记录器采集,所以:
 *   · 机臂给展开态 —— 真机在空中必然展开,这是必然关系而不是编造;
 *   · 桨叶按「离地即转」推导 —— 同样是必然关系,停在地面就不转;
 *   · 灯光与电量给 null —— 记录数据里完全没有,不猜。
 * 要把可动件也放出来,得先让 Recorder 采它们(§20 的扩展),那是另一件事。
 */
import type {
  AgentRenderView,
  AgentSnapshot,
  AgentStatus,
  AgentType,
  EnvironmentSnapshot,
  SimulationSnapshot,
} from '@simulation/contracts'
import type { ReplaySnapshot } from './controller'

/** 仿真固定步长(README §13)。回放快照里的 tick 只为对齐观感,不参与任何计算 */
const REPLAY_TICK_HZ = 60

/**
 * 回放环境。
 *
 * 记录数据里没有环境,所以给一份中性的静止环境(风静、晴天、正午)。
 * 渲染适配器需要它才能摆太阳与雾,但它不参与回放的正确性 ——
 * 换个环境只会换光照,不会让位姿对不上。
 */
export const REPLAY_ENVIRONMENT: EnvironmentSnapshot = {
  wind: { speed: 0, directionDeg: 0 },
  weather: 'clear',
  timeOfDay: 12,
  sandboxId: 'replay',
}

/** 判「在空中」的高度阈值(米)。低于它就当地面静止看 */
export const REPLAY_AIRBORNE_ALTITUDE = 0.35

/** 空中时的目视桨叶转速 —— 只影响「看着在转」,不参与任何仿真计算 */
const REPLAY_MOTOR_LOAD = 0.6

const AGENT_TYPES: ReadonlyArray<AgentType> = ['drone', 'vehicle', 'boat', 'robot', 'npc']

/** 记录里的 type 是宽 string(recorder 不认识领域枚举),这里收窄回契约的联合类型 */
function asAgentType(type: string): AgentType {
  return (AGENT_TYPES as ReadonlyArray<string>).includes(type) ? (type as AgentType) : 'npc'
}

/**
 * 把一个回放位姿投影成渲染视图。
 *
 * 签名与领域包的投影函数(`projectDroneRenderView` 等)完全一致,所以可以原样交给
 * 渲染适配器 —— 适配器分不出这份视图来自实时仿真还是历史回放。
 */
export function projectReplayAgent(agent: AgentSnapshot): AgentRenderView | null {
  const airborne = agent.position.y > REPLAY_AIRBORNE_ALTITUDE
  return {
    agentId: agent.id,
    type: agent.type,
    label: agent.label,
    visible: true,
    pose: {
      x: agent.position.x,
      y: agent.position.y,
      z: agent.position.z,
      headingDeg: agent.headingDeg,
      // 俯仰与横滚没有被采集 —— 保持水平,不猜
      pitchDeg: 0,
      rollDeg: 0,
    },
    rig: {
      motorLoad: airborne ? REPLAY_MOTOR_LOAD : 0,
      // 真机在空中必然是展开态
      armFold: 0,
      gimbalPitchDeg: 0,
      gimbalRollDeg: 0,
      gimbalYawDeg: 0,
      cameraZoom: 1,
    },
    // 灯光与电量记录器没采 —— 给 null 让机体回落到熄灭态,而不是编一个读数出来
    lights: null,
    powered: true,
  }
}

/**
 * ReplaySnapshot → 渲染适配器能吃的 SimulationSnapshot。
 *
 * 只有 position 与 headingDeg 是真的,其余字段是让适配器能跑起来的最小壳。
 * 事件照搬:回放时事件本来就该按时刻浮现,这一点与实时仿真一致。
 */
export function replayToRenderSnapshot(
  snapshot: ReplaySnapshot,
  environment: EnvironmentSnapshot = REPLAY_ENVIRONMENT,
): SimulationSnapshot {
  return {
    sessionId: snapshot.sessionId,
    tick: Math.round(snapshot.time * REPLAY_TICK_HZ),
    simulationTime: snapshot.time,
    agents: snapshot.agents.map((agent) => ({
      id: agent.agentId,
      type: asAgentType(agent.type),
      label: agent.label,
      position: agent.position,
      headingDeg: agent.headingDeg,
      status: 'active' as AgentStatus,
      payload: null,
    })),
    tasks: [],
    environment,
    events: snapshot.events,
  }
}
