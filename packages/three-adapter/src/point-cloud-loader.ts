import type { DecodedPointCloud } from './point-cloud-data'
import type { PointCloudLoadRequest } from './point-cloud-loader.worker'

type LoadRequest = Exclude<PointCloudLoadRequest, { kind: 'cancel' }>
type LoadInput = LoadRequest extends infer T
  ? T extends LoadRequest
    ? Omit<T, 'id'>
    : never
  : never

/** One decoder worker; fetch concurrency is bounded by PointCloudLayer. */
export class PointCloudLoader {
  private readonly worker = new Worker(new URL('./point-cloud-loader.worker.ts', import.meta.url), {
    type: 'module',
  })
  private nextId = 0
  private readonly pending = new Map<
    number,
    { resolve: (value: DecodedPointCloud) => void; reject: (reason: Error) => void }
  >()
  private disposed = false

  constructor() {
    this.worker.onmessage = ({
      data,
    }: MessageEvent<{ id: number; cloud?: DecodedPointCloud; error?: string }>) => {
      const job = this.pending.get(data.id)
      if (!job) return
      this.pending.delete(data.id)
      if (data.cloud) job.resolve(data.cloud)
      else job.reject(new Error(data.error ?? '点云解码失败'))
    }
    this.worker.onerror = () => {
      for (const job of this.pending.values()) job.reject(new Error('点云解码器不可用'))
      this.pending.clear()
    }
  }

  async load(input: LoadInput, signal?: AbortSignal): Promise<DecodedPointCloud> {
    if (this.disposed) throw new Error('点云解码器已关闭')
    signal?.throwIfAborted()
    const id = ++this.nextId
    const cancel = () => {
      this.worker.postMessage({ id, kind: 'cancel' })
      this.pending.get(id)?.reject(new DOMException('点云请求已取消', 'AbortError'))
      this.pending.delete(id)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      return await new Promise<DecodedPointCloud>((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        this.worker.postMessage({ ...input, id })
      })
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  dispose(): void {
    this.disposed = true
    this.worker.terminate()
    for (const job of this.pending.values())
      job.reject(new DOMException('点云解码器已关闭', 'AbortError'))
    this.pending.clear()
  }
}
