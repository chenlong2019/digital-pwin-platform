import * as THREE from 'three'

export interface GaussianTestCamera {
  readonly frameId: string
  readonly cameraPose: {
    readonly positionM: { readonly x: number; readonly y: number; readonly z: number }
    readonly quaternionXyzw: {
      readonly x: number
      readonly y: number
      readonly z: number
      readonly w: number
    }
    readonly coordinateFrame?: string
  }
  readonly cameraIntrinsics: {
    readonly width: number
    readonly height: number
    readonly fy: number
  }
}

/** The exported PLY already uses the platform's +Y-up, metre-based coordinates. */
export function applyGaussianTestCamera(
  camera: THREE.PerspectiveCamera,
  view: GaussianTestCamera,
): THREE.Vector3 {
  const { positionM: p, quaternionXyzw: q, coordinateFrame } = view.cameraPose
  const { width, height, fy } = view.cameraIntrinsics
  if (
    (coordinateFrame && coordinateFrame !== 'platform-world') ||
    ![p.x, p.y, p.z, q.x, q.y, q.z, q.w, width, height, fy].every(Number.isFinite) ||
    Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) > 0.001 ||
    width <= 0 ||
    height <= 0 ||
    fy <= 0
  )
    throw new Error('测试相机的坐标或标定参数无效')
  camera.position.set(p.x, p.y, p.z)
  camera.quaternion.set(q.x, q.y, q.z, q.w).normalize()
  camera.up.set(0, 1, 0).applyQuaternion(camera.quaternion)
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(height / (2 * fy)))
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera.getWorldDirection(new THREE.Vector3())
}
