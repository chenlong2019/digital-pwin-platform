/**
 * 发布流 —— Core 对外解耦的唯一手段(README §71)。
 *
 * Core 不知道 Recorder / Renderer / Realtime 的存在,只往流里发布;
 * 订阅方自己挂上来。反向依赖因此被彻底切断。
 */

export interface StreamLike<T> {
  subscribe(listener: (value: T) => void): () => void
}

export class Stream<T> implements StreamLike<T> {
  private readonly listeners = new Set<(value: T) => void>()

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish(value: T): void {
    // 复制一份再遍历:订阅回调里增删订阅不会影响本次派发
    for (const listener of [...this.listeners]) {
      listener(value)
    }
  }

  get size(): number {
    return this.listeners.size
  }

  clear(): void {
    this.listeners.clear()
  }
}
