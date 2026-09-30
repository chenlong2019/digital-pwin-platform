import { describe, expect, it } from 'vitest'
import { compassLabel, formatClock, formatSimulationClock, formatSigned } from '../utils/format'

describe('format', () => {
  it('时间戳按 mm:ss 补齐', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(75)).toBe('01:15')
    expect(formatClock(3599)).toBe('59:59')
    expect(formatClock(Number.NaN)).toBe('--:--')
  })

  it('仿真时钟保留十分之一秒', () => {
    expect(formatSimulationClock(12.34)).toBe('00:12.3')
  })

  it('带符号数值用于偏移量显示', () => {
    expect(formatSigned(1.234)).toBe('+1.23')
    expect(formatSigned(-1.234)).toBe('-1.23')
    expect(formatSigned(0)).toBe('0.00')
  })

  it('罗盘方位角映射到八方位', () => {
    // 0 = 北、90 = 东(与平台约定一致)
    expect(compassLabel(0)).toBe('北')
    expect(compassLabel(90)).toBe('东')
    expect(compassLabel(180)).toBe('南')
    expect(compassLabel(270)).toBe('西')
    expect(compassLabel(359)).toBe('北')
  })
})
