<script setup lang="ts">
/**
 * VehicleHud —— 汽车的仪表与车身控制。
 *
 * 与无人机的 HUD 面板同层:全部操作都落成 Command(README §24 / §82),
 * 组件只读遥测、只发指令,不碰任何状态。
 *
 * 键盘驾驶走**平台级 move 载荷**,而不是汽车专属指令 —— 这样才能证明
 * 「同一份输入载荷喂给不同载具」是真的:WASD 在这里是油门与方向,
 * 在无人机那里就是升降与偏航,而输入层与内核都不需要知道谁在用。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { GearPosition, VehicleLightPattern } from '@simulation/vehicle-agent'
import { useVehicle } from '../simulation/injection'

const sim = useVehicle()
const { telemetry } = sim

const GEARS: ReadonlyArray<{ key: GearPosition; label: string }> = [
  { key: 'P', label: 'P 驻车' },
  { key: 'R', label: 'R 倒车' },
  { key: 'N', label: 'N 空挡' },
  { key: 'D', label: 'D 前进' },
]

const LIGHTS: ReadonlyArray<{ key: VehicleLightPattern; label: string }> = [
  { key: 'off', label: '关闭' },
  { key: 'position', label: '示宽' },
  { key: 'low', label: '近光' },
  { key: 'high', label: '远光' },
  { key: 'hazard', label: '双闪' },
]

const DOORS = [
  { key: 'FL', label: '左前' },
  { key: 'FR', label: '右前' },
  { key: 'RL', label: '左后' },
  { key: 'RR', label: '右后' },
] as const

const gear = computed(() => telemetry.value?.gear ?? 'P')
const speedKph = computed(() => Math.round(telemetry.value?.speedKph ?? 0))
const battery = computed(() => Math.round(telemetry.value?.batteryPercent ?? 100))
const steerDeg = computed(() => Math.round(telemetry.value?.steerDeg ?? 0))
const odometer = computed(() => (telemetry.value?.odometerM ?? 0).toFixed(1))
const lightPattern = computed(() => telemetry.value?.lightPattern ?? 'off')
const phaseLabel = computed(() => telemetry.value?.phaseLabel ?? '未上电')
const powered = computed(() => telemetry.value?.powered ?? false)

/** 四门当前开度 0~1,面板据此显示开/关 */
function doorValue(key: (typeof DOORS)[number]['key']): number {
  return telemetry.value?.doors[key] ?? 0
}

const allDoorsOpen = computed(() => DOORS.every((door) => doorValue(door.key) > 0.9))
const anyDoorOpen = computed(() => DOORS.some((door) => doorValue(door.key) > 0.02))
const mirrorsFolded = computed(() => {
  const mirrors = telemetry.value?.mirrors
  return !!mirrors && mirrors.L > 0.9 && mirrors.R > 0.9
})

const driving = ref(false)

function toggleGear(target: GearPosition): void {
  sim.setGear(target)
}

function toggleDoor(key: (typeof DOORS)[number]['key']): void {
  sim.setDoor(key, doorValue(key) > 0.5 ? 0 : 1)
}

function toggleAllDoors(): void {
  sim.setDoor('all', allDoorsOpen.value ? 0 : 1)
}

function toggleMirrors(): void {
  sim.setMirror('all', mirrorsFolded.value ? 0 : 1)
}

function pickLight(pattern: VehicleLightPattern): void {
  sim.setLights(pattern)
}

// ————————————————————————————— 键盘驾驶 —————————————————————————————

const HANDLED = new Set([
  'KeyW',
  'KeyS',
  'KeyA',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
])

const pressed = new Set<string>()
let rafId = 0
let lastSignature = ''

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || element.isContentEditable
}

function onKeyDown(event: KeyboardEvent): void {
  if (isTypingTarget(event.target)) return
  if (!HANDLED.has(event.code)) return
  pressed.add(event.code)
  event.preventDefault()
}

function onKeyUp(event: KeyboardEvent): void {
  pressed.delete(event.code)
}

/** 失焦时把手里的键全松开,否则切回来车会自己一直加速 */
function releaseAll(): void {
  pressed.clear()
}

/**
 * 每帧把「按键集合」压成一份 move 载荷。只在载荷真的变了才下发 ——
 * 否则 60 Hz 会把命令日志刷爆,而仿真状态其实一点没动。
 */
function pump(): void {
  rafId = window.requestAnimationFrame(pump)

  const forward = pressed.has('KeyW') || pressed.has('ArrowUp')
  const back = pressed.has('KeyS') || pressed.has('ArrowDown')
  const left = pressed.has('KeyA') || pressed.has('ArrowLeft')
  const right = pressed.has('KeyD') || pressed.has('ArrowRight')
  const steer = (right ? 1 : 0) - (left ? 1 : 0)
  const speed = telemetry.value?.speedMps ?? 0

  let forwardAxis = 0
  let braking = false
  if (forward) {
    forwardAxis = 1
  } else if (back) {
    // 还在往前跑就是刹车;停稳后再按才是倒车 —— 与真车踏板一致
    if (speed > 0.4) braking = true
    else forwardAxis = -1
  }

  const signature = `${forwardAxis}|${steer}|${braking}`
  if (signature === lastSignature) return
  lastSignature = signature

  if (braking) {
    sim.setDrive(0, 1)
    return
  }
  sim.sendMove({ forward: forwardAxis, right: steer, up: 0, yawRate: 0 })
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', releaseAll)
  rafId = window.requestAnimationFrame(pump)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('blur', releaseAll)
  if (rafId !== 0) window.cancelAnimationFrame(rafId)
  rafId = 0
})
</script>

