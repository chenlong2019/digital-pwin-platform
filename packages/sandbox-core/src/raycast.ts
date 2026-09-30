/**
 * AABB 射线求交(slab 算法)—— 供 sandbox-core 做障碍物查询。
 *
 * 与三个轴向分别求射线进出区间,取交集。方向分量为 0 时该轴退化为
 * 「入射点是否落在区间内」的判定,单独处理避免 0 * Infinity = NaN。
 */
import type { ObstacleBox, RaycastHit, Vec3 } from '@simulation/contracts'

export function raycastObstacles(
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  obstacles: ReadonlyArray<ObstacleBox>,
): RaycastHit | null {
  const length = Math.hypot(direction.x, direction.y, direction.z)
  if (length < 1e-9 || maxDistance <= 0) return null
  const dx = direction.x / length
  const dy = direction.y / length
  const dz = direction.z / length

  let best: RaycastHit | null = null

  for (const box of obstacles) {
    const t = intersectBox(origin, dx, dy, dz, box, maxDistance)
    if (t === null) continue
    if (best === null || t < best.distance) {
      best = {
        distance: t,
        obstacle: box.name,
        point: { x: origin.x + dx * t, y: origin.y + dy * t, z: origin.z + dz * t },
      }
    }
  }

  return best
}

function intersectBox(
  origin: Vec3,
  dx: number,
  dy: number,
  dz: number,
  box: ObstacleBox,
  maxDistance: number,
): number | null {
  let tMin = 0
  let tMax = maxDistance

  const axes: Array<{ origin: number; dir: number; min: number; max: number }> = [
    { origin: origin.x, dir: dx, min: box.minX, max: box.maxX },
    { origin: origin.y, dir: dy, min: box.minY, max: box.maxY },
    { origin: origin.z, dir: dz, min: box.minZ, max: box.maxZ },
  ]

  for (const axis of axes) {
    if (Math.abs(axis.dir) < 1e-9) {
      // 平行于该轴:起点必须已在该轴的区间内,否则永不相交
      if (axis.origin < axis.min || axis.origin > axis.max) return null
      continue
    }
    const inverse = 1 / axis.dir
    let t1 = (axis.min - axis.origin) * inverse
    let t2 = (axis.max - axis.origin) * inverse
    if (t1 > t2) {
      const swap = t1
      t1 = t2
      t2 = swap
    }
    if (t1 > tMin) tMin = t1
    if (t2 < tMax) tMax = t2
    if (tMin > tMax) return null
  }

  return tMin
}

/** 点是否落在包围盒内(含边界) */
export function pointInsideBox(x: number, y: number, z: number, box: ObstacleBox, padding = 0): boolean {
  return (
    x >= box.minX - padding &&
    x <= box.maxX + padding &&
    y >= box.minY - padding &&
    y <= box.maxY + padding &&
    z >= box.minZ - padding &&
    z <= box.maxZ + padding
  )
}
