import type { GaussianSplatScene, GaussianViewerCallbacks } from './gaussian-splat-scene'

// Keep the splat renderer and its decoder out of the sandbox's initial bundle.
export async function createGaussianSplatViewer(
  container: HTMLElement,
  callbacks: GaussianViewerCallbacks = {},
): Promise<GaussianSplatScene> {
  const { GaussianSplatScene } = await import('./gaussian-splat-scene')
  return new GaussianSplatScene(container, callbacks)
}

export type {
  GaussianSplatScene,
  GaussianViewerCallbacks,
  GaussianViewerStats,
} from './gaussian-splat-scene'
export type { GaussianTestCamera } from './gaussian-camera'
export { applyGaussianTestCamera } from './gaussian-camera'
