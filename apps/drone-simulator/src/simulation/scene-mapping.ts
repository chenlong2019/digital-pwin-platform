/**
 * Scenario → 场景可视化的映射。
 *
 * 为什么放在应用层:Scenario 是**数据**(尺寸/位置/颜色),SceneObstacle 是**画法**。
 * 谁想画谁负责映射,所以这段转换不属于任何包 —— 换成 Cesium 时只需要换一个映射函数,
 * 渲染适配器和仿真都不动(README §64)。
 */
import type { Scenario } from '@simulation/sandbox-core'
import type { SceneObstacle } from '@simulation/three-adapter'

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
