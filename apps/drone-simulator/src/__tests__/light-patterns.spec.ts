/**
 * 边界一致性测试:领域层的灯语清单 ↔ 渲染层的灯语表。
 *
 * 两边不互相 import(领域层不得依赖渲染层,README §43/§74),
 * 代价是同一份「灯语词汇表」存在两处。这个测试就是那根安全绳:
 * 谁单方面加了灯语、改了名字、删了键,这里立刻红。
 */
import { describe, expect, it } from 'vitest'
import { DRONE_LIGHT_PATTERNS } from '@simulation/drone-agent'
import { STATUS_PATTERNS } from '@simulation/three-adapter'
import { DEFAULT_OBSTACLES } from '@simulation/three-adapter'
import { defaultScenario } from '@simulation/sandbox-core'

describe('灯语词汇表', () => {
  it('领域层声明的每个灯语,渲染层都有对应画法', () => {
    const rendered = new Set(Object.keys(STATUS_PATTERNS))
    const missing = DRONE_LIGHT_PATTERNS.filter((key) => !rendered.has(key))
    expect(missing, `渲染层缺少灯语:${missing.join('、')}`).toEqual([])
  })

  it('渲染层没有领域层用不到的孤儿灯语(防止两侧各自膨胀)', () => {
    const declared = new Set<string>(DRONE_LIGHT_PATTERNS)
    const orphan = Object.keys(STATUS_PATTERNS).filter((key) => !declared.has(key))
    expect(orphan, `领域层判定不出的灯语:${orphan.join('、')}`).toEqual([])
  })
})

describe('默认场景与场景可视化的一致性', () => {
  it('Scenario 的障碍物与 DroneWorld 的默认障碍物同名同尺寸(baseY 也必须一致)', () => {
    const scenario = defaultScenario().obstacles.map((item) => ({
      name: item.name,
      x: item.x,
      z: item.z,
      width: item.width,
      depth: item.depth,
      height: item.height,
      baseY: item.baseY ?? 0,
    }))
    const scene = DEFAULT_OBSTACLES.map((item) => ({
      name: item.name,
      x: item.x,
      z: item.z,
      width: item.width,
      depth: item.depth,
      height: item.height,
      baseY: item.baseY ?? 0,
    }))
    expect(scenario).toEqual(scene)
  })
})
