import { decodePointCloud } from './point-cloud-data'
import type {
  PointCloudIndex,
  PointCloudLod,
  PointCloudTile,
  PointCloudVector,
} from './point-cloud-data'

export type PointCloudLoadRequest =
  | {
      id: number
      kind: 'overview'
      url: string
      index: PointCloudIndex
    }
  | {
      id: number
      kind: 'detail'
      url: string
      tile: PointCloudTile
      lod: PointCloudLod
      origin: PointCloudVector
    }
  | { id: number; kind: 'cancel' }

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<PointCloudLoadRequest>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}
const active = new Map<number, AbortController>()

scope.onmessage = ({ data }) => {
  if (data.kind === 'cancel') {
    active.get(data.id)?.abort()
    return
  }
  void load(data)
}

async function load(request: Exclude<PointCloudLoadRequest, { kind: 'cancel' }>): Promise<void> {
  const controller = new AbortController()
  active.set(request.id, controller)
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(request.url, { signal: controller.signal })
    if (!response.ok) throw new Error(`点云文件请求失败 (${response.status})`)
    let buffer = await response.arrayBuffer()
    const signature = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength))
    // Local assets are gzip files; the remote server may already decode them.
    if (signature[0] === 0x1f && signature[1] === 0x8b) {
      buffer = await new Response(
        new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip')),
      ).arrayBuffer()
    }
    controller.signal.throwIfAborted()
    if (request.kind === 'overview') {
      if (buffer.byteLength !== request.index.overview.bytes) throw new Error('园区概览文件不完整')
      // WebCrypto is only available on HTTPS/localhost; LAN HTTP still supports
      // the overview using the mandatory byte-length and segment checks.
      if (globalThis.crypto?.subtle) {
        const digest = await crypto.subtle.digest('SHA-256', buffer)
        const hash = Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('')
        if (hash !== request.index.overview.sha256) throw new Error('园区概览校验失败')
      }
    } else if (buffer.byteLength !== request.lod.points * 9) throw new Error('点云细节文件不完整')
    const cloud =
      request.kind === 'overview'
        ? decodePointCloud(
            new Uint8Array(buffer),
            request.index.tiles.map((tile) => ({
              tile,
              lod: tile.lods[0]!,
              byteOffset: tile.overviewOffset,
            })),
            request.index.origin,
          )
        : decodePointCloud(
            new Uint8Array(buffer),
            [{ tile: request.tile, lod: request.lod, byteOffset: 0 }],
            request.origin,
          )
    controller.signal.throwIfAborted()
    scope.postMessage({ id: request.id, cloud }, [
      cloud.positions.buffer,
      cloud.colors.buffer,
      cloud.tileIndices.buffer,
      cloud.spacings.buffer,
    ])
  } catch (error) {
    scope.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    clearTimeout(timer)
    active.delete(request.id)
  }
}
