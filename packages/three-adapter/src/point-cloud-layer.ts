import * as THREE from 'three'
import {
  allocatePointCloudLods,
  parsePointCloudIndex,
  pickPointCloudLod,
  pointCloudWorldPoint,
} from './point-cloud-data'
import type {
  DecodedPointCloud,
  PointCloudIndex,
  PointCloudLod,
  VisiblePointCloudTile,
} from './point-cloud-data'
import { PointCloudLoader } from './point-cloud-loader'

export interface PointCloudSceneOptions {
  readonly indexUrl: string
  readonly detailBaseUrl?: string
  readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] }
  readonly pointBudget?: number
  readonly cachePointBudget?: number
}

export interface PointCloudSnapshot {
  readonly state: 'loading' | 'ready' | 'degraded' | 'error'
  readonly overviewPoints: number
  readonly renderedPoints: number
  readonly residentPoints: number
  readonly totalPoints: number
  readonly loadingTiles: number
  readonly detailTiles: number
  readonly error: string
}

interface DetailTile {
  cloud: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>
  lod: PointCloudLod
  lastUsed: number
}

const vertexShader = `
  attribute vec3 color;
  attribute float spacing;
  attribute float tileIndex;
  uniform sampler2D coverage;
  uniform float tileCount;
  uniform float focalPixels;
  uniform float overview;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(spacing * 0.95 * focalPixels / max(0.05, -mv.z), 1.25, 48.0);
    if (overview > 0.5 && texture2D(coverage, vec2((tileIndex + 0.5) / tileCount, 0.5)).r < 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
    }
  }
`
const fragmentShader = `
  varying vec3 vColor;
  void main() {
    vec2 xy = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(xy, xy);
    if (r2 > 1.0) discard;
    vec3 normal = vec3(xy, sqrt(max(0.0, 1.0 - r2)));
    float light = 0.72 + 0.28 * max(0.0, dot(normal, normalize(vec3(-0.4, 0.6, 0.7))));
    gl_FragColor = vec4(pow(vColor, vec3(2.2)) * light, 1.0);
    #include <colorspace_fragment>
  }
`

/** A portable overview stays resident; view-dependent detail replaces its tiles. */
export class PointCloudLayer {
  private readonly group = new THREE.Group()
  private readonly loader = new PointCloudLoader()
  private readonly lifetime = new AbortController()
  private index: PointCloudIndex | null = null
  private material: THREE.ShaderMaterial | null = null
  private coverage: THREE.DataTexture | null = null
  private coverageBytes = new Uint8Array()
  private readonly boxes = new Map<number, THREE.Box3>()
  private readonly details = new Map<number, DetailTile>()
  private readonly pending = new Map<number, { lod: number; controller: AbortController }>()
  private readonly failures = new Map<string, number>()
  private desired = new Map<number, PointCloudLod>()
  private visible: VisiblePointCloudTile[] = []
  private lastSchedule = -Infinity
  private disposed = false
  private overviewError = ''
  private detailError = ''
  private overviewReady = false
  private renderedPoints = 0

  constructor(
    private readonly scene: THREE.Scene,
    private readonly options: PointCloudSceneOptions,
  ) {
    this.group.name = 'campus-point-cloud'
    scene.add(this.group)
    void this.initialize()
  }

