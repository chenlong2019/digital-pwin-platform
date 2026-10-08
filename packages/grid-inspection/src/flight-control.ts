/**
 * 航段控制律 —— 「朝一个点飞」「原地转机身」「定点悬停」三件事,各自一个纯函数。
 *
 * 为什么是纯函数:这三段是整条巡检里唯一会让无人机撞塔的部分,必须能脱离
 * 仿真单独验。输入当前位姿与目标,输出一根摇杆量 —— 没有内部状态、没有时间,
 * 于是「给定这个位姿,杆量应该是多少」可以直接断言,而不是靠飞一遍看画面。
 *
 * ⚠️ 与 `task-core` 的 `WaypointTask` 巡航段是**同一套控制律的第二次实现**:
 * 高度优先 → 机头对准后再推进 → 前方探测到高障碍先爬过去。三条都是实测出来的
 * (见 WaypointTask 文件头),这里照搬不改。之所以没有抽成公共模块:WaypointTask
 * 那份与它的阶段机、绕飞滞回状态耦合较深,一次性抽出会动到已验收的任务;
 * 按「三次成律」的规矩,等第三个任务落地时再收敛,那时两处的差异也看得更清楚。
 *
 * 坐标与角度沿用平台约定:世界系 +X 东 / +Y 上 / −Z 北;航向 0° = 北、顺时针。
 * 摇杆量是**机体系**归一化值:正 forward = 向机头方向,正 right = 向机头右侧。
 */

import type { Vec3 } from '@simulation/contracts'
import { headingToVector, vectorToHeading } from '@simulation/contracts'

/** 控制律整定量:三处共用,改一处即改全 */
export const SEGMENT_TUNING = {
  /** 满舵偏航对应的航向误差(度) */
  yawFullScaleDeg: 60,
  /** 前进满舵对应的距离(米) */
  forwardFullScaleM: 6,
  /** 高度误差满舵对应的高度差(米) */
  altitudeFullScaleM: 2,
  /** 航向误差超过该角度就先转再走(度) */
  alignThresholdDeg: 45,
  /** 前方探测距离(米) */
  obstacleProbeM: 20,
  /** 飞越障碍物时在最高点之上留的余量(米) */
  obstacleClearanceM: 3,
  /** 下降侧最大杆量(比爬升小,落地/下降更柔) */
  maxDescendCommand: -0.6,
  /** 定点保持的杆量上限:修正漂移不该用大杆 */
  holdCommandLimit: 0.4,
  /** 定点保持的高度杆量上限 */
  holdAltitudeLimit: 0.3,
  /** 定点保持的航向死区(度):一点点偏差不值得动杆 */
  holdHeadingDeadbandDeg: 3,
} as const

/** 一根摇杆量(平台 agent.move 的载荷形状) */
export interface FlightCommand {
  readonly forward: number
  readonly right: number
  readonly up: number
  readonly yawRate: number
}

export const HOVER_COMMAND: FlightCommand = { forward: 0, right: 0, up: 0, yawRate: 0 }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 从 from 转到 to 的最短角度差,范围 (−180, 180] */
function shortestAngle(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180
}

/** 前方探测回调:任务把 SandboxQuery 的 raycast 包成这个形状传进来 */
export type ObstacleProbe = (
  direction: { x: number; z: number },
  maxDistanceM: number,
) => { label: string; maxY: number; distanceM: number } | null

export interface ApproachInput {
  readonly position: Vec3
  readonly headingDeg: number
  readonly target: Vec3
  readonly arriveRadiusM: number
  readonly altitudeToleranceM: number
  /** 上一 tick 为绕飞抬高的目标高度(滞回),null = 无 */
  readonly avoidAltitudeM: number | null
  readonly probeAhead?: ObstacleProbe
}

export interface ApproachSolution {
  readonly command: FlightCommand
  /** 与目标的水平距离(米) */
  readonly distanceM: number
  /** 本 tick 采用的目标高度(米,含绕飞抬高) */
  readonly targetAltitudeM: number
  /** 传给下一 tick 的绕飞高度(滞回用) */
  readonly avoidAltitudeM: number | null
  readonly altitudeErrorM: number
  /** 机头与「目标方位」的夹角(度,正 = 目标在右) */
  readonly headingErrorDeg: number
  readonly altitudeSettled: boolean
  /** 水平到位且高度到位 —— 不含航向 */
  readonly arrived: boolean
  /** 本 tick 新产生的绕飞提示(供任务写日志),没有则 null */
  readonly advisory: string | null
}

/**
 * 飞向一个点:高度优先 → 机头对准目标 → 按距离比例推进。
 *
 * 「高度优先」这一条是实测踩出来的:边爬边平移会在低空撞进障碍物高度带,
 * 所以只要高度没到位,就**只动升降、不动水平**。
 */
