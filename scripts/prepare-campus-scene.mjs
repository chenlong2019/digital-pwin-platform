#!/usr/bin/env node
/** Build a portable campus overview from points-viewer's independent XYZRGB tiles. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const repo = fileURLToPath(new URL('..', import.meta.url))
const source = resolve(
  process.argv[2] ?? 'D:/cpp-projects/points-viewer/public/data/campus-road-v2',
)
const output = join(repo, 'apps/drone-simulator/public/scenes/campus-road')
const layouts = join(repo, 'apps/drone-simulator/src/simulation/scenes')
const index = JSON.parse(readFileSync(join(source, 'stream-v2/index.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'))
const origin = [0, 0.035, -105] // Open road at the south edge; X=east, Y=up, Z=north.
const level = 3
const cellSize = 4
const cells = new Map()
const chunks = []
let byteOffset = 0
let pointCount = 0

for (const tile of index.tiles) {
  const ref = tile[6].find((lod) => lod[0] === level && lod[3] > 0)
  if (!ref) throw new Error(`Missing overview LOD for tile ${tile[0]}`)
  const bytes = gunzipSync(readFileSync(join(source, `lod${level}/${tile[0]}.bin.gz`)))
  if (bytes.length !== ref[3] * 9) throw new Error(`Invalid XYZRGB size for tile ${tile[0]}`)
  // Offsets in stream-v2 are pack offsets, not independent-file offsets.
  tile[7] = byteOffset
  chunks.push(bytes)
  byteOffset += bytes.length
  pointCount += ref[3]
  for (let i = 0; i < ref[3]; i++) {
    const b = i * 9
    const x = tile[2][0] + bytes.readInt16LE(b) * tile[3] - origin[0]
    const y = tile[2][1] + bytes.readInt16LE(b + 2) * tile[3] - origin[1]
    const z = -(tile[2][2] + bytes.readInt16LE(b + 4) * tile[3] - origin[2])
    if (y < 2.5) continue
    const cx = Math.floor(x / cellSize)
    const cz = Math.floor(z / cellSize)
    const key = `${cx},${cz}`
    const cell = cells.get(key) ?? { cx, cz, count: 0, top: 0 }
    cell.count++
    cell.top = Math.max(cell.top, y)
    cells.set(key, cell)
  }
}

// Conservative surface proxies: ignore isolated samples, round tops up to 5m,
// then merge adjoining cells of equal height to keep radar/physics inexpensive.
const remaining = new Map(
  [...cells]
    .filter(([, cell]) => cell.count >= 3)
    .map(([key, cell]) => [key, { ...cell, height: Math.ceil(cell.top / 5) * 5 }]),
)
const obstacles = []
for (const cell of [...remaining.values()].sort((a, b) => a.cz - b.cz || a.cx - b.cx)) {
  if (!remaining.has(`${cell.cx},${cell.cz}`)) continue
  let width = 1
  let depth = 1
  while (remaining.get(`${cell.cx + width},${cell.cz}`)?.height === cell.height) width++
  while (
    Array.from(
      { length: width },
      (_, dx) => remaining.get(`${cell.cx + dx},${cell.cz + depth}`)?.height === cell.height,
    ).every(Boolean)
  )
    depth++
  for (let dz = 0; dz < depth; dz++)
    for (let dx = 0; dx < width; dx++) {
      remaining.delete(`${cell.cx + dx},${cell.cz + dz}`)
    }
  obstacles.push({
    name: `CAMPUS_${obstacles.length + 1}`,
    label: `园区障碍 ${obstacles.length + 1}`,
    x: (cell.cx + width / 2) * cellSize,
    z: (cell.cz + depth / 2) * cellSize,
    width: width * cellSize,
    depth: depth * cellSize,
    height: cell.height,
    color: 0x54cbb5,
  })
}
if (
  obstacles.some(
    (box) => Math.abs(box.x) < box.width / 2 + 4 && Math.abs(box.z) < box.depth / 2 + 4,
  )
) {
  throw new Error('Launch area intersects a campus collision proxy')
}

const raw = Buffer.concat(chunks)
const compressed = gzipSync(raw, { level: 9, mtime: 0 })
// The declared world includes empty headroom. Frame occupied bounds rather than
// spending half of the viewport on that empty volume.
const sourceMin = [0, 1, 2].map((axis) => Math.min(...index.tiles.map((tile) => tile[4][axis])))
const sourceMax = [0, 1, 2].map((axis) => Math.max(...index.tiles.map((tile) => tile[5][axis])))
const bounds = {
  min: [sourceMin[0] - origin[0], sourceMin[1] - origin[1], -(sourceMax[2] - origin[2])],
  max: [sourceMax[0] - origin[0], sourceMax[1] - origin[1], -(sourceMin[2] - origin[2])],
}
mkdirSync(output, { recursive: true })
mkdirSync(layouts, { recursive: true })
writeFileSync(join(output, 'overview.bin.gz'), compressed)
writeFileSync(
  join(output, 'index.json'),
  JSON.stringify({
    schemaVersion: 1,
    revision: manifest.revision,
    origin,
    world: index.world,
    totalPoints: index.totalPoints,
    tiles: index.tiles,
    overview: {
      file: 'overview.bin.gz',
      level,
      points: pointCount,
      bytes: raw.length,
      sha256: createHash('sha256').update(raw).digest('hex'),
    },
  }),
)
writeFileSync(
  join(layouts, 'campus-layout.json'),
  JSON.stringify({
    revision: manifest.revision,
    origin,
    bounds,
    cellSize,
    obstacles,
  }),
)
console.log(
  JSON.stringify(
    {
      points: pointCount,
      overviewMB: +(compressed.length / 1024 ** 2).toFixed(2),
      tiles: index.tiles.length,
      collisionProxies: obstacles.length,
      origin,
      bounds,
    },
    null,
    2,
  ),
)
