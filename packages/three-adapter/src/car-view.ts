/**
 * CarView —— 特斯拉 Model 3 机体的可视化:载入 GLB、驱动四门 / 四轮 / 转向 / 后视镜 / 灯光。
 *
 * 与 DroneView 平级,同为实现 BodyView 契约的具体载体之一。
 * 节点名、轴向、行程全部来自模型同目录的 `2024_tesla_model_3_rigged.nodes.md` ——
 * 那是改装脚本与渲染层之间的**唯一契约**,两边不许各自发挥。
 *
 * 与无人机最大的结构差异:汽车没有云台、没有机臂,取而代之的是一堆
 * **独立铰链**(门/镜/转向节),所以可动件用契约层的 `rig.parts` 具名通道传进来,
 * 而不是给 AgentRigState 新增一堆汽车专属字段。
 */
import * as THREE from 'three'
import type { AgentPartChannel, AgentRenderView } from '@simulation/contracts'
import type { BodyLoadContext, BodyPartReport, BodyView } from './body-view'
import { normalizeModel } from './model-normalize'

/** 改装后的成品模型(含独立门/轮/镜/灯节点) */
export const CAR_MODEL_URL = '/models/2024_tesla_model_3_rigged.glb'
/** 车长 4.72 m,真车 1:1 —— 归一化按「最大尺寸」即车长缩放 */
export const CAR_SIZE_METERS = 4.72

/** 门全开的转角(度) */
const DOOR_OPEN_DEG = 58
/** 后视镜全折的转角(度) */
const MIRROR_FOLD_DEG = 78
/** 前轮最大转向角(度) */
const MAX_STEER_DEG = 26
/** 双闪频率(Hz) */
const BLINK_HZ = 1.4
/** 自发光增益:白天光照下也要看得出灯亮 */
const EMISSIVE_GAIN = 3.2

/**
 * 门:铰链在前缘,所以左右侧的开合方向相反 ——
 * 左门(FL/RL)负角开、右门(FR/RR)正角开。这条规律来自节点契约,不是猜的。
 */
const DOORS = [
  { part: 'door_FL', node: 'DOOR_FL', open: -1 },
  { part: 'door_FR', node: 'DOOR_FR', open: 1 },
  { part: 'door_RL', node: 'DOOR_RL', open: -1 },
  { part: 'door_RR', node: 'DOOR_RR', open: 1 },
] as const

/** 后视镜挂在门上,随门动;折叠方向同样左右相反 */
const MIRRORS = [
  { part: 'mirror_L', node: 'MIRROR_FL', fold: -1 },
  { part: 'mirror_R', node: 'MIRROR_FR', fold: 1 },
] as const

/** 前轮有 STEER 父节点(转向),后轮直接挂在车身上 */
const STEER_NODES = ['STEER_FL', 'STEER_FR'] as const
const WHEEL_NODES = ['WHEEL_FL', 'WHEEL_FR', 'WHEEL_RL', 'WHEEL_RR'] as const

/** 车灯分三类,按用途而不是按位置分组 —— 灯语只需要说「大灯多亮」,不必逐盏点名 */
export type CarLightRole = 'head' | 'tail' | 'ambient'

export const CAR_LIGHT_PATTERNS = ['off', 'position', 'low', 'high', 'hazard'] as const
export type CarLightPattern = (typeof CAR_LIGHT_PATTERNS)[number]

export function isCarLightPattern(value: unknown): value is CarLightPattern {
  return typeof value === 'string' && (CAR_LIGHT_PATTERNS as ReadonlyArray<string>).includes(value)
}

interface LightPlan {
  readonly head: number
  readonly tail: number
  readonly ambient: number
  /** 双闪:整组灯按 BLINK_HZ 通断 */
  readonly blink: boolean
}

/** 灯语 → 三类灯的目标强度。改这里就能加「刹车灯」「雾灯」,不必碰驱动代码 */
const LIGHT_PLANS: Record<CarLightPattern, LightPlan> = {
  off: { head: 0, tail: 0, ambient: 0, blink: false },
  position: { head: 0, tail: 0.4, ambient: 0.6, blink: false },
  low: { head: 0.85, tail: 0.55, ambient: 0.7, blink: false },
  high: { head: 1.5, tail: 0.55, ambient: 0.7, blink: false },
  hazard: { head: 0.85, tail: 0.55, ambient: 0.7, blink: true },
}

