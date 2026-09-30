/**
 * 可种子化随机数(README §75 确定性要求)。
 *
 * 仿真里任何随机都必须走这里,禁止 Math.random() —— 否则「相同 Seed + 相同
 * Command 序列 ⇒ 等价结果」这条验收无法成立。
 * mulberry32:小、快、周期足够,且不依赖平台实现。
 */
export interface RandomSource {
  /** [0, 1) */
  next(): number
  /** [min, max) */
  range(min: number, max: number): number
  /** [min, max] 整数 */
  int(min: number, max: number): number
}

export function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
  }
}
