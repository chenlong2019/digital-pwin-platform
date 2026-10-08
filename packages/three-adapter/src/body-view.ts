/**
 * BodyView —— 机体可视化契约,也就是「载体可插拔」的那个插槽。
 *
 * 在这之前 ThreeRenderAdapter 直接 `new DroneView(...)`,于是整个平台虽然契约上
 * 说支持 drone / vehicle / boat / robot,运行时却只认无人机。把机体抽象成这个接口后:
 *
 *   ThreeRenderAdapter  ──依赖──▶  BodyView(契约)
 *                                     ▲            ▲
 *                              DroneView      CarView      …将来的 BoatView
 *
 * 适配器从此不认识任何具体载体;换载具 = 换一个 BodyViewFactory 注进去,
 * 渲染循环、相机、场景、障碍物一行都不用改。
 *
 * 注意:本接口只描述「怎么把一个中性的 AgentRenderView 画出来」,
 * 不认识仿真、不认识 Command、不认识遥测字段 —— 那是领域包的事。
 */
import type * as THREE from 'three'
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { AgentRenderView } from '@simulation/contracts'

/** 机体部件自检报告 —— HUD 用它显示「模型健康」 */
export interface BodyPartReport {
  readonly id: string
  readonly label: string
  /** 模型里是否找到了这个部件 */
  readonly found: boolean
  /** 该部件是否可被驱动 */
  readonly drivable: boolean
}

/** 载入机体所需的上下文 */
export interface BodyLoadContext {
  readonly loader: GLTFLoader
  /** 场景根:机体若需要挂点光源(车灯/状态灯)就加到这里 */
  readonly scene: THREE.Scene
  /** 模型地址;不传则用该机体自带的默认地址 */
  readonly url?: string
  /** 归一化后的最大尺寸(米);不传则用该机体自带的默认值 */
  readonly sizeMeters?: number
}

export interface BodyView {
  /** 挂进场景的根对象 */
  readonly object3d: THREE.Object3D
  /** 归一化时算出的「底部贴地」y 偏移 */
  readonly groundOffsetY: number

  /**
   * 每帧驱动:把中性的渲染视图映射到三维模型。
   * view 为 null 表示这一帧没有渲染目标(例如 Agent 尚未注册),实现应保持上一次姿态。
   */
  apply(view: AgentRenderView | null, deltaSeconds: number): void

  /** 模型自检:哪些可动件识别到了 */
  getPartReport(): ReadonlyArray<BodyPartReport>
  /** 自检结果的人类可读描述 */
  readonly modelHealthText: string

  /**
   * 可选能力:机载相机(云台)的世界变换。
   * 没有实现 = 该载体不支持「机载取景 / 拍照 / 录像」,适配器会自动跳过。
   * 汽车目前不需要,所以不实现。
   */
  getGimbalTransform?(target: THREE.Object3D): boolean

  dispose(): void
}

/** 机体工厂 —— 适配器只认它,不认具体是什么载体 */
export type BodyViewFactory = (context: BodyLoadContext) => Promise<BodyView>
