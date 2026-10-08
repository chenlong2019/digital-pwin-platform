/**
 * Scenario / 资产台账 → 场景可视化的映射。
 *
 * 为什么放在应用层:Scenario 是**数据**(尺寸/位置/颜色),SceneObstacle / SceneWire 是**画法**。
 * 谁想画谁负责映射,所以这段转换不属于任何包 —— 换成 Cesium 时只需要换一个映射函数,
 * 渲染适配器和仿真都不动(README §64)。
 */
import type { ConductorSpan } from '@simulation/grid-inspection'
import type { Scenario } from '@simulation/sandbox-core'
import type { SceneObstacle, SceneWire } from '@simulation/three-adapter'

export function scenarioToSceneObstacles(scenario: Scenario): SceneObstacle[] {
  return scenario.obstacles.map((obstacle) => ({
    name: obstacle.name,
    label: obstacle.label,
    x: obstacle.x,
    z: obstacle.z,
    width: obstacle.width,
    depth: obstacle.depth,
    height: obstacle.height,
    color: obstacle.color,
    // 悬空件(天桥等)必须带上 baseY:上视测距靠它才有东西可量
    baseY: obstacle.baseY ?? 0,
    solid: obstacle.solid ?? true,
  }))
}

export interface ConductorWireOptions {
  /** 每档采样点数(≥3)。9 段看不出折线,又不必为一条导线铺上百个顶点 */
  readonly samples?: number
  readonly color?: number
}

/**
 * 导线段 → 场景折线。
 *
 * 弧垂用**抛物线**近似悬链线:当弧垂/档距 < 0.1 时两者差在厘米级,而抛物线的
 * 垂度就是 `4·t·(1−t)` 一条式子,不必引入双曲函数。本场景弧垂取档距的 3.5%,
 * 完全在这个范围内 —— 哪天要画大跨越(弧垂比很大),这里得换回真悬链线。
 */
export function conductorSpansToSceneWires(
  spans: ReadonlyArray<ConductorSpan>,
  options: ConductorWireOptions = {},
): SceneWire[] {
  const samples = Math.max(3, options.samples ?? 9)
  const color = options.color ?? 0x93aebc

  return spans.map((span) => {
    const points: Array<{ x: number; y: number; z: number }> = []
    for (let index = 0; index < samples; index += 1) {
      const t = index / (samples - 1)
      const sag = span.sagM * 4 * t * (1 - t)
      points.push({
        x: span.from.x + (span.to.x - span.from.x) * t,
        y: span.from.y + (span.to.y - span.from.y) * t - sag,
        z: span.from.z + (span.to.z - span.from.z) * t,
      })
    }
    return { id: span.id, label: span.label, points, color }
  })
}
