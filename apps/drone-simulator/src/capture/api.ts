export interface CaptureShotPlan {
  id: string
  positionEnu: [number, number, number]
  heading: number
  pitch: number
}

export interface CapturePlan {
  schemaVersion: 1
  taskId: string
  sceneId: 'three-demo-city-webgl-husky-v1'
  maxAttempts: number
  shots: CaptureShotPlan[]
}

export interface CaptureTask {
  task_id: string
  dataset_id: string
  name: string
  plan: CapturePlan
  status: 'queued' | 'running' | 'paused' | 'failed' | 'completed'
  completed: number
  uploaded: number
  total: number
  worker_id: string | null
  pause_requested: boolean
  error: string | null
  lease_expires_at: string | null
}

export interface CaptureManifest {
  frames: Array<{ frameId: string; width: number; height: number; metadata?: { shotId?: string } }>
}

export const CAPTURE_SERVICE_URL = (import.meta.env.VITE_NEURAL_RENDER_URL ?? 'http://127.0.0.1:8090').replace(/\/$/, '')

export async function captureRequest<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${CAPTURE_SERVICE_URL}/api/v1${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(typeof failure?.detail === 'string' ? failure.detail : `请求未完成（${response.status}）`)
  }
  return await response.json() as T
}
