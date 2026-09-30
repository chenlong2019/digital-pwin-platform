/**
 * DroneView —— 无人机机体的可视化:载入 GLB、归一化尺寸、驱动机械件与灯光。
 *
 * 从旧项目 firstapp 的 `drone-fly.ts` 里把「渲染职责」单独切出来:
 *   · 旧版:DroneFly 同时持有仿真内核 + 场景 + 机械 + 灯光 + 相机 + 录像 + 拍照(耦合)
 *   · 新版:本文件只做「把 AgentRenderView 映射到三维模型」,不认识仿真
 *
 * 归一化与整机变换约定沿用旧项目实测结果:机体最大尺寸缩放到 2.4 米、
 * 水平居中、底部贴地;桨叶自转/机臂折叠/钟罩固定/灯珠骨骼绑定的修复
 * 全部留在 drone-rig.ts 与 drone-lights.ts 里。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { AgentRenderView } from '@simulation/contracts'
import type { RigPartReport } from './drone-rig'
import { DroneRig } from './drone-rig'
import type { AuxLightMode, BatteryLightMode, DroneLightsSnapshot, StatusLightKey } from './drone-lights'
import { DroneLights, isStatusLightKey } from './drone-lights'

export const DRONE_MODEL_URL = '/models/djiair_renamed.glb'
/** 机体最大尺寸(米),按真机 1:1 展示 */
export const DRONE_SIZE_METERS = 2.4
/** 机臂展开/收纳的收敛速度(每秒插值系数) */
const ARM_FOLD_SPEED = 1.8
/** 机臂算「已展开」的阈值 —— 与 DroneAgent 的判定保持一致 */
const ARM_UNFOLDED_THRESHOLD = 0.005

export interface DroneViewOptions {
  readonly url?: string
  readonly sizeMeters?: number
  /** 出厂机臂收纳:真机必须展开机臂才能起飞 */
  readonly initialArmFold?: number
}

export class DroneView {
  readonly model: THREE.Group
  readonly rig: DroneRig
  readonly lights: DroneLights
  /** 归一化后模型底部贴地所需的 y 偏移 */
  readonly groundOffsetY: number
  private currentFold: number
  /** 面板手动指定的灯语;null = 跟随飞行状态 */
  private lightOverride: StatusLightKey | null = null
  private statusBoundToArms = false

  private constructor(
    model: THREE.Group,
    rig: DroneRig,
    lights: DroneLights,
    groundOffsetY: number,
    initialFold: number,
  ) {
    this.model = model
    this.rig = rig
    this.lights = lights
    this.groundOffsetY = groundOffsetY
    this.currentFold = initialFold
  }