<template>
  <div class="vhud">
    <section class="vhud__card">
      <h3 class="vhud__title">车辆状态</h3>
      <div class="gauge-row">
        <div class="gauge">
          <span class="gauge__label">挡位</span>
          <span class="gauge__value">{{ gear }}</span>
        </div>
        <div class="gauge">
          <span class="gauge__label">车速</span>
          <span class="gauge__value">{{ speedKph }}<em>km/h</em></span>
        </div>
        <div class="gauge">
          <span class="gauge__label">电量</span>
          <span class="gauge__value">{{ battery }}<em>%</em></span>
        </div>
        <div class="gauge">
          <span class="gauge__label">前轮</span>
          <span class="gauge__value">{{ steerDeg }}<em>°</em></span>
        </div>
        <div class="gauge">
          <span class="gauge__label">里程</span>
          <span class="gauge__value">{{ odometer }}<em>m</em></span>
        </div>
        <div class="gauge">
          <span class="gauge__label">灯光</span>
          <span class="gauge__value gauge__value--text">{{ telemetry?.lightPatternLabel ?? '关闭' }}</span>
        </div>
      </div>
      <div class="vhud__line">
        <span class="vhud__hint">{{ phaseLabel }}</span>
        <span v-if="anyDoorOpen" class="tag tag--warn">车门未关</span>
        <span class="tag" :class="{ 'tag--ok': powered }">{{ powered ? '已上电' : '未上电' }}</span>
      </div>
    </section>

    <section class="vhud__card">
      <h3 class="vhud__title">驾驶</h3>
      <div class="chip-row">
        <button
          v-for="item in GEARS"
          :key="item.key"
          class="chip"
          :class="{ 'chip--active': gear === item.key }"
          :data-testid="`gear-${item.key}`"
          @click="toggleGear(item.key)"
        >
          {{ item.label }}
        </button>
      </div>
      <div class="vhud__line vhud__line--keys">
        <kbd>W</kbd><span>前进</span>
        <kbd>S</kbd><span>刹车 / 倒车</span>
        <kbd>A</kbd><kbd>D</kbd><span>转向</span>
      </div>
      <button class="ghost ghost--block" @click="sim.setDrive(0, 1)">制动</button>
    </section>

    <section class="vhud__card">
      <h3 class="vhud__title">
        车门
        <button class="mini" @click="toggleAllDoors()">{{ allDoorsOpen ? '全部关闭' : '全部打开' }}</button>
      </h3>
      <div class="chip-row">
        <button
          v-for="door in DOORS"
          :key="door.key"
          class="chip"
          :class="{ 'chip--active': doorValue(door.key) > 0.5 }"
          :data-testid="`door-${door.key}`"
          @click="toggleDoor(door.key)"
        >
          {{ door.label }}
        </button>
      </div>
      <button
        class="ghost ghost--block"
        :class="{ 'ghost--on': mirrorsFolded }"
        data-testid="mirror-toggle"
        @click="toggleMirrors()"
      >
        后视镜{{ mirrorsFolded ? '展开' : '折叠' }}
      </button>
    </section>

    <section class="vhud__card">
      <h3 class="vhud__title">灯光</h3>
      <div class="chip-row">
        <button
          v-for="item in LIGHTS"
          :key="item.key"
          class="chip"
          :class="{ 'chip--active': lightPattern === item.key }"
          :data-testid="`light-${item.key}`"
          @click="pickLight(item.key)"
        >
          {{ item.label }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.vhud {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
}

.vhud__card {
  padding: 9px 11px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.vhud__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--text-dim);
}

.gauge-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 7px 10px;
}

.gauge {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.gauge__label {
  font-size: 11px;
  color: var(--text-dim);
}

.gauge__value {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 17px;
  line-height: 1.15;
}

.gauge__value--text {
  font-family: inherit;
  font-size: 14px;
}

.gauge__value em {
  margin-left: 3px;
  font-family: inherit;
  font-size: 10.5px;
  font-style: normal;
  color: var(--text-dim);
}

.vhud__line {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 9px;
  flex-wrap: wrap;
}

.vhud__hint {
  font-size: 11.5px;
  color: var(--text-dim);
}

.vhud__line--keys {
  font-size: 11.5px;
  color: var(--text-dim);
}

.vhud__line--keys kbd {
  padding: 1px 5px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-dim);
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}

.chip:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.chip--active {
  color: var(--accent);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.mini {
  padding: 2px 8px;
  font-size: 11px;
  color: var(--text-dim);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 5px;
  cursor: pointer;
}

.ghost--block {
  width: 100%;
  margin-top: 8px;
  padding: 5px 10px;
  font-size: 12px;
  color: var(--text-dim);
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}

.ghost--on {
  color: var(--accent);
  border-color: var(--accent);
}
</style>
