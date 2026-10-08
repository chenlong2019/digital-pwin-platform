/**
 * 载荷瞄准解算 —— 「把镜头对准世界系一个点」到「云台俯仰/偏航给多少度」。
 *
 * 为什么单独成文件:这是**领域几何**,不是渲染也不是任务。它只依赖平台契约里的
 * 坐标约定(§: +X 东 / +Y 上 / −Z 北,航向 0° = 北、顺时针增加)与机型云台行程,
 * 因此可以脱离 Agent、脱离 three 单独验证 —— 对着一个已知点算出来的角度是错的,
 * 一个纯函数单测就能抓住,不必靠肉眼看画面。
 *
 * 三个符号约定(踩过才知道要写清楚):
 *   ① `elevationDeg` 正 = 目标在水平面之上(与 `gimbalPitch` 的「正 = 抬头」同号,可直接用);
 *   ② `yawErrorDeg`   正 = 目标在机头**右侧**(罗盘顺时针方向);
 *   ③ `yawDeg`        正 = 云台向**左**偏 —— 因为模型机头朝局部 −Z,绕 +Y 正转
 *      指向罗盘负方向,所以「目标在右」必须给负偏航。见 `solveAim` 里的取负。
 *
 * 行程不够时**不假装对准**:俯仰/偏航各自限幅,残余误差如实报在 `aimErrorDeg` 里。
 * 观测类任务据此判断「这拍点作废,得改机位」,而不是拿一张歪着的图去判缺陷。
 */
import type { Vec3 } from '@simulation/contracts'
import { vectorToHeading } from '@simulation/contracts'
import { DRONE_SPEC } from './drone-sim'

/** 认为「对准了」的残余方位误差容差(度) */
export const AIM_ALIGN_TOLERANCE_DEG = 5

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const radToDeg = (rad: number): number => (rad * 180) / Math.PI

/** 从 from 转到 to 的最短角度差,范围 (−180, 180] */
function shortestAngle(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180
}

/** 一次瞄准的解算结果 —— 全部是可直接回显/可断言的标量 */
export interface AimSolution {
  /** 目标方位(罗盘,0 = 北 90 = 东) */
  readonly bearingDeg: number
  /** 目标仰角(度,正 = 在水平面之上) */
  readonly elevationDeg: number
  /** 目标到机体的水平距离(米) */
  readonly distanceM: number
  /** 目标到机体的直线距离(米) */
  readonly rangeM: number
  /** 云台俯仰(度,已按行程限幅;正 = 抬头) */
  readonly pitchDeg: number
  /** 云台偏航(度,已按行程限幅;正 = 向左) */
  readonly yawDeg: number
  /** 机头与目标方位的夹角(度,未限幅;正 = 目标在右) */
  readonly yawErrorDeg: number
  /**
   * 限幅后镜头方向与目标方位的残余夹角(度,正 = 还差这么多向右)。
   * 0 = 云台在行程内把目标对准了。
   */
  readonly aimErrorDeg: number
  readonly pitchLimited: boolean
  readonly yawLimited: boolean
  readonly aligned: boolean
}

export interface AimSolveInput {
  /** 机体世界坐标(不是相对起飞点的偏移) */
  readonly drone: Vec3
  /** 机体世界航向(罗盘) */
  readonly headingDeg: number
  /** 目标世界坐标 */
  readonly target: Vec3
}

/** 解算一次瞄准:目标 → 云台俯仰/偏航 + 残余误差 */
export function solveAim(input: AimSolveInput): AimSolution {
  const dx = input.target.x - input.drone.x
  const dy = input.target.y - input.drone.y
  const dz = input.target.z - input.drone.z

  const distanceM = Math.hypot(dx, dz)
  const rangeM = Math.hypot(dx, dy, dz)
  /**
   * 目标在正上/正下方时方位角**无定义** —— `atan2(0, 0)` 的取值只反映 ±0 的符号,
   * 与几何无关。这时「转机身对准」这件事本身没有意义(俯拍塔基就是这种姿态),
   * 所以直接把方位角当作机头当前朝向:偏航误差 0,只靠俯仰看目标。
   * 不加这一条的话,正下方目标会凭空报出 ~175° 的残余误差,把一次俯拍判成没对准。
   */
  const bearingDeg = distanceM < 1e-6 ? input.headingDeg : vectorToHeading(dx, dz)
  // 正上方/正下方时水平距离为 0:atan2 仍然给 ±90°,不需要特判
  const elevationDeg = radToDeg(Math.atan2(dy, distanceM))

  const yawErrorDeg = shortestAngle(input.headingDeg, bearingDeg)

  const pitchDeg = clamp(elevationDeg, DRONE_SPEC.gimbalPitchMin, DRONE_SPEC.gimbalPitchMax)
  // 取负的理由见文件头 ③:云台正偏航指向罗盘负方向,所以「目标在右」要给负值
  const yawDeg = clamp(-yawErrorDeg, -DRONE_SPEC.gimbalYawRange, DRONE_SPEC.gimbalYawRange)

  const pitchLimited = Math.abs(pitchDeg - elevationDeg) > 1e-6
  const yawLimited = Math.abs(yawDeg + yawErrorDeg) > 1e-6
  const aimErrorDeg = yawErrorDeg + yawDeg

  return {
    bearingDeg,
    elevationDeg,
    distanceM,
    rangeM,
    pitchDeg,
    yawDeg,
    yawErrorDeg,
    aimErrorDeg,
    pitchLimited,
    yawLimited,
    aligned: isAimAligned({ aimErrorDeg, pitchLimited }),
  }
}

/** 瞄准状态快照 —— 供 UI 显示「云台现在对着哪儿、差多少」 */
export interface AimSnapshot extends AimSolution {
  readonly target: Vec3
  readonly label: string
  /** 是否随动重算 */
  readonly track: boolean
}

/** 判断一组角度是否算「对准」——任务与界面各自决定要不要用同一把尺子 */
export function isAimAligned(solution: Pick<AimSolution, 'aimErrorDeg' | 'pitchLimited'>): boolean {
  return Math.abs(solution.aimErrorDeg) <= AIM_ALIGN_TOLERANCE_DEG && !solution.pitchLimited
}
