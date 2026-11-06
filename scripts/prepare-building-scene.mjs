#!/usr/bin/env node
/** Read-only extraction of one building, in the existing platform coordinates. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const repo = fileURLToPath(new URL('..', import.meta.url))
const source = resolve(
  process.argv[2] ?? 'D:/cpp-projects/points-viewer/public/data/campus-road-v2',
)
const output = join(repo, 'apps/drone-simulator/public/scenes/campus-building-a')
const sourceIndexBytes = readFileSync(join(source, 'stream-v2/index.json'))
const index = JSON.parse(sourceIndexBytes)
const origin = [0, 0.035, -105]
const bounds = { min: [-117, -0.1, -46], max: [-91, 37, -14] }
const chunks = [],
  tiles = [],
  sourceTiles = []
let offset = 0
const groundCells = new Set()
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
for (const tile of index.tiles) {
  const min = [tile[4][0], tile[4][1] - origin[1], -(tile[5][2] - origin[2])]
  const max = [tile[5][0], tile[5][1] - origin[1], -(tile[4][2] - origin[2])]
  if (min.some((v, axis) => v > bounds.max[axis]) || max.some((v, axis) => v < bounds.min[axis]))
    continue
  const ref = tile[6].find((lod) => lod[0] === 0)
  const compressed = readFileSync(join(source, `lod0/${tile[0]}.bin.gz`))
  const bytes = gunzipSync(compressed)
  if (bytes.length !== ref[3] * 9) throw new Error(`Tile size mismatch: ${tile[0]}`)
  const selected = []
  for (let b = 0; b < bytes.length; b += 9) {
    const point = [
      tile[2][0] + bytes.readInt16LE(b) * tile[3],
      tile[2][1] + bytes.readInt16LE(b + 2) * tile[3] - origin[1],
      -(tile[2][2] + bytes.readInt16LE(b + 4) * tile[3] - origin[2]),
    ]
    if (point.some((v, axis) => v < bounds.min[axis] || v > bounds.max[axis])) continue
    // Keep the facade at native LOD0; only horizontal ground below 0.4m is thinned.
    if (point[1] < 0.4) {
      const key = `${Math.floor(point[0] / 0.25)},${Math.floor(point[2] / 0.25)}`
      if (groundCells.has(key)) continue
      groundCells.add(key)
    }
    selected.push(bytes.subarray(b, b + 9))
  }
  if (!selected.length) continue
  const raw = Buffer.concat(selected)
  tiles.push([
    tile[0],
    tile[1],
    tile[2],
    tile[3],
    tile[4],
    tile[5],
    [[0, 0, 0, selected.length, ref[4]]],
    offset,
  ])
  chunks.push(raw)
  sourceTiles.push({
    id: tile[0],
    lod: 0,
    sourcePoints: ref[3],
    selectedPoints: selected.length,
    compressedSha256: hash(compressed),
    spacingM: ref[4],
  })
  offset += raw.length
}
const raw = Buffer.concat(chunks)
const metadata = {
  id: 'campus-building-a-lod0-v1',
  name: '西南独立楼 A',
  bounds,
  center: [-104, 18, -30],
  sceneScale: 40,
  source: 'campus-road-v2',
  sourceLod: 0,
  sourceIndexSha256: hash(sourceIndexBytes),
  crop: 'platform-world inclusive AABB; ground below 0.4m keeps first point per 0.25m XZ cell',
  sourceTiles,
  points: raw.length / 9,
}
mkdirSync(output, { recursive: true })
writeFileSync(join(output, 'overview.bin.gz'), gzipSync(raw, { level: 9, mtime: 0 }))
writeFileSync(
  join(output, 'index.json'),
  JSON.stringify({
    schemaVersion: 1,
    origin,
    revision: metadata.id,
    totalPoints: raw.length / 9,
    tiles,
    overview: {
      file: 'overview.bin.gz',
      level: 0,
      points: raw.length / 9,
      bytes: raw.length,
      sha256: hash(raw),
    },
  }),
)
writeFileSync(join(output, 'provenance.json'), JSON.stringify(metadata, null, 2) + '\n')
console.log(JSON.stringify({ ...metadata, sourceTiles: sourceTiles.length }, null, 2))
