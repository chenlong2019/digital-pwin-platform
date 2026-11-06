// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  allocatePointCloudLods,
  decodePointCloud,
  parsePointCloudIndex,
  pickPointCloudLod,
} from '../../../../packages/three-adapter/src/point-cloud-data'
import type { PointCloudTile } from '../../../../packages/three-adapter/src/point-cloud-data'
import { campusScenario, campusWaypoints } from '../simulation/scenes/campus-scene'

const assetRoot = new URL('../../public/scenes/campus-road/', import.meta.url)
const index = parsePointCloudIndex(
  JSON.parse(readFileSync(new URL('index.json', assetRoot), 'utf8')),
)

describe('园区点云数据与坐标', () => {
  it('概览可离线解码，校验值、分块偏移和点数一致', () => {
    const bytes = gunzipSync(readFileSync(new URL('overview.bin.gz', assetRoot)))
    expect(bytes.length).toBe(index.overview.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(index.overview.sha256)
    const cloud = decodePointCloud(
      bytes,
      index.tiles.map((tile) => ({
        tile,
        lod: tile.lods[0]!,
        byteOffset: tile.overviewOffset,
      })),
      index.origin,
    )
    expect(cloud.points).toBe(606306)
    expect(index.tiles).toHaveLength(721)
    expect(cloud.positions.every(Number.isFinite)).toBe(true)
  })

  it('独立分块从字节零解码，米制坐标由北正转换为南正', () => {
    const tile: PointCloudTile = {
      id: 20,
      ordinal: 7,
      center: [10, 3, 20],
      scale: 0.25,
      min: [0, 0, 0],
      max: [30, 30, 30],
      overviewOffset: 900,
      lods: [{ level: 0, points: 1, spacing: 0.15 }],
    }
    const bytes = new Uint8Array(9)
    const view = new DataView(bytes.buffer)
    view.setInt16(0, 4, true)
    view.setInt16(2, -2, true)
    view.setInt16(4, 8, true)
    bytes.set([30, 100, 220], 6)
    const cloud = decodePointCloud(
      bytes,
      [{ tile, lod: tile.lods[0]!, byteOffset: 0 }],
      [1, 0.5, 10],
    )
    expect([...cloud.positions]).toEqual([10, 2, -12])
    expect([...cloud.colors]).toEqual([30, 100, 220])
    expect(cloud.tileIndices[0]).toBe(7)
    expect(() =>
      decodePointCloud(
        bytes.subarray(0, 8),
        [{ tile, lod: tile.lods[0]!, byteOffset: 0 }],
        [0, 0, 0],
      ),
    ).toThrow('字节数不足')
  })

  it('在总预算内保留可见分块覆盖，并优先细化近处', () => {
    const tile = (id: number): PointCloudTile => ({
      id,
      ordinal: id,
      center: [0, 0, 0],
      scale: 1,
      min: [0, 0, 0],
      max: [1, 1, 1],
      overviewOffset: 0,
      lods: [
        { level: 2, points: 10, spacing: 1.2 },
        { level: 1, points: 40, spacing: 0.6 },
        { level: 0, points: 160, spacing: 0.3 },
      ],
    })
    const near = tile(1),
      far = tile(2)
    const allocation = allocatePointCloudLods(
      [
        { tile: far, distance: 100, want: 0 },
        { tile: near, distance: 5, want: 0 },
      ],
      200,
    )
    expect(allocation.size).toBe(2)
    expect(allocation.get(1)?.level).toBe(0)
    expect([...allocation.values()].reduce((sum, lod) => sum + lod.points, 0)).toBeLessThanOrEqual(
      200,
    )
    expect(pickPointCloudLod(near, 1, 800)).toBe(0)
    expect(pickPointCloudLod(near, 1000, 800)).toBe(2)
  })
})

describe('园区飞行场景', () => {
  const scenario = campusScenario()
  it('起飞点和道路示例航线不穿过简化避障范围', () => {
    for (let x = -35; x <= 35; x++) {
      expect(
        scenario.obstacles.some(
          (box) =>
            Math.abs(x - box.x) <= box.width / 2 + 0.8 && Math.abs(box.z) <= box.depth / 2 + 0.8,
        ),
      ).toBe(false)
    }
    expect(campusWaypoints.every((waypoint) => waypoint.z === 0 && waypoint.altitude === 8)).toBe(
      true,
    )
    expect(scenario.obstacles.every((box) => box.name.startsWith('CAMPUS_'))).toBe(true)
  })

  it('点云内每个高于2.5m的有效网格都有对应的保守避障范围', () => {
    const bytes = gunzipSync(readFileSync(new URL('overview.bin.gz', assetRoot)))
    const cloud = decodePointCloud(
      bytes,
      index.tiles.map((tile) => ({ tile, lod: tile.lods[0]!, byteOffset: tile.overviewOffset })),
      index.origin,
    )
    const cells = new Map<string, { x: number; z: number; top: number; count: number }>()
    for (let i = 0; i < cloud.points; i++) {
      const x = cloud.positions[i * 3]!,
        y = cloud.positions[i * 3 + 1]!,
        z = cloud.positions[i * 3 + 2]!
      if (y < 2.5) continue
      const cx = Math.floor(x / 4),
        cz = Math.floor(z / 4),
        key = `${cx},${cz}`
      const cell = cells.get(key) ?? { x: (cx + 0.5) * 4, z: (cz + 0.5) * 4, top: 0, count: 0 }
      cell.top = Math.max(cell.top, y)
      cell.count++
      cells.set(key, cell)
    }
    for (const cell of cells.values()) {
      if (cell.count < 3) continue
      expect(
        scenario.obstacles.some(
          (box) =>
            Math.abs(cell.x - box.x) < box.width / 2 &&
            Math.abs(cell.z - box.z) < box.depth / 2 &&
            box.height + 0.001 >= cell.top,
        ),
      ).toBe(true)
    }
  })
})