const LIGHT_COLORS: Record<CarLightRole, THREE.Color> = {
  head: new THREE.Color(1, 0.96, 0.86),
  tail: new THREE.Color(1, 0.12, 0.1),
  ambient: new THREE.Color(0.45, 0.72, 1),
}

/**
 * 材质名 → 用途。顺序不能调:`Taillight_Detail_AMBIENT` 同时含 tail 与 ambient,
 * 按节点契约它属于车内环境灯带,所以 ambient 必须先判。
 */
function lightRoleOf(name: string): CarLightRole | null {
  const lower = name.toLowerCase()
  if (lower.includes('ambient') || lower.includes('int_led')) return 'ambient'
  if (lower.includes('tail')) return 'tail'
  if (lower.includes('head')) return 'head'
  // 兜底:Lights_Glo_* / Lights_Ref_*(大灯辉光与反光碗)名字里既没有 head 也没有 tail
  if (lower.includes('light') || lower.includes('lamp')) return 'head'
  return null
}

interface LightSlot {
  readonly material: THREE.MeshStandardMaterial
  readonly role: CarLightRole
  /** 出厂自发光,用来「熄灯」时还原 */
  readonly baseEmissive: THREE.Color
  readonly baseIntensity: number
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

export class CarView implements BodyView {
  readonly model: THREE.Group
  readonly groundOffsetY: number

  private readonly nodes = new Map<string, THREE.Object3D>()
  private readonly parts: BodyPartReport[] = []
  private readonly lights: LightSlot[] = []
  private blinkPhase = 0

  private constructor(
    model: THREE.Group,
    groundOffsetY: number,
    parts: BodyPartReport[],
    nodes: Map<string, THREE.Object3D>,
    lights: LightSlot[],
  ) {
    this.model = model
    this.groundOffsetY = groundOffsetY
    this.parts = parts
    this.nodes = nodes
    this.lights = lights
  }

  static async load(context: BodyLoadContext): Promise<CarView> {
    const gltf = await context.loader.loadAsync(context.url ?? CAR_MODEL_URL)
    const model = gltf.scene
    model.name = 'Tesla Model 3'
    const groundOffsetY = normalizeModel(model, context.sizeMeters ?? CAR_SIZE_METERS)
    model.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
    })

    const nodes = new Map<string, THREE.Object3D>()
    const parts: BodyPartReport[] = []
    const claim = (id: string, label: string, drivable = true): void => {
      const node = model.getObjectByName(id) ?? null
      if (node) nodes.set(id, node)
      parts.push({ id, label, found: node !== null, drivable })
    }

    for (const door of DOORS) claim(door.node, `车门 ${door.node.slice(-2)}`)
    for (const mirror of MIRRORS) claim(mirror.node, `后视镜 ${mirror.node.slice(-2)}`)
    for (const steer of STEER_NODES) claim(steer, `转向节 ${steer.slice(-2)}`)
    for (const wheel of WHEEL_NODES) claim(wheel, `车轮 ${wheel.slice(-2)}`)

    const lights = collectLights(model)
    // 灯按角分散在多个 mesh 上,自检只报「共识别到几盏」,不逐个列节点名
    const headCount = lights.filter((slot) => slot.role === 'head').length
    const tailCount = lights.filter((slot) => slot.role === 'tail').length
    parts.push({ id: 'LIGHTS_HEAD', label: `大灯 ${headCount} 盏`, found: headCount > 0, drivable: true })
    parts.push({ id: 'LIGHTS_TAIL', label: `尾灯 ${tailCount} 盏`, found: tailCount > 0, drivable: true })
    parts.push({ id: 'LIGHTS_AMBIENT', label: '氛围灯', found: lights.some((s) => s.role === 'ambient'), drivable: true })

