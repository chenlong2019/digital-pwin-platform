/** Campus XYZRGB format and LOD selection, adapted from points-viewer/lib/pc. */
export type PointCloudVector = readonly [number, number, number]

export interface PointCloudLod {
  level: number
  points: number
  spacing: number
}

export interface PointCloudTile {
  id: number
  ordinal: number
  center: PointCloudVector
  scale: number
  min: PointCloudVector
  max: PointCloudVector
  lods: PointCloudLod[]
  overviewOffset: number
}

export interface PointCloudIndex {
  origin: PointCloudVector
  tiles: PointCloudTile[]
  totalPoints: number
  overview: { file: string; level: number; points: number; bytes: number; sha256: string }
}

export interface DecodedPointCloud {
  positions: Float32Array
  colors: Uint8Array
  tileIndices: Uint16Array
  spacings: Float32Array
  points: number
}

interface RawIndex {
  schemaVersion: number
  origin: PointCloudVector
  totalPoints: number
  overview: PointCloudIndex['overview']
  tiles: Array<
    [
      number,
      number,
      PointCloudVector,
      number,
      PointCloudVector,
      PointCloudVector,
      number[][],
      number,
    ]
  >
}

export function parsePointCloudIndex(value: unknown): PointCloudIndex {
  const raw = value as RawIndex
  if (
    raw?.schemaVersion !== 1 ||
    !Array.isArray(raw.tiles) ||
    raw.tiles.length > 65_535 ||
    !Array.isArray(raw.origin) ||
    raw.origin.length !== 3 ||
    !raw.origin.every(Number.isFinite) ||
    !raw.overview ||
    raw.overview.bytes !== raw.overview.points * 9
  ) {
    throw new Error('园区点云索引格式不正确')
  }
  const tiles = raw.tiles.map((tile, ordinal): PointCloudTile => {
    if (!(tile[3] > 0) || !Number.isInteger(tile[7]) || tile[7] < 0)
      throw new Error('点云分块参数不正确')
    const lods = tile[6]
      .filter((lod) => lod[3]! > 0)
      .map((lod) => ({
        level: lod[0]!,
        points: lod[3]!,
        spacing: lod[4]!,
      }))
      .sort((a, b) => b.level - a.level)
    const coarse = lods.find((lod) => lod.level === raw.overview.level)
    if (!coarse || tile[7] + coarse.points * 9 > raw.overview.bytes) throw new Error('概览分块越界')
    return {
      id: tile[0],
      ordinal,
      center: tile[2],
      scale: tile[3],
      min: tile[4],
      max: tile[5],
      lods: lods.filter((lod) => lod.level <= raw.overview.level),
      overviewOffset: tile[7],
    }
  })
  if (tiles.reduce((sum, tile) => sum + tile.lods[0]!.points, 0) !== raw.overview.points) {
    throw new Error('概览点数不匹配')
  }
  return { origin: raw.origin, tiles, overview: raw.overview, totalPoints: raw.totalPoints }
}

export function pointCloudWorldPoint(
  x: number,
  y: number,
  z: number,
  origin: PointCloudVector,
): [number, number, number] {
  return [x - origin[0], y - origin[1], -(z - origin[2])]
}

export function decodePointCloud(
  bytes: Uint8Array,
  segments: ReadonlyArray<{ tile: PointCloudTile; lod: PointCloudLod; byteOffset: number }>,
  origin: PointCloudVector,
): DecodedPointCloud {
  const points = segments.reduce((sum, segment) => sum + segment.lod.points, 0)
  const positions = new Float32Array(points * 3)
  const colors = new Uint8Array(points * 3)
  const tileIndices = new Uint16Array(points)
  const spacings = new Float32Array(points)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let cursor = 0
  for (const { tile, lod, byteOffset } of segments) {
    if (byteOffset < 0 || byteOffset + lod.points * 9 > bytes.length)
      throw new Error('点云分块字节数不足')
    for (let i = 0; i < lod.points; i++, cursor++) {
      const b = byteOffset + i * 9
      positions[cursor * 3] = tile.center[0] + view.getInt16(b, true) * tile.scale - origin[0]
      positions[cursor * 3 + 1] =
        tile.center[1] + view.getInt16(b + 2, true) * tile.scale - origin[1]
      positions[cursor * 3 + 2] = -(
        tile.center[2] +
        view.getInt16(b + 4, true) * tile.scale -
        origin[2]
      )
      colors.set(bytes.subarray(b + 6, b + 9), cursor * 3)
      tileIndices[cursor] = tile.ordinal
      spacings[cursor] = lod.spacing
    }
  }
  return { positions, colors, tileIndices, spacings, points }
}

/** Select the coarsest spacing whose projected footprint is at most 2.5 pixels. */
export function pickPointCloudLod(
  tile: PointCloudTile,
  distance: number,
  focalPixels: number,
): number {
  return (
    tile.lods.find((lod) => (lod.spacing * focalPixels) / Math.max(distance, 0.05) <= 2.5)?.level ??
    tile.lods[tile.lods.length - 1]?.level ??
    0
  )
}

export interface VisiblePointCloudTile {
  tile: PointCloudTile
  distance: number
  want: number
}

/** Reserve coarse coverage before progressively refining nearby tiles. */
export function allocatePointCloudLods(
  visible: ReadonlyArray<VisiblePointCloudTile>,
  budget: number,
): Map<number, PointCloudLod> {
  const sorted = [...visible].sort((a, b) => a.distance - b.distance || a.tile.id - b.tile.id)
  const assignments = new Map<number, PointCloudLod>()
  let remaining = Math.max(0, Math.floor(budget))
  for (const entry of sorted) {
    const coarse = entry.tile.lods[0]
    if (!coarse || coarse.points > remaining) continue
    assignments.set(entry.tile.id, coarse)
    remaining -= coarse.points
  }
  const maxLevel = Math.max(0, ...sorted.map(({ tile }) => tile.lods[0]?.level ?? 0))
  for (let level = maxLevel - 1; level >= 0; level--) {
    for (const entry of sorted) {
      if (level < entry.want) continue
      const current = assignments.get(entry.tile.id)
      const next = entry.tile.lods.find((lod) => lod.level === level)
      if (!current || !next || current.level <= level) continue
      const extra = next.points - current.points
      if (extra > remaining) continue
      assignments.set(entry.tile.id, next)
      remaining -= extra
    }
  }
  return assignments
}
