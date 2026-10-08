/**
 * 回放数据的中转站(README §22 · §58)。
 *
 * 抓数据的是沙盒页,放数据的是回放页 —— 两个路由,谁也不该持有对方的私有状态。
 * 所以放一份最小的模块级 store:
 *   · 内存一份 —— 路由切换立刻可用;
 *   · sessionStorage 一份 —— 刷新页面不丢;
 *   · 写不进去(超出配额 / 隐私模式)就静默降级成「只在内存里」,功能照旧。
 *
 * 存的是**抓好的自洽快照**(captureReplayData 的产物)而不是会话引用 ——
 * 沙盒页关掉之后回放照样能放,这正是 §22「历史数据驱动回放」的意思。
 */
import { computed, shallowRef } from 'vue'
import type { TaskResult, TaskSnapshot } from '@simulation/contracts'
import type { ReplayData } from '@simulation/replay'
import type { Scenario } from '@simulation/sandbox-core'

export interface StoredReplay {
  readonly data: ReplayData
  /** 保存那一刻的场景 —— 回放要用它重建障碍物,否则无人机看着像在空地上飞 */
  readonly scenario: Scenario
  /** 保存那一刻的任务快照与结论;没跑任务时是 null,看板会退化成轨迹统计 */
  readonly task: TaskSnapshot | null
  readonly taskResult: TaskResult | null
  readonly savedAt: number
}

const STORAGE_KEY = 'simulation.replay.latest'

/** sessionStorage 在无头测试与隐私模式下可能不可用,统一在这里兜住 */
function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function readPersisted(): StoredReplay | null {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredReplay | null
    // 只认结构对得上的:坏数据当作「没有」,宁可让用户重新飞一次,也别让回放页崩掉
    if (!parsed || !parsed.data || !Array.isArray(parsed.data.tracks)) return null
    return parsed
  } catch {
    return null
  }
}

function persist(entry: StoredReplay | null): void {
  const store = storage()
  if (!store) return
  try {
    if (entry) store.setItem(STORAGE_KEY, JSON.stringify(entry))
    else store.removeItem(STORAGE_KEY)
  } catch {
    // 配额超了或隐私模式:回退成「只在内存里」,不影响本次会话内的回放
  }
}

const latest = shallowRef<StoredReplay | null>(readPersisted())
const hasReplay = computed(() => latest.value !== null)

export function saveReplay(entry: StoredReplay): void {
  latest.value = entry
  persist(entry)
}

export function clearReplay(): void {
  latest.value = null
  persist(null)
}

export function useReplayStore(): {
  readonly latest: typeof latest
  readonly hasReplay: typeof hasReplay
  saveReplay: typeof saveReplay
  clearReplay: typeof clearReplay
} {
  return { latest, hasReplay, saveReplay, clearReplay }
}