    return new CarView(model, groundOffsetY, parts, nodes, lights)
  }

  /** BodyView:挂进场景的根对象 */
  get object3d(): THREE.Object3D {
    return this.model
  }

  apply(view: AgentRenderView | null, deltaSeconds: number): void {
    if (!view) return
    const pose = view.pose
    this.model.visible = view.visible
    this.model.position.x = pose.x
    this.model.position.y = this.groundOffsetY + pose.y
    this.model.position.z = pose.z
    // 与无人机的航向约定一致:正北 0°、顺时针增加,而 three 里绕 Y 正转是逆时针,故取负。
    // 顺序用 YXZ:先定航向,再压俯仰/侧倾,避免三轴相互串扰。
    this.model.rotation.set(
      degToRad(pose.pitchDeg),
      -degToRad(pose.headingDeg),
      -degToRad(pose.rollDeg),
      'YXZ',
    )

    const parts = view.rig?.parts
    this.applyDoors(parts)
    this.applyMirrors(parts)
    this.applyWheels(parts)
    this.applyLights(view.lights, deltaSeconds)
  }

  /**
   * 四门独立开合。开度是**仿真状态**(领域层按机械速度演进),渲染层直接取用 ——
   * 渲染层再插一次值会让同一条动作出现两条时间线,画面总比 HUD 慢半拍。
   */
  private applyDoors(parts: AgentPartChannel | undefined): void {
    for (const door of DOORS) {
      const node = this.nodes.get(door.node)
      if (!node) continue
      node.rotation.y = degToRad(door.open * DOOR_OPEN_DEG * clamp01(parts?.[door.part] ?? 0))
    }
  }

  /** 后视镜折叠:同样 0~1,同样是领域层给的目标值 */
  private applyMirrors(parts: AgentPartChannel | undefined): void {
    for (const mirror of MIRRORS) {
      const node = this.nodes.get(mirror.node)
      if (!node) continue
      node.rotation.y = degToRad(mirror.fold * MIRROR_FOLD_DEG * clamp01(parts?.[mirror.part] ?? 0))
    }
  }

  /**
   * 转向与滚动:这两个是**连续运动量**,不是行程 ——
   * 转向角由领域层给(已平滑),车轮自转是累计角,渲染层不再二次插值,否则会甩尾。
   */
  private applyWheels(parts: AgentPartChannel | undefined): void {
    const steer = parts?.steer ?? 0
    const clamped = steer > MAX_STEER_DEG ? MAX_STEER_DEG : steer < -MAX_STEER_DEG ? -MAX_STEER_DEG : steer
    const steerRad = degToRad(clamped)
    for (const id of STEER_NODES) {
      const node = this.nodes.get(id)
      if (node) node.rotation.y = steerRad
    }

    const spinRad = degToRad(parts?.wheelSpin ?? 0)
    for (const id of WHEEL_NODES) {
      const node = this.nodes.get(id)
      if (node) node.rotation.x = spinRad
    }
  }

  /** 灯语:大灯/尾灯/氛围灯三类各自的目标强度,双闪时整组通断 */
  private applyLights(state: AgentRenderView['lights'], deltaSeconds: number): void {
    const pattern = isCarLightPattern(state?.pattern) ? state.pattern : 'off'
    const plan = LIGHT_PLANS[pattern]

    let blinkScale = 1
    if (plan.blink) {
      this.blinkPhase = (this.blinkPhase + deltaSeconds * BLINK_HZ) % 1
      blinkScale = this.blinkPhase < 0.5 ? 1 : 0
    } else {
      this.blinkPhase = 0
    }

    for (const slot of this.lights) {
      const level = plan[slot.role] * blinkScale
      if (level <= 0.001) {
        slot.material.emissive.copy(slot.baseEmissive)
        slot.material.emissiveIntensity = slot.baseIntensity
        continue
      }
      slot.material.emissive.copy(LIGHT_COLORS[slot.role])
      slot.material.emissiveIntensity = level * EMISSIVE_GAIN
    }
  }

  getPartReport(): ReadonlyArray<BodyPartReport> {
    return this.parts
  }

  get modelHealthText(): string {
    const missing = this.parts.filter((part) => !part.found)
    if (missing.length === 0) return `全部 ${this.parts.length} 项部件已识别`
    return `${this.parts.length - missing.length}/${this.parts.length} 项已识别,缺少:${missing
      .map((part) => part.label)
      .join('、')}`
  }

  dispose(): void {
    this.model.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry.dispose()
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) material.dispose()
    })
    this.model.parent?.remove(this.model)
    this.nodes.clear()
    this.lights.length = 0
  }
}

/** 收集车灯材质 —— 同角复制的材质各自独立,所以按材质去重后再分类 */
function collectLights(root: THREE.Object3D): LightSlot[] {
  const seen = new Set<THREE.Material>()
  const slots: LightSlot[] = []
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      if (!material || seen.has(material)) continue
      const role = lightRoleOf(material.name)
      if (!role) continue
      seen.add(material)
      const standard = material as THREE.MeshStandardMaterial
      slots.push({
        material: standard,
        role,
        baseEmissive: standard.emissive ? standard.emissive.clone() : new THREE.Color(0, 0, 0),
        baseIntensity: typeof standard.emissiveIntensity === 'number' ? standard.emissiveIntensity : 1,
      })
    }
  })
  return slots
}