export function planApproach(input: ApproachInput): ApproachSolution {
  const distanceM = Math.hypot(input.target.x - input.position.x, input.target.z - input.position.z)
  const bearingToTarget = vectorToHeading(
    input.target.x - input.position.x,
    input.target.z - input.position.z,
  )

  let targetAltitudeM = input.target.y
  let avoidAltitudeM = input.avoidAltitudeM
  let advisory: string | null = null

  if (avoidAltitudeM !== null) {
    // 滞回:本航段已经决定飞越的高度就一直用,否则会「飞过去 → 降回来 → 又探测到」来回抖
    targetAltitudeM = Math.max(avoidAltitudeM, targetAltitudeM)
  } else {
    const probeDistance = Math.min(distanceM, SEGMENT_TUNING.obstacleProbeM)
    if (input.probeAhead && probeDistance >= 3) {
      const direction = headingToVector(bearingToTarget)
      const hit = input.probeAhead({ x: direction.x, z: direction.z }, probeDistance)
      if (hit) {
        const overAltitude = hit.maxY + SEGMENT_TUNING.obstacleClearanceM
        if (overAltitude > targetAltitudeM) {
          avoidAltitudeM = overAltitude
          targetAltitudeM = overAltitude
          advisory = `前方 ${hit.distanceM.toFixed(1)} 米有「${hit.label}」,爬升到 ${overAltitude.toFixed(1)} 米飞越`
        }
      }
    }
  }

  const altitudeErrorM = targetAltitudeM - input.position.y
  const altitudeSettled = Math.abs(altitudeErrorM) <= input.altitudeToleranceM
  const headingErrorDeg = shortestAngle(input.headingDeg, bearingToTarget)

  if (!altitudeSettled) {
    return {
      command: {
        forward: 0,
        right: 0,
        up: clamp(
          altitudeErrorM / SEGMENT_TUNING.altitudeFullScaleM,
          SEGMENT_TUNING.maxDescendCommand,
          1,
        ),
        yawRate: 0,
      },
      distanceM,
      targetAltitudeM,
      avoidAltitudeM,
      altitudeErrorM,
      headingErrorDeg,
      altitudeSettled,
      arrived: false,
      advisory,
    }
  }

  const yawRate = clamp(headingErrorDeg / SEGMENT_TUNING.yawFullScaleDeg, -1, 1)
  const aligned = Math.abs(headingErrorDeg) < SEGMENT_TUNING.alignThresholdDeg
  return {
    command: {
      // 没对准就先原地转:航点飞行的手感就是这样,也能避免斜着切进航线
      forward: aligned ? clamp(distanceM / SEGMENT_TUNING.forwardFullScaleM, 0, 1) : 0,
      right: 0,
      up: clamp(altitudeErrorM / SEGMENT_TUNING.altitudeFullScaleM, SEGMENT_TUNING.maxDescendCommand, 1),
      yawRate,
    },
    distanceM,
    targetAltitudeM,
    avoidAltitudeM,
    altitudeErrorM,
    headingErrorDeg,
    altitudeSettled,
    arrived: distanceM <= input.arriveRadiusM,
    advisory,
  }
}

export interface OrientationSolution {
  readonly yawRate: number
  readonly headingErrorDeg: number
  readonly aligned: boolean
}

/** 原地转机身:把机头转到期望航向,够近就停 */
export function planOrientation(input: {
  readonly headingDeg: number
  readonly desiredHeadingDeg: number
  readonly toleranceDeg: number
}): OrientationSolution {
  const headingErrorDeg = shortestAngle(input.headingDeg, input.desiredHeadingDeg)
  const aligned = Math.abs(headingErrorDeg) <= input.toleranceDeg
  return {
    yawRate: aligned
      ? 0
      : clamp(headingErrorDeg / SEGMENT_TUNING.yawFullScaleDeg, -1, 1),
    headingErrorDeg,
    aligned,
  }
}

export interface HoldSolution {
  readonly command: FlightCommand
  readonly offsetM: number
  readonly altitudeErrorM: number
  /** 是否已经稳定在悬停位上(水平与高度都在容差内) */
  readonly holding: boolean
}

/**
 * 定点保持:在采集期间把机体按在悬停位上。
 *
 * 摇杆量要**换算到机体系** —— 机头转过去之后,世界系的东/西已经不是「右」了。
 * 这正是慢速巡检最容易出错的地方:少这一步,悬停会随航向画圈。
 */
export function planHold(input: {
  readonly position: Vec3
  readonly headingDeg: number
  readonly holdPoint: Vec3
  readonly toleranceM: number
}): HoldSolution {
  const dx = input.holdPoint.x - input.position.x
  const dz = input.holdPoint.z - input.position.z
  const dy = input.holdPoint.y - input.position.y
  const offsetM = Math.hypot(dx, dz)

  const forwardAxis = headingToVector(input.headingDeg)
  const rightAxis = headingToVector(input.headingDeg + 90)
  // 期望位移在机体系上的投影
  const alongForward = dx * forwardAxis.x + dz * forwardAxis.z
  const alongRight = dx * rightAxis.x + dz * rightAxis.z

  const limit = SEGMENT_TUNING.holdCommandLimit
  return {
    command: {
      forward: clamp(alongForward / SEGMENT_TUNING.forwardFullScaleM, -limit, limit),
      right: clamp(alongRight / SEGMENT_TUNING.forwardFullScaleM, -limit, limit),
      up: clamp(
        dy / SEGMENT_TUNING.altitudeFullScaleM,
        -SEGMENT_TUNING.holdAltitudeLimit,
        SEGMENT_TUNING.holdAltitudeLimit,
      ),
      yawRate: 0,
    },
    offsetM,
    altitudeErrorM: dy,
    holding: offsetM <= input.toleranceM && Math.abs(dy) <= input.toleranceM,
  }
}

/** 悬停期间的航向保持:偏向超过死区才修 */
export function planHeadingHold(input: {
  readonly headingDeg: number
  readonly desiredHeadingDeg: number
}): number {
  const error = shortestAngle(input.headingDeg, input.desiredHeadingDeg)
  if (Math.abs(error) <= SEGMENT_TUNING.holdHeadingDeadbandDeg) return 0
  return clamp(error / SEGMENT_TUNING.yawFullScaleDeg, -0.5, 0.5)
}
