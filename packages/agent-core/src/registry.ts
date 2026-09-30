/**
 * Agent Registry —— 只负责生命周期(README §28)。
 *
 * 不做物理、不做评估、不做任务逻辑、不做渲染、不做权限判定。
 */
import type { Agent, AgentId } from '@simulation/contracts'

export class AgentRegistry {
  private readonly agents = new Map<AgentId, Agent>()

  register(agent: Agent): boolean {
    if (this.agents.has(agent.id)) return false
    this.agents.set(agent.id, agent)
    return true
  }

  unregister(id: AgentId): boolean {
    const agent = this.agents.get(id)
    if (!agent) return false
    agent.dispose()
    return this.agents.delete(id)
  }

  has(id: AgentId): boolean {
    return this.agents.has(id)
  }

  get<TPayload>(id: AgentId): Agent<TPayload> | undefined {
    return this.agents.get(id) as Agent<TPayload> | undefined
  }

  getOrThrow<TPayload>(id: AgentId): Agent<TPayload> {
    const agent = this.get<TPayload>(id)
    if (!agent) throw new Error(`Agent 不存在:${id}`)
    return agent
  }

  list(): ReadonlyArray<Agent> {
    return [...this.agents.values()]
  }

  get size(): number {
    return this.agents.size
  }

  clear(): void {
    for (const agent of this.agents.values()) agent.dispose()
    this.agents.clear()
  }
}

let agentSeq = 0

/** 生成稳定、可读的 Agent 标识(同一次进程内不重复) */
export function createAgentId(prefix: string): AgentId {
  agentSeq += 1
  return `${prefix}-${String(agentSeq).padStart(2, '0')}`
}
