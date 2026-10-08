/**
 * VehicleSim —— 轮式载具仿真内核(**纯逻辑,零 import**)。
 *
 * 与 DroneSim 同处 Core 之外、Domain 之内的位置:不带任何 UI / 渲染 / 网络依赖,
 * 所以能在纯 Node 里跑确定性验收。
 *
 * 物理选型:用**自行车模型** —— 前轮转角 δ 决定航向变化率 θ̇ = v/L·tan(δ)。
 * 选它而不是四轮独立模型,是因为模型实测轴距 2.88 m、轮半径 0.33 m 都是真车值,
 * 自行车模型在这个尺度上的转向手感与真车一致,而计算量只有后者的零头。
 *
 * 与 DroneSim 的结构差异:
 *   · 没有高度自由度 —— 车贴地,y 由地形高度给出,俯仰/侧倾由地形坡度算出
 *   · 没有姿态环 —— 不存在「悬停」,速度到 0 就是停住
 *   · 有挡位 —— 前进/倒车由 gear 决定,方向盘打死也不会自己倒着走
 */

export type GearPosition = 'P' | 'R' | 'N' | 'D'

/** 汽车灯语 —— 与 three-adapter 的 CAR_LIGHT_PATTERNS 逐项对应,两侧靠测试对账 */
export const VEHICLE_LIGHT_PATTERNS = ['off', 'position', 'low', 'high', 'hazard'] as const
export type VehicleLightPattern = (typeof VEHICLE_LIGHT_PATTERNS)[number]

export type VehiclePhase = 'powerOff' | 'standby' | 'ready' | 'moving' | 'parked'

/** 四门开度 0~1(0 = 关闭) */
export interface DoorSet {
  FL: number
  FR: number
  RL: number
  RR: number
}

/** 后视镜折叠度 0~1(0 = 展开) */
export interface MirrorSet {
  L: number
  R: number
}

export type DoorKey = keyof DoorSet
export type MirrorKey = keyof MirrorSet

export const DOOR_KEYS: ReadonlyArray<DoorKey> = ['FL', 'FR', 'RL', 'RR']
export const MIRROR_KEYS: ReadonlyArray<MirrorKey> = ['L', 'R']

export interface VehicleSimEvent {
  readonly id: number
  /** 事件发生的仿真时刻(秒) */
  readonly time: number
  readonly level: 'info' | 'warn' | 'error' | 'success'
  readonly text: string
}

export interface VehicleConfig {
  /** 最高车速 m/s(30 ≈ 108 km/h) */
  maxSpeedMps: number
  /** 倒车最高车速 m/s */
  maxReverseMps: number
  maxAccelMps2: number
  maxBrakeMps2: number
  /** 空气阻力系数(线性近似) */
  dragCoef: number
  /** 滚动阻力减速度 m/s² */
  rollResistMps2: number
  /** 轴距 m —— 取自模型实测,不是真车手册值 */
  wheelbaseM: number
  /** 轮胎半径 m —— 同上 */
  wheelRadiusM: number
  maxSteerDeg: number
  /** 方向盘每秒能打多少度(决定转向手感) */
  steerSpeedDegPerSec: number
  /** 门 / 后视镜每秒开合的比例(0~1) */
  doorSpeedPerSec: number
  /** 怠速耗电 %/s */
  idleDrainPerSec: number
  /** 全油门额外耗电 %/s */
  driveDrainPerSec: number
}

export const DEFAULT_VEHICLE_CONFIG: VehicleConfig = {
  maxSpeedMps: 30,
  maxReverseMps: 8,
  maxAccelMps2: 4.5,
  maxBrakeMps2: 9,
  dragCoef: 0.02,
  rollResistMps2: 0.6,
  wheelbaseM: 2.88,
  wheelRadiusM: 0.33,
  maxSteerDeg: 26,
  steerSpeedDegPerSec: 90,
  doorSpeedPerSec: 1.4,
  idleDrainPerSec: 0.004,
  driveDrainPerSec: 0.02,
}

