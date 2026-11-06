// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { SandboxScene } from '@simulation/three-adapter'
import { campusCapturePlan } from '../experiments/campus-plan'

describe('园区实验视角划分', () => {
  it('在采集之前固定训练和测试相机，角度与高度均独立', () => {
    const plan = campusCapturePlan()
    expect(plan).toEqual(campusCapturePlan())
    expect(new Set(plan.map((view) => view.id)).size).toBe(40)
    const train = plan.filter((view) => view.split === 'train')
    const test = plan.filter((view) => view.split === 'test')
    expect(train).toHaveLength(32)
    expect(test).toHaveLength(8)
    for (const view of test) {
      expect(train.some((item) => Math.abs(item.position.y - view.position.y) < 1e-6)).toBe(false)
      const angle = Math.atan2(view.position.x, view.position.z + 105)
      expect(
        train.every(
          (item) =>
            Math.abs(Math.sin(Math.atan2(item.position.x, item.position.z + 105) - angle)) > 0.01,
        ),
      ).toBe(true)
    }
    for (const view of plan) {
      expect(Math.hypot(view.position.x, view.position.z + 105)).toBeCloseTo(300)
      expect(view.target).toEqual({ x: 0, y: 22, z: -105 })
    }
  })
})

describe('采集相机标定与实际透视投影一致', () => {
  it.each([
    [256, 192, 1],
    [960, 540, 2.5],
    [300, 600, 4],
  ])('%i×%i，变焦 %f', (width, height, zoom) => {
    const camera = new THREE.PerspectiveCamera(58, width / height, 0.1, 2000)
    camera.zoom = zoom
    camera.updateProjectionMatrix()
    // Exercise calibration without constructing a WebGL context or loading a drone.
    const scene = Object.create(SandboxScene.prototype) as SandboxScene
    Object.assign(scene, {
      camera,
      captureTransform: new THREE.Object3D(),
      captureZoom: zoom,
      renderer: { domElement: { width, height } },
    })
    const calibration = scene.getCaptureCamera()!
    const { positionM, quaternionXyzw } = calibration.pose
    camera.position.set(positionM.x, positionM.y, positionM.z)
    camera.quaternion.set(quaternionXyzw.x, quaternionXyzw.y, quaternionXyzw.z, quaternionXyzw.w)
    camera.updateMatrixWorld(true)
    const point = new THREE.Vector3(positionM.x + 2, positionM.y + 1, positionM.z - 10)
    const projected = point.clone().project(camera)
    const { fx, fy, cx, cy } = calibration.intrinsics
    expect(fx).toBeCloseTo(fy)
    expect((fx * 2) / 10 + cx).toBeCloseTo(((projected.x + 1) * width) / 2)
    expect((fy * -1) / 10 + cy).toBeCloseTo(((1 - projected.y) * height) / 2)
  })
})