  private async initialize(): Promise<void> {
    try {
      const indexUrl = new URL(this.options.indexUrl, window.location.href)
      const response = await fetch(indexUrl, { signal: this.lifetime.signal })
      if (!response.ok) throw new Error(`园区索引请求失败 (${response.status})`)
      const index = parsePointCloudIndex(await response.json())
      if (this.disposed) return
      this.index = index
      this.coverageBytes = new Uint8Array(index.tiles.length * 4).fill(255)
      this.coverage = new THREE.DataTexture(
        this.coverageBytes,
        index.tiles.length,
        1,
        THREE.RGBAFormat,
      )
      this.coverage.needsUpdate = true
      this.material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        toneMapped: false,
        uniforms: {
          coverage: { value: this.coverage },
          tileCount: { value: index.tiles.length },
          focalPixels: { value: 800 },
          overview: { value: 1 },
        },
      })
      for (const tile of index.tiles) {
        const a = pointCloudWorldPoint(...tile.min, index.origin)
        const b = pointCloudWorldPoint(...tile.max, index.origin)
        this.boxes.set(
          tile.id,
          new THREE.Box3().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]),
        )
      }
      const decoded = await this.loader.load(
        { kind: 'overview', index, url: new URL(index.overview.file, indexUrl).href },
        this.lifetime.signal,
      )
      if (this.disposed) return
      this.group.add(this.createCloud(decoded, true))
      this.overviewReady = true
      this.renderedPoints = decoded.points
    } catch (error) {
      if (!this.disposed)
        this.overviewError = error instanceof Error ? error.message : String(error)
    }
  }

  private createCloud(
    data: DecodedPointCloud,
    overview: boolean,
  ): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3, true))
    geometry.setAttribute('tileIndex', new THREE.BufferAttribute(data.tileIndices, 1))
    geometry.setAttribute('spacing', new THREE.BufferAttribute(data.spacings, 1))
    geometry.computeBoundingSphere()
    const cloud = new THREE.Points(geometry, this.material!)
    cloud.name = overview ? 'campus-overview' : 'campus-detail'
    cloud.onBeforeRender = (renderer, _scene, camera) => {
      const perspective = camera as THREE.PerspectiveCamera
      const height = renderer.getDrawingBufferSize(new THREE.Vector2()).y
      const uniforms = this.material!.uniforms
      uniforms['focalPixels']!.value =
        (height * perspective.zoom) / (2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2)))
      uniforms['overview']!.value = overview ? 1 : 0
      // All clouds share one shader, but overview/detail uniforms differ per draw.
      this.material!.uniformsNeedUpdate = true
    }
    return cloud
  }

  update(cameras: ReadonlyArray<THREE.PerspectiveCamera>, viewportHeight: number): void {
    const index = this.index
    if (!index || !this.overviewReady || this.disposed) return
    const now = performance.now()
    if (now - this.lastSchedule < 250) return
    this.lastSchedule = now
    const views = cameras.map((camera) => {
      camera.updateMatrixWorld(true)
      const matrix = new THREE.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      )
      return {
        camera,
        frustum: new THREE.Frustum().setFromProjectionMatrix(matrix),
        focal:
          (viewportHeight * camera.zoom) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))),
      }
    })
    this.visible = []
    for (const tile of index.tiles) {
      let distance = Infinity
      let want = index.overview.level
      for (const view of views) {
        const box = this.boxes.get(tile.id)!
        if (!view.frustum.intersectsBox(box)) continue
        const d = box.distanceToPoint(view.camera.position)
        distance = Math.min(distance, d)
        want = Math.min(want, pickPointCloudLod(tile, d, view.focal))
      }
      if (Number.isFinite(distance)) this.visible.push({ tile, distance, want })
    }
    const baseline = this.visible.reduce((sum, { tile }) => sum + tile.lods[0]!.points, 0)
    const budget = Math.max(index.overview.points, this.options.pointBudget ?? 2_500_000)
    this.desired = allocatePointCloudLods(this.visible, budget - index.overview.points + baseline)
    for (const [id, request] of this.pending) {
      if (this.desired.get(id)?.level !== request.lod) request.controller.abort()
    }
    this.reconcile(now)
    this.pump()
  }

  private reconcile(now: number): void {
    if (!this.index || !this.coverage) return
    this.coverageBytes.fill(255)
    this.renderedPoints = this.index.overview.points
    for (const [id, detail] of this.details) {
      const wanted = this.desired.get(id)
      detail.cloud.visible =
        !!wanted && detail.lod.level >= wanted.level && wanted.level < this.index.overview.level
      if (!detail.cloud.visible) continue
      detail.lastUsed = now
      const tile = this.index.tiles.find((entry) => entry.id === id)!
      this.coverageBytes[tile.ordinal * 4] = 0
      this.renderedPoints += detail.lod.points - tile.lods[0]!.points
    }
    this.coverage.needsUpdate = true
    const cacheBudget = Math.max(
      this.options.pointBudget ?? 2_500_000,
      this.options.cachePointBudget ?? 5_000_000,
    )
    let resident = this.residentPoints
    for (const [id, detail] of [...this.details].sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
      if (resident <= cacheBudget) break
      if (detail.cloud.visible) continue
      this.group.remove(detail.cloud)
      detail.cloud.geometry.dispose()
      this.details.delete(id)
      resident -= detail.lod.points
    }
  }

  private pump(): void {
    if (!this.index || !this.options.detailBaseUrl || this.disposed) return
    for (const { tile } of [...this.visible].sort((a, b) => a.distance - b.distance)) {
      if (this.pending.size >= 4) break
      const lod = this.desired.get(tile.id)
      if (
        !lod ||
        lod.level >= this.index.overview.level ||
        this.pending.has(tile.id) ||
        this.details.get(tile.id)?.lod.level === lod.level ||
        (this.failures.get(`${tile.id}/${lod.level}`) ?? 0) > performance.now()
      )
        continue
      const controller = new AbortController()
      this.pending.set(tile.id, { lod: lod.level, controller })
      const url = `${this.options.detailBaseUrl.replace(/\/$/, '')}/lod${lod.level}/${tile.id}.bin.gz`
      void this.loader
        .load({ kind: 'detail', url, tile, lod, origin: this.index.origin }, controller.signal)
        .then((data) => {
          if (
            this.disposed ||
            controller.signal.aborted ||
            this.desired.get(tile.id)?.level !== lod.level
          )
            return
          const previous = this.details.get(tile.id)
          if (previous) {
            this.group.remove(previous.cloud)
            previous.cloud.geometry.dispose()
          }
          const cloud = this.createCloud(data, false)
          this.group.add(cloud)
          this.details.set(tile.id, { cloud, lod, lastUsed: performance.now() })
          this.failures.delete(`${tile.id}/${lod.level}`)
          this.reconcile(performance.now())
        })
        .catch((error: unknown) => {
          if (this.disposed || controller.signal.aborted) return
          this.detailError = error instanceof Error ? error.message : String(error)
          this.failures.set(`${tile.id}/${lod.level}`, performance.now() + 30_000)
        })
        .finally(() => {
          this.pending.delete(tile.id)
          if (!this.disposed) this.pump()
        })
    }
  }

  private get residentPoints(): number {
    return (
      (this.overviewReady ? (this.index?.overview.points ?? 0) : 0) +
      [...this.details.values()].reduce((sum, detail) => sum + detail.lod.points, 0)
    )
  }

  snapshot(): PointCloudSnapshot {
    const degraded = this.visible.some(
      ({ tile }) =>
        (this.failures.get(`${tile.id}/${this.desired.get(tile.id)?.level}`) ?? 0) >
        performance.now(),
    )
    return {
      state: this.overviewError
        ? 'error'
        : !this.overviewReady
          ? 'loading'
          : degraded
            ? 'degraded'
            : 'ready',
      overviewPoints: this.overviewReady ? (this.index?.overview.points ?? 0) : 0,
      renderedPoints: this.renderedPoints,
      residentPoints: this.residentPoints,
      totalPoints: this.index?.totalPoints ?? 0,
      loadingTiles: this.pending.size,
      detailTiles: [...this.details.values()].filter((detail) => detail.cloud.visible).length,
      error: this.overviewError || (degraded ? this.detailError : ''),
    }
  }

  retryDetails(): void {
    this.failures.clear()
    this.detailError = ''
    this.lastSchedule = -Infinity
  }

  dispose(): void {
    this.disposed = true
    this.lifetime.abort()
    for (const request of this.pending.values()) request.controller.abort()
    this.pending.clear()
    this.loader.dispose()
    this.group.traverse((object) => {
      if (object instanceof THREE.Points) object.geometry.dispose()
    })
    this.material?.dispose()
    this.coverage?.dispose()
    this.scene.remove(this.group)
    this.group.clear()
    this.details.clear()
    this.boxes.clear()
  }
}