const RAD2DEG = 180 / Math.PI
const DEG2RAD = Math.PI / 180
/** 低于这个速度认为车已停住(避免浮点残值让车永远"在动") */
const REST_SPEED = 0.02

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** 车辆相位标签 —— 给 HUD 用,判定留在领域层(是产品行为,不是渲染细节) */
const PHASE_LABELS: Record<VehiclePhase, string> = {
  powerOff: '未上电',
  standby: '待驶(门未关)',
  ready: '可行驶',
  moving: '行驶中',
  parked: '驻车',
}

const GEAR_LABELS: Record<GearPosition, string> = {
  P: 'P 驻车',
  R: 'R 倒车',
  N: 'N 空挡',
  D: 'D 前进',
}

const LIGHT_LABELS: Record<VehicleLightPattern, string> = {
  off: '关闭',
  position: '示宽灯',
  low: '近光灯',
  high: '远光灯',
  hazard: '双闪',
}

export interface VehicleSnapshot {
  readonly phase: VehiclePhase
  readonly phaseLabel: string
  readonly powered: boolean
  readonly gear: GearPosition
  readonly gearLabel: string
  /** 任一门未关严 —— 行驶检查单用 */
  readonly doorsOpen: boolean
  readonly speedMps: number
  readonly speedKph: number
  readonly steerDeg: number
  readonly heading: number
  /** 相对原点的水平坐标:x 向东,z 向南(与模型坐标一致) */
  readonly positionX: number
  readonly positionZ: number
  /** 当前所在位置的地面高度(米) */
  readonly altitude: number
  readonly pitchDeg: number
  readonly rollDeg: number
  readonly wheelSpinDeg: number
  readonly odometerM: number
  readonly throttle: number
  readonly brake: number
  readonly batteryPercent: number
  readonly lightPattern: VehicleLightPattern
  readonly lightPatternLabel: string
  readonly doors: DoorSet
  readonly mirrors: MirrorSet
  /** 最近的事件(滚动窗口,最多 12 条) */
  readonly events: ReadonlyArray<VehicleSimEvent>
}

/** 碰撞检测用的轴对齐盒 —— 结构来自契约层,这里只消费 */
export interface VehicleObstacle {
  readonly name: string
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  readonly solid: boolean
}

const MAX_EVENTS = 12

export class VehicleSim {
  config: VehicleConfig
  obstacles: VehicleObstacle[] = []

  // —— 动力与行驶 ——
  powered = false
  gear: GearPosition = 'P'
  speedMps = 0
  throttle = 0
  /** 制动 0~1 */
  brake = 0
  steerDeg = 0
  steerTargetDeg = 0
  headingDeg = 0
  /** 相对原点的位置:x 向东,z 向南 */
  x = 0
  z = 0
  /** 当前地面高度 */
  y = 0
  pitchDeg = 0
  rollDeg = 0
  wheelSpinDeg = 0
  odometerM = 0
  batteryPercent = 100

  // —— 车身可动件 ——
  doors: DoorSet = { FL: 0, FR: 0, RL: 0, RR: 0 }
  doorsTarget: DoorSet = { FL: 0, FR: 0, RL: 0, RR: 0 }
  mirrors: MirrorSet = { L: 0, R: 0 }
  mirrorsTarget: MirrorSet = { L: 0, R: 0 }
  lightPattern: VehicleLightPattern = 'off'

  time = 0

  private eventSeq = 0
  private readonly eventLog: VehicleSimEvent[] = []

  constructor(config: Partial<VehicleConfig> = {}) {
    this.config = { ...DEFAULT_VEHICLE_CONFIG, ...config }
  }

  // ————————————————————————————— 事件 —————————————————————————————

  private emit(level: VehicleSimEvent['level'], text: string): void {
    this.eventSeq += 1
    this.eventLog.push({ id: this.eventSeq, time: this.time, level, text })
    if (this.eventLog.length > MAX_EVENTS) this.eventLog.shift()
  }

