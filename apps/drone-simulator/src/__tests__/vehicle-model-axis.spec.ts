/**
 * 机体朝向对账:资产自述的轴向 ↔ 渲染层的摆正与符号约定。
 *
 * 这里真的错过一次,而且是一处根因、四处症状:特斯拉资产的出厂车头朝 **+Z**,
 * 而项目世界约定是「航向 0° = 北 = −Z」(无人机模型即如此),差 180° 没补,于是
 *   ① 车身「倒着开」——前进时车尾朝前;
 *   ② 四轮滚动方向反向——轮轴是机体 local X,跟着车体一起被镜像;
 *   ③ 上坡显示成下坡——俯仰发生在车体坐标系里;
 *   ④ 右侧压坡显示成左侧压坡——侧倾同理。
 * 只改渲染层一个常量就同时修好,是因为四者本就是同一件事。
 *
 * 所以这个文件把三方钉死,任何一边单独改动都要红:
 *   · 资产事实 —— 从 GLB 里**量**出来(大灯/尾灯/前后轮的 z,左后视镜的 x),不抄注释;
 *   · 渲染层摆正 —— CAR_ASSET_FACE_YAW_DEG 必须把车头摆到正北(−Z);
 *   · 符号约定 —— 姿态(航向/俯仰/侧倾)与转向的纯数学,不跑渲染器。
 * 领域层与渲染层的两份「转向限位」也在这里对齐。
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_VEHICLE_CONFIG } from '@simulation/vehicle-agent'
import {
  CAR_ASSET_FACE_YAW_DEG,
  CAR_MODEL_URL,
  DRONE_MODEL_URL,
  bodyRotationFromPose,
  steerNodeYawDeg,
} from '@simulation/three-adapter'

// —————————————————— 读 GLB:只取 JSON chunk,不动二进制几何 ——————————————————

interface GlbNode {
  readonly name?: string
  readonly mesh?: number
  readonly children?: ReadonlyArray<number>
  readonly translation?: ReadonlyArray<number>
  readonly rotation?: ReadonlyArray<number>
  readonly scale?: ReadonlyArray<number>
}

interface GlbAccessor {
  readonly min?: ReadonlyArray<number>
  readonly max?: ReadonlyArray<number>
}

interface GlbJson {
  readonly nodes: ReadonlyArray<GlbNode>
  readonly meshes: ReadonlyArray<{
    readonly primitives: ReadonlyArray<{ readonly attributes: Readonly<Record<string, number | undefined>> }>
  }>
  readonly accessors: ReadonlyArray<GlbAccessor>
}

interface GlbReader {
  /** 节点名 → 该 mesh 在模型自身坐标系里的包围盒 */
  boxOf(name: string): THREE.Box3
}

/** 从 vitest 的工作目录往上找 public/models(从包目录或仓库根启动都能找到) */
function findModelsDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 8; i += 1) {
    for (const candidate of [join(dir, 'public/models'), join(dir, 'apps/drone-simulator/public/models')]) {
      if (existsSync(join(candidate, basename(CAR_MODEL_URL)))) return candidate
    }
    dir = join(dir, '..')
  }
  throw new Error(`找不到模型目录(从 ${process.cwd()} 向上找了 8 层)`)
}

const num = (values: ReadonlyArray<number> | undefined, index: number, fallback: number): number =>
  values?.[index] ?? fallback

