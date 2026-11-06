// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { applyGaussianTestCamera } from '@simulation/three-adapter'
import type { GaussianTestCamera } from '@simulation/three-adapter'

const view = (): GaussianTestCamera => ({
  frameId: 'test-camera',
  cameraPose: {
    positionM: { x: 10, y: 20, z: 30 },
    quaternionXyzw: { x: 0, y: 0, z: 0, w: 1 },
    coordinateFrame: 'platform-world',
  },
  cameraIntrinsics: { width: 512, height: 384, fy: 350 },
})

describe('高斯模型与采集相机使用同一坐标系', () => {
  it('保持米制位置、+Y向上、-Z朝前，并从真实内参恢复视场角', () => {
    const camera = new THREE.PerspectiveCamera(58, 4 / 3, 0.1, 4000)
    const direction = applyGaussianTestCamera(camera, view())
    expect(camera.position.toArray()).toEqual([10, 20, 30])
    expect(direction.toArray()).toEqual([-0, -0, -1])
    expect(camera.up.toArray()).toEqual([0, 1, 0])
    const point = new THREE.Vector3(12, 21, 20).project(camera)
    expect((point.x + 1) * 256).toBeCloseTo(256 + (350 * 2) / 10)
    expect((1 - point.y) * 192).toBeCloseTo(192 - 350 / 10)
  })

  it('旋转和四元数反号保持物理朝向，不对模型额外翻转', () => {
    const camera = new THREE.PerspectiveCamera()
    const frame = view()
    Object.assign(frame.cameraPose.quaternionXyzw, { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 })
    const direction = applyGaussianTestCamera(camera, frame)
    expect(direction.x).toBeCloseTo(-1)
    expect(direction.y).toBeCloseTo(0)
    expect(direction.z).toBeCloseTo(0)
    Object.assign(frame.cameraPose.quaternionXyzw, {
      x: 0,
      y: -Math.SQRT1_2,
      z: 0,
      w: -Math.SQRT1_2,
    })
    expect(applyGaussianTestCamera(camera, frame).distanceTo(direction)).toBeCloseTo(0)
  })

  it.each(['coordinates', 'quaternion', 'intrinsics', 'frame'])('拒绝无效的 %s', (damage) => {
    const frame = structuredClone(view())
    if (damage === 'coordinates') Object.assign(frame.cameraPose.positionM, { x: NaN })
    if (damage === 'quaternion') Object.assign(frame.cameraPose.quaternionXyzw, { w: 2 })
    if (damage === 'intrinsics') Object.assign(frame.cameraIntrinsics, { fy: 0 })
    if (damage === 'frame') Object.assign(frame.cameraPose, { coordinateFrame: 'unknown' })
    expect(() => applyGaussianTestCamera(new THREE.PerspectiveCamera(), frame)).toThrow('无效')
  })
})