  // ————————————————————————————— 推进 —————————————————————————————

  /**
   * 推进一个固定步长。坡道俯仰/侧倾需要读地形,所以调用方在 step 之前
   * 先把 terrainAt 回调换掉(见 VehicleAgent.update)。
   */
  step(dt: number, terrainAt?: (x: number, z: number) => number): void {
    this.time += dt

    if (this.powered) {
      this.integrate(dt)
      this.drainBattery(dt)
    } else {
      // 熄火后靠阻力自然停下
      this.coast(dt)
    }

    this.actuateSteer(dt)
    this.actuateDoors(dt)
    this.actuateMirrors(dt)

    if (terrainAt) this.settleOnTerrain(terrainAt)
  }

  /** 纵向动力学 + 自行车模型 */
  private integrate(dt: number): void {
    const cfg = this.config
    const gearSign = this.gear === 'R' ? -1 : this.gear === 'D' ? 1 : 0

    let accel = 0
    if (gearSign !== 0) accel += gearSign * clamp01(this.throttle) * cfg.maxAccelMps2

    // 制动:只往 0 收,不倒拖(否则刹车会让车倒着跑)
    if (this.brake > 0) {
      const decel = cfg.maxBrakeMps2 * clamp01(this.brake)
      const toZero = Math.abs(this.speedMps) / Math.max(dt, 1e-6)
      accel -= Math.sign(this.speedMps) * Math.min(decel, toZero)
    }

    // 阻力
    accel -= this.speedMps * cfg.dragCoef
    if (Math.abs(this.speedMps) > REST_SPEED) accel -= Math.sign(this.speedMps) * cfg.rollResistMps2

    let next = this.speedMps + accel * dt
    // 阻力不该把车推向反方向
    if (this.throttle <= 0.001 && this.brake <= 0.001) {
      if (this.speedMps >= 0 && next < 0) next = 0
      if (this.speedMps <= 0 && next > 0) next = 0
    }
    next = clamp(next, -cfg.maxReverseMps, cfg.maxSpeedMps)
    if (Math.abs(next) < REST_SPEED && this.throttle <= 0.001) next = 0
    this.speedMps = next

    // 自行车模型:θ̇ = v/L · tan(δ),δ 正 = 前轮右偏
    if (Math.abs(this.speedMps) > 0.05) {
      const steerRad = this.steerDeg * DEG2RAD
      this.headingDeg = wrap360(
        this.headingDeg + (this.speedMps / cfg.wheelbaseM) * Math.tan(steerRad) * RAD2DEG * dt,
      )
    }

    // 位移:与契约层 headingToVector 同一套约定(0° = 北 = −Z,90° = 东 = +X)
    const rad = this.headingDeg * DEG2RAD
    const dx = Math.sin(rad) * this.speedMps * dt
    const dz = -Math.cos(rad) * this.speedMps * dt

    if (this.blockedAt(this.x + dx, this.z + dz)) {
      // 撞上实体障碍:停住并留一条事件,不做穿透
      if (Math.abs(this.speedMps) > 0.5) this.emit('warn', '前方障碍物,已停车')
      this.speedMps = 0
    } else {
      this.x += dx
      this.z += dz
      this.odometerM += Math.abs(this.speedMps) * dt
      this.wheelSpinDeg += (this.speedMps / cfg.wheelRadiusM) * RAD2DEG * dt
    }
  }

  /** 断电后的滑行:只剩阻力 */
  private coast(dt: number): void {
    if (Math.abs(this.speedMps) < 1e-4) {
      this.speedMps = 0
      return
    }
    const decel = this.config.rollResistMps2 + Math.abs(this.speedMps) * this.config.dragCoef
    const step = decel * dt
    this.speedMps = Math.abs(this.speedMps) <= step ? 0 : this.speedMps - Math.sign(this.speedMps) * step
  }

