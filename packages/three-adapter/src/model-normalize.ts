/**
 * 模型归一化 —— 无人机与汽车共用同一套「缩放到真实尺寸 + 水平居中 + 底部贴地」规则。
 *
 * 从 drone-view.ts 提取出来:这段逻辑和载体无关,差别只在 sizeMeters 传什么
 * (无人机传机体对角线 2.4 m,汽车传车长 4.72 m)。留在 DroneView 里会让
 * CarView 只能复制一份,两份一旦漂移,两个载体的贴地行为就不一致了。
 */
import * as THREE from 'three'

/** 缩放到真实尺寸、水平居中、底部贴地,返回贴地所需的 y 偏移 */
export function normalizeModel(model: THREE.Object3D, sizeMeters: number): number {
  const initialBounds = new THREE.Box3().setFromObject(model)
  const size = initialBounds.getSize(new THREE.Vector3())
  const largestDimension = Math.max(size.x, size.y, size.z)
  if (largestDimension > 0) model.scale.setScalar(sizeMeters / largestDimension)

  const bounds = new THREE.Box3().setFromObject(model)
  const center = bounds.getCenter(new THREE.Vector3())
  model.position.x -= center.x
  model.position.z -= center.z
  model.position.y -= bounds.min.y
  return model.position.y
}