  static async load(loader: GLTFLoader, scene: THREE.Scene, options: DroneViewOptions = {}): Promise<DroneView> {
    const gltf = await loader.loadAsync(options.url ?? DRONE_MODEL_URL)
    const model = gltf.scene
    model.name = 'DJI Mini 4 Pro'
    const groundOffsetY = normalizeModel(model, options.sizeMeters ?? DRONE_SIZE_METERS)
    model.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
    })
    const rig = new DroneRig(model)
    const initialFold = options.initialArmFold ?? 1
    rig.setArmFold(initialFold)

    // 灯光挂在模型节点下,随模型一起移动旋转;模型自带的 LIGHT_* 点光源也由它驱动
    const lights = new DroneLights()
    lights.attach(model, scene)

    return new DroneView(model, rig, lights, groundOffsetY, initialFold)
  }

  /**
   * 把一帧渲染视图应用到机体。
   * 位姿经 applyBodyPose 单点写入,画面与遥测永远是同一份状态。
   */
  apply(view: AgentRenderView, deltaSeconds: number): void {
    const pose = view.pose
    this.model.visible = view.visible
    this.rig.applyBodyPose({
      x: pose.x,
      y: this.groundOffsetY + pose.y,
      z: pose.z,
      headingDeg: pose.headingDeg,
      pitchDeg: pose.pitchDeg,
      rollDeg: pose.rollDeg,
    })

    const state = view.rig
    if (state) {
      // 目视转速用真实帧时间,不跟时间倍速走,否则高倍速下桨叶会糊成一片
      this.rig.updateProps(state.motorLoad, deltaSeconds)
      const target = Math.max(0, Math.min(1, state.armFold))
      this.currentFold += (target - this.currentFold) * Math.min(1, deltaSeconds * ARM_FOLD_SPEED)
      this.rig.setArmFold(this.currentFold)
      // 桨叶叠拢/张开:机臂完全展开后才缓缓张开(真机节奏)
      this.rig.updateBlades(deltaSeconds)
      this.rig.setGimbalAttitude(
        state.gimbalPitchDeg,
        state.gimbalRollDeg,
        state.gimbalYawDeg,
        pose.pitchDeg,
        pose.rollDeg,
      )
    }

    this.applyLights(view.lights, deltaSeconds)
  }

  /**
   * 灯语:状态灯跟飞行状态走,除非面板手动指定;
   * 电量灯珠与辅助灯由面板单独控制(见 setBatteryLightMode / setAuxLightMode)。
   */
  private applyLights(lightState: AgentRenderView['lights'], deltaSeconds: number): void {
    const lights = this.lights
    if (!lightState) {
      lights.setFlying(false)
      lights.setStatusPattern(this.lightOverride ?? 'off')
      lights.update(deltaSeconds)
      return
    }

    lights.setFlying(lightState.flying)
    lights.setBatteryLevel(lightState.batteryLevel)
    const pattern = isStatusLightKey(lightState.pattern) ? lightState.pattern : 'off'
    lights.setStatusPattern(this.lightOverride ?? pattern)
    lights.update(deltaSeconds)

    // 状态灯骨骼绑定:首次在展开态把灯珠挂进机臂折叠节点(记录绑定位姿),
    // 之后每帧按绑定位姿刚体同步 —— 灯珠像焊在机臂末端一样随折叠/展开运动。
    if (!this.statusBoundToArms && this.rig.armFold < ARM_UNFOLDED_THRESHOLD) {
      lights.attachStatusToArms(this.rig.getArmFoldNode('RearLeft'), this.rig.getArmFoldNode('RearRight'))
      this.statusBoundToArms = true
    }
    lights.syncStatusToArms()
  }

  // ————————————————————————————— 灯光面板 —————————————————————————————

  /** 手动锁定灯语(null = 交还给飞行状态) */
  setStatusLightOverride(key: StatusLightKey | null): void {
    this.lightOverride = key
  }

  get statusLightOverride(): StatusLightKey | null {
    return this.lightOverride
  }

  setBatteryLightMode(mode: BatteryLightMode): void {
    this.lights.setBatteryMode(mode)
  }

  setAuxLightMode(mode: AuxLightMode): void {
    this.lights.setAuxLightMode(mode)
  }

  setAuxBeamVisible(visible: boolean): void {
    this.lights.setBeamVisible(visible)
  }

  getLightsSnapshot(): DroneLightsSnapshot {
    return this.lights.getSnapshot()
  }

  // ————————————————————————————— 查询 —————————————————————————————

  /** 机载视角需要云台的世界位置与朝向 */
  getGimbalTransform(target: THREE.Object3D): boolean {
    return this.rig.getGimbalCameraTransform(target)
  }

  getRigReport(): ReadonlyArray<RigPartReport> {
    return this.rig.parts
  }

  get modelHealthText(): string {
    const parts = this.rig.parts
    const missing = parts.filter((part) => !part.found)
    if (missing.length === 0) return `全部 ${parts.length} 项部件已识别`
    return `${parts.length - missing.length}/${parts.length} 项已识别,缺少:${missing
      .map((part) => part.label)
      .join('、')}`
  }

  dispose(): void {
    this.lights.destroy()
    this.rig.destroy()
    this.model.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry.dispose()
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) material.dispose()
    })
    this.model.parent?.remove(this.model)
  }
}

/** 缩放到真实尺寸、水平居中、底部贴地,返回贴地所需的 y 偏移 */
function normalizeModel(model: THREE.Group, sizeMeters: number): number {
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