  private blockedAt(x: number, z: number): boolean {
    for (const box of this.obstacles) {
      if (!box.solid) continue
      if (x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ) return true
    }
    return false
  }

  /** 贴地 + 用前后/左右地形高差算坡道俯仰与侧倾 */
  private settleOnTerrain(terrainAt: (x: number, z: number) => number): void {
    this.y = terrainAt(this.x, this.z)
    const rad = this.headingDeg * DEG2RAD
    const fx = Math.sin(rad)
    const fz = -Math.cos(rad)
    const probe = 2

    const ahead = terrainAt(this.x + fx * probe, this.z + fz * probe)
    const behind = terrainAt(this.x - fx * probe, this.z - fz * probe)
    this.pitchDeg = Math.atan2(ahead - behind, probe * 2) * RAD2DEG

    const leftX = this.x - fz * probe
    const leftZ = this.z + fx * probe
    const rightX = this.x + fz * probe
    const rightZ = this.z - fx * probe
    const leftH = terrainAt(leftX, leftZ)
    const rightH = terrainAt(rightX, rightZ)
    // 正 = 右压坡,与航空惯例一致(右侧低则右倾)
    this.rollDeg = -Math.atan2(leftH - rightH, probe * 2) * RAD2DEG
  }

  private drainBattery(dt: number): void {
    const drain = this.config.idleDrainPerSec + clamp01(this.throttle) * this.config.driveDrainPerSec
    const next = this.batteryPercent - drain * dt
    this.batteryPercent = next < 0 ? 0 : next
    if (this.batteryPercent === 0 && this.gear !== 'P') {
      // 强制驻车:不能走 setGear()(那里的停稳检查会挡住行驶中的车),直接锁止
      this.gear = 'P'
      this.speedMps = 0
      this.throttle = 0
      this.emit('error', '电量耗尽,已自动驻车')
    }
  }

  private actuateSteer(dt: number): void {
    const maxStep = this.config.steerSpeedDegPerSec * dt
    const diff = clamp(this.steerTargetDeg, -this.config.maxSteerDeg, this.config.maxSteerDeg) - this.steerDeg
    this.steerDeg += clamp(diff, -maxStep, maxStep)
  }

  private actuateDoors(dt: number): void {
    const step = this.config.doorSpeedPerSec * dt
    for (const key of DOOR_KEYS) {
      const diff = clamp01(this.doorsTarget[key]) - this.doors[key]
      this.doors[key] = clamp01(this.doors[key] + clamp(diff, -step, step))
    }
  }

  private actuateMirrors(dt: number): void {
    const step = this.config.doorSpeedPerSec * dt
    for (const key of MIRROR_KEYS) {
      const diff = clamp01(this.mirrorsTarget[key]) - this.mirrors[key]
      this.mirrors[key] = clamp01(this.mirrors[key] + clamp(diff, -step, step))
    }
  }

  // ————————————————————————————— 指令执行(由 Agent 调用) —————————————————————————————

  setPower(on: boolean): void {
    if (this.powered === on) return
    this.powered = on
    if (!on) {
      this.throttle = 0
      this.gear = 'P'
      this.steerTargetDeg = 0
      this.lightPattern = 'off'
      this.emit('info', '已断电')
    } else {
      this.emit('success', '已上电,系统自检通过')
    }
  }

  setGear(gear: GearPosition): void {
    if (!this.powered) {
      this.emit('warn', '未上电,无法换挡')
      return
    }
    if (gear === this.gear) return
    // 真车规则:有速度时不许挂 P
    if (gear === 'P' && Math.abs(this.speedMps) > 0.3) {
      this.emit('warn', '车辆未停稳,无法挂 P 挡')
      return
    }
    this.gear = gear
    // 驻车锁止:P 挡意味着变速器机械锁死,车立即失去滚动能力。
    // 手动挂 P 前有停稳检查,这里只会把 0.3 m/s 以内的残速清零;
    // 电量耗尽的强制驻车则靠这一行真正把车按停,而不是继续滑行几十米。
    if (gear === 'P') this.speedMps = 0
    if (gear !== 'D' && gear !== 'R') this.throttle = 0
    this.emit('info', `换挡 → ${GEAR_LABELS[gear]}`)
  }