function createGlbReader(filePath: string): GlbReader {
  const buffer = readFileSync(filePath)
  const jsonLength = buffer.readUInt32LE(12)
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8')) as GlbJson
  const nodes = json.nodes

  const parentOf = new Int32Array(nodes.length).fill(-1)
  nodes.forEach((node, index) => {
    for (const child of node.children ?? []) parentOf[child] = index
  })

  /** 从节点往根累乘局部矩阵,得到它相对模型的变换 */
  const worldMatrixOf = (index: number): THREE.Matrix4 => {
    const chain: number[] = []
    for (let cursor = index; cursor >= 0; cursor = parentOf[cursor] ?? -1) chain.unshift(cursor)
    return chain.reduce((matrix, cursor) => {
      const node = nodes[cursor]
      if (!node) return matrix
      const local = new THREE.Matrix4().compose(
        new THREE.Vector3(num(node.translation, 0, 0), num(node.translation, 1, 0), num(node.translation, 2, 0)),
        new THREE.Quaternion(
          num(node.rotation, 0, 0),
          num(node.rotation, 1, 0),
          num(node.rotation, 2, 0),
          num(node.rotation, 3, 1),
        ),
        new THREE.Vector3(num(node.scale, 0, 1), num(node.scale, 1, 1), num(node.scale, 2, 1)),
      )
      return matrix.multiply(local)
    }, new THREE.Matrix4())
  }

  const boxOf = (name: string): THREE.Box3 => {
    const index = nodes.findIndex((node) => node.name === name)
    const node = nodes[index]
    if (!node) throw new Error(`${basename(filePath)} 里没有节点 ${name}`)
    const meshIndex = node.mesh
    if (meshIndex === undefined) throw new Error(`节点 ${name} 没有几何,无法量包围盒`)
    const mesh = json.meshes[meshIndex]
    if (!mesh) throw new Error(`节点 ${name} 引用了不存在的 mesh ${meshIndex}`)

    const matrix = worldMatrixOf(index)
    const box = new THREE.Box3()
    for (const primitive of mesh.primitives) {
      const positionIndex = primitive.attributes.POSITION
      if (positionIndex === undefined) continue
      const accessor = json.accessors[positionIndex]
      const min = accessor?.min
      const max = accessor?.max
      if (!min || !max) continue
      const [x0 = 0, y0 = 0, z0 = 0] = min
      const [x1 = 0, y1 = 0, z1 = 0] = max
      for (const x of [x0, x1]) {
        for (const y of [y0, y1]) {
          for (const z of [z0, z1]) {
            box.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(matrix))
          }
        }
      }
    }
    if (box.isEmpty()) throw new Error(`节点 ${name} 的包围盒是空的`)
    return box
  }

  return { boxOf }
}

const readers = new Map<string, GlbReader>()

function model(url: string): GlbReader {
  const cached = readers.get(url)
  if (cached) return cached
  const reader = createGlbReader(join(findModelsDir(), basename(url)))
  readers.set(url, reader)
  return reader
}

const centerOf = (reader: GlbReader, name: string): THREE.Vector3 =>
  reader.boxOf(name).getCenter(new THREE.Vector3())

/** 绕竖直轴转一个水平向量(正角 = 俯视图逆时针,与 three 的 rotation.y 同向) */
function rotateYaw(vector: THREE.Vector3, yawDeg: number): THREE.Vector3 {
  return vector.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), (yawDeg * Math.PI) / 180)
}

// ————————————————————————— 资产事实 —————————————————————————

describe('汽车资产自述的轴向', () => {
  it('车头朝 +Z:大灯在前、尾灯在后,前轮压在前轴', () => {
    const car = model(CAR_MODEL_URL)
    const headFront = centerOf(car, 'LIGHT_HEAD_FL_GEO').z
    const headFrontR = centerOf(car, 'LIGHT_HEAD_FR_GEO').z
    const tailRear = centerOf(car, 'LIGHT_TAIL_RL_GEO').z
    const tailRearR = centerOf(car, 'LIGHT_TAIL_RR_GEO').z
    const wheelFront = centerOf(car, 'WHEEL_FL_GEO').z
    const wheelRear = centerOf(car, 'WHEEL_RL_GEO').z

    expect(headFront).toBeGreaterThan(1)
    expect(headFrontR).toBeGreaterThan(1)
    expect(tailRear).toBeLessThan(-1)
    expect(tailRearR).toBeLessThan(-1)
    expect(wheelFront).toBeGreaterThan(wheelRear)
    // 轴距 2.88 m(真车 1:1),不是随手缩放出来的数
    expect(wheelFront - wheelRear).toBeCloseTo(2.88, 1)
  })

  it('车身左侧是 +X:左后视镜在 +X 侧', () => {
    const car = model(CAR_MODEL_URL)
    expect(centerOf(car, 'MIRROR_FL_GEO').x).toBeGreaterThan(0.8)
    expect(centerOf(car, 'MIRROR_FR_GEO').x).toBeLessThan(-0.8)
  })
})

describe('无人机资产自述的轴向', () => {
  it('前向是 −Z,与世界约定一致 —— 所以无人机不需要摆正', () => {
    const drone = model(DRONE_MODEL_URL)
    const lens = centerOf(drone, 'SENSOR_Glass_GimbalLens')
    expect(lens.z).toBeLessThan(0)
    // 云台在机身中线上,说明这是「正前」而不是某个斜角
    expect(Math.abs(lens.x)).toBeLessThan(0.5)
  })
})

