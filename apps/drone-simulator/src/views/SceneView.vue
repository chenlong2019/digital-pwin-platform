<script setup lang="ts">
/**
 * SceneView —— 空白三维场景页。
 *
 * 存在的意义:给纯 three 开发留一块干净画布。
 * 沙盒页(SandboxView)的三维视口被 SandboxScene + ThreeRenderAdapter 包了好几层,
 * 想试一个几何体 / 材质 / 着色器,得先绕开整条仿真数据流 —— 不划算。
 * 这里只有 WebGLRenderer + PerspectiveCamera + 空 Scene:
 * 不 import 任何 @simulation/* 包,也不产生任何仿真数据流,是个纯粹的起手页。
 *
 * 两点刻意与内核(sandbox-scene.ts)保持一致:
 *   ① 用 ResizeObserver 跟随容器,而不是监听 window —— 容器尺寸由 CSS 决定,渲染器只管跟随;
 *      window 一变就重算会在地图 / 侧栏折叠时留下尺寸滞后。
 *   ② 渲染配置沿用 WebGLRenderer + antialias + pixelRatio 上限 2,
 *      背景取全局 CSS 的 --bg 同族色,三维视口和网页看起来是同一块屏。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/** 场景底色 —— 与 styles/main.css 的 --panel-soft(#0a141a)同族,避免三维视口和面板割裂 */
const BACKGROUND = 0x0a141b

const container = ref<HTMLDivElement | null>(null)
/** 渲染统计 —— 空白场景没有物体可看,这几个读数就是「渲染器确实在跑」的证据 */
const fps = ref(0)
const drawCalls = ref(0)
const viewport = ref({ width: 0, height: 0 })
const revision = THREE.REVISION

/**
 * 参考物开关。默认全关 —— 页面交付时场景真的是空的;
 * 需要目视校准相机 / 尺度时再打开,免得为了看一眼坐标轴去改代码。
 */
const showGrid = ref(false)
const showAxes = ref(false)

// three 对象内部结构庞大,不需要深响应式跟踪(shallowRef 避免 vue 白跑一遍遍历)
const grid = shallowRef<THREE.GridHelper | null>(null)
const axes = shallowRef<THREE.AxesHelper | null>(null)

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let resizeObserver: ResizeObserver | null = null

const clock = new THREE.Clock()
let frames = 0
let fpsElapsed = 0

function resize(): void {
  const el = container.value
  if (!el || !renderer || !camera) return
  const width = Math.max(el.clientWidth, 1)
  const height = Math.max(el.clientHeight, 1)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  renderer.setSize(width, height)
  viewport.value = { width, height }
}

function loop(): void {
  const delta = clock.getDelta()
  // 阻尼需要每帧推进,否则拖拽松手后视角会「卡」在半路
  controls?.update()
  if (renderer && scene && camera) {
    renderer.render(scene, camera)
    drawCalls.value = renderer.info.render.calls
  }

  // 每 0.5 秒结算一次 FPS:60Hz 下逐帧更新会让数字跳得看不清
  frames += 1
  fpsElapsed += delta
  if (fpsElapsed >= 0.5) {
    fps.value = Math.round(frames / fpsElapsed)
    frames = 0
    fpsElapsed = 0
  }
}

function init(): void {
  const el = container.value
  if (!el) return

  const width = Math.max(el.clientWidth, 1)
  const height = Math.max(el.clientHeight, 1)

  scene = new THREE.Scene()
  scene.background = new THREE.Color(BACKGROUND)

  camera = new THREE.PerspectiveCamera(58, width / height, 0.1, 1000)
  camera.position.set(6, 4.5, 8)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(width, height)
  el.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.target.set(0, 0, 0)
  controls.update()

  // 参考物:构造好就挂上,可见性交给开关 —— 避免每次切换都重新建几何体
  const gridHelper = new THREE.GridHelper(20, 20, 0x2b5361, 0x17323d)
  gridHelper.visible = showGrid.value
  scene.add(gridHelper)
  grid.value = gridHelper

  const axesHelper = new THREE.AxesHelper(2)
  axesHelper.visible = showAxes.value
  scene.add(axesHelper)
  axes.value = axesHelper

  // 光照:空场景本身用不上,但一旦往里 add 物体就要 —— 按沙盒的照明习惯先摆好,
  // 免得第一次放模型时是一片死黑,还得回头翻渲染器配置
  const hemisphere = new THREE.HemisphereLight(0x7fd8ff, 0x0a141b, 1.6)
  scene.add(hemisphere)
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.4)
  keyLight.position.set(6, 10, 6)
  scene.add(keyLight)

  resizeObserver = new ResizeObserver(() => resize())
  resizeObserver.observe(el)

  viewport.value = { width, height }
  renderer.setAnimationLoop(loop)
}

function dispose(): void {
  renderer?.setAnimationLoop(null)
  resizeObserver?.disconnect()
  resizeObserver = null
  controls?.dispose()
  controls = null
  // 逐个释放几何体 / 材质,页面卸载时不在 GPU 留垃圾
  scene?.traverse((object) => {
    const mesh = object as THREE.Mesh
    mesh.geometry?.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((item) => item.dispose())
    else material?.dispose()
  })
  scene = null
  camera = null
  renderer?.dispose()
  renderer?.domElement.remove()
  renderer = null
}

watch(showGrid, (value) => {
  if (grid.value) grid.value.visible = value
})

watch(showAxes, (value) => {
  if (axes.value) axes.value.visible = value
})

onMounted(init)

onBeforeUnmount(dispose)
</script>

<template>
  <div class="scene">
    <header class="scene__bar">
      <div class="scene__identity">
        <h1>空白三维场景</h1>
        <span class="tag tag--info">THREE r{{ revision }}</span>
        <span class="tag">{{ viewport.width }} × {{ viewport.height }}</span>
        <span class="tag">{{ fps }} FPS</span>
        <span class="tag">{{ drawCalls }} draw</span>
      </div>

      <div class="scene__actions">
        <span class="hint">左键旋转 · 右键平移 · 滚轮缩放</span>
        <button :class="{ active: showGrid }" @click="showGrid = !showGrid">网格</button>
        <button :class="{ active: showAxes }" @click="showAxes = !showAxes">坐标轴</button>
        <RouterLink class="scene__link" to="/">无人机沙盒</RouterLink>
        <RouterLink class="scene__link" to="/car">汽车沙盒</RouterLink>
      </div>
    </header>

    <main ref="container" class="scene__stage"></main>
  </div>
</template>

<style scoped>
.scene {
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 8px;
  padding: 8px;
}

.scene__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 12px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.scene__identity {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.scene__identity h1 {
  font-size: 15px;
  letter-spacing: 0.02em;
}

.scene__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.scene__link {
  flex: none;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-dim);
  text-decoration: none;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.scene__link:hover,
.scene__link.router-link-active {
  color: var(--accent);
  border-color: var(--accent);
}

/* 视口本体:尺寸完全由这块容器决定,渲染器在 ResizeObserver 里跟随 */
.scene__stage {
  position: relative;
  min-height: 0;
  overflow: hidden;
  background: #0a141b;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.scene__stage :deep(canvas) {
  display: block;
}
</style>