  /** 油门/刹车(归一化),来自虚拟摇杆或键盘 */
  setDrive(throttle: number, brake = 0): void {
    if (!this.powered) return
    const next = clamp01(throttle)
    if (next > 0.01 && this.gear !== 'D' && this.gear !== 'R') {
      this.gear = 'D'
      this.emit('info', '起步:自动挂入 D 挡')
    }
    this.throttle = next
    this.brake = clamp01(brake)
  }

  setSteer(deg: number): void {
    this.steerTargetDeg = clamp(deg, -this.config.maxSteerDeg, this.config.maxSteerDeg)
  }

  setDoor(key: DoorKey, open: number): void {
    this.doorsTarget[key] = clamp01(open)
  }

  setAllDoors(open: number): void {
    for (const key of DOOR_KEYS) this.doorsTarget[key] = clamp01(open)
  }

  setMirror(key: MirrorKey, folded: number): void {
    this.mirrorsTarget[key] = clamp01(folded)
  }

  setAllMirrors(folded: number): void {
    for (const key of MIRROR_KEYS) this.mirrorsTarget[key] = clamp01(folded)
  }

  setLights(pattern: VehicleLightPattern): void {
    this.lightPattern = pattern
  }

  forceBattery(percent: number): void {
    this.batteryPercent = clamp(percent, 0, 100)
  }

  reset(): void {
    this.powered = false
    this.gear = 'P'
    this.speedMps = 0
    this.throttle = 0
    this.brake = 0
    this.steerDeg = 0
    this.steerTargetDeg = 0
    this.headingDeg = 0
    this.x = 0
    this.z = 0
    this.y = 0
    this.pitchDeg = 0
    this.rollDeg = 0
    this.wheelSpinDeg = 0
    this.odometerM = 0
    this.batteryPercent = 100
    this.doors = { FL: 0, FR: 0, RL: 0, RR: 0 }
    this.doorsTarget = { FL: 0, FR: 0, RL: 0, RR: 0 }
    this.mirrors = { L: 0, R: 0 }
    this.mirrorsTarget = { L: 0, R: 0 }
    this.lightPattern = 'off'
    this.time = 0
    this.eventLog.length = 0
    this.emit('info', '整车已复位')
  }

  // ————————————————————————————— 快照 —————————————————————————————

  private phase(): VehiclePhase {
    if (!this.powered) return 'powerOff'
    if (Math.abs(this.speedMps) > 0.3) return 'moving'
    if (this.gear === 'P') return 'parked'
    return DOOR_KEYS.some((key) => this.doors[key] > 0.02) ? 'standby' : 'ready'
  }

  snapshot(): VehicleSnapshot {
    const phase = this.phase()
    return {
      phase,
      phaseLabel: PHASE_LABELS[phase],
      powered: this.powered,
      gear: this.gear,
      gearLabel: GEAR_LABELS[this.gear],
      doorsOpen: DOOR_KEYS.some((key) => this.doors[key] > 0.02),
      speedMps: this.speedMps,
      speedKph: this.speedMps * 3.6,
      steerDeg: this.steerDeg,
      heading: this.headingDeg,
      positionX: this.x,
      positionZ: this.z,
      altitude: this.y,
      pitchDeg: this.pitchDeg,
      rollDeg: this.rollDeg,
      wheelSpinDeg: this.wheelSpinDeg,
      odometerM: this.odometerM,
      throttle: this.throttle,
      brake: this.brake,
      batteryPercent: this.batteryPercent,
      lightPattern: this.lightPattern,
      lightPatternLabel: LIGHT_LABELS[this.lightPattern],
      doors: { ...this.doors },
      mirrors: { ...this.mirrors },
      events: [...this.eventLog],
    }
  }
}