// ————————————————————————— 渲染层摆正 —————————————————————————

describe('渲染层摆正:资产朝向 → 世界约定', () => {
  it('摆正后车头**精确**指向 −Z(北)', () => {
    const corrected = rotateYaw(new THREE.Vector3(0, 0, 1), CAR_ASSET_FACE_YAW_DEG)
    expect(corrected.z).toBeCloseTo(-1, 6)
    expect(corrected.x).toBeCloseTo(0, 6)
    expect(corrected.y).toBeCloseTo(0, 6)
  })

  it('摆正角正好是 180°:无人机 0°、汽车 180°,差别就在「前 = −Z」与「前 = +Z」', () => {
    expect(Math.abs(CAR_ASSET_FACE_YAW_DEG)).toBe(180)
  })
})

// ————————————————————————— 符号约定 —————————————————————————

/** 车体在机体根坐标系里的朝向:资产 +Z 被摆正 180° 后落在 −Z */
const NOSE_IN_BODY = new THREE.Vector3(0, 0, -1)
/** 车体右侧:资产的左(+X)被摆正翻到了 −X,所以右侧是 +X */
const RIGHT_IN_BODY = new THREE.Vector3(1, 0, 0)

type Pose = Parameters<typeof bodyRotationFromPose>[0]

const noseAt = (pose: Pose): THREE.Vector3 => NOSE_IN_BODY.clone().applyEuler(bodyRotationFromPose(pose))
const rightAt = (pose: Pose): THREE.Vector3 => RIGHT_IN_BODY.clone().applyEuler(bodyRotationFromPose(pose))

/** 造一个只关心姿态角、位置随便的 pose(位置由模式写入,与旋转无关) */
const poseOf = (angles: Pick<Pose, 'headingDeg' | 'pitchDeg' | 'rollDeg'>): Pose => ({
  x: 0,
  y: 0,
  z: 0,
  ...angles,
})

describe('姿态符号', () => {
  it('航向 0° = 北(−Z),90° = 东(+X)', () => {
    const north = noseAt(poseOf({ headingDeg: 0, pitchDeg: 0, rollDeg: 0 }))
    expect(north.z).toBeCloseTo(-1, 6)
    const east = noseAt(poseOf({ headingDeg: 90, pitchDeg: 0, rollDeg: 0 }))
    expect(east.x).toBeCloseTo(1, 6)
    expect(east.z).toBeCloseTo(0, 6)
  })

  it('正俯仰 = 抬头(与 AgentBodyPose 的约定一致)', () => {
    expect(noseAt(poseOf({ headingDeg: 0, pitchDeg: 30, rollDeg: 0 })).y).toBeGreaterThan(0)
    expect(noseAt(poseOf({ headingDeg: 0, pitchDeg: -30, rollDeg: 0 })).y).toBeLessThan(0)
  })

  it('正侧倾 = 右压坡:车身右侧下沉(与 AgentBodyPose 的约定一致)', () => {
    expect(rightAt(poseOf({ headingDeg: 0, pitchDeg: 0, rollDeg: 20 })).y).toBeLessThan(0)
    expect(rightAt(poseOf({ headingDeg: 0, pitchDeg: 0, rollDeg: -20 })).y).toBeGreaterThan(0)
  })
})

describe('转向符号', () => {
  it('左转(steerDeg < 0)时前轮指向车身左侧(+X_asset),右转相反', () => {
    // 车身左侧 = +X_asset,由「左后视镜在 +X 侧」那条确认
    expect(rotateYaw(new THREE.Vector3(0, 0, 1), steerNodeYawDeg(-20)).x).toBeGreaterThan(0)
    expect(rotateYaw(new THREE.Vector3(0, 0, 1), steerNodeYawDeg(20)).x).toBeLessThan(0)
  })

  it('转向限位与领域层 maxSteerDeg 一致(两份常量必须同步)', () => {
    expect(Math.abs(steerNodeYawDeg(999))).toBe(DEFAULT_VEHICLE_CONFIG.maxSteerDeg)
    expect(Math.abs(steerNodeYawDeg(-999))).toBe(DEFAULT_VEHICLE_CONFIG.maxSteerDeg)
    // 反号会产出 −0,而 `toBe(0)` 用的是 Object.is,不认负零,所以按数值比
    expect(steerNodeYawDeg(0)).toBeCloseTo(0, 12)
  })
})
