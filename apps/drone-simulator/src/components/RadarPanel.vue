<script setup lang="ts">
/**
 * RadarPanel —— 测距雷达读数面板。
 *
 * 机体上装的是「前视双镜头 + 上视双孔」的视觉测距系统,量程与真机一致
 * (前视 0.5~18 m、上视 0.5~15 m)。这里显示的是**传感器测量**,不是飞控保护:
 * 仿真内核的 AABB 避障是另一层,两者互不干扰 —— 所以面板上可能看到
 * 「雷达还没报警但机体已经刹停」这种情况,那是正常的。
 *
 * 距离配色与三维里的射线同源(近红 / 中黄 / 远距组色),用的是
 * three-adapter 导出的阈值常量,不在这里另抄一份。
 */
import { computed } from 'vue'
import type { RadarHit } from '@simulation/three-adapter'
import { RADAR_MID_METERS, RADAR_NEAR_METERS } from '@simulation/three-adapter'
import { useSandbox } from '../simulation/injection'
import { formatNumber } from '../utils/format'

const { radar, radarAim, radarBeamsVisible, setRadarAim, setRadarBeamsVisible } = useSandbox()

const AIM_OPTIONS = [
  { key: 'forward' as const, label: '正前/正上' },
  { key: 'sensor' as const, label: '镜头朝向' },
]

const detecting = computed(() => radar.value?.detecting ?? false)
const frontRange = computed(() => radar.value?.range ?? 18)
const upRange = computed(() => radar.value?.upRange ?? 15)

/** 左/右镜头合起来看:取更近的那个当「正前方」判读 */
function nearest(hit: RadarHit | null, other: RadarHit | null): RadarHit | null {
  if (!hit) return other
  if (!other) return hit
  return hit.distance <= other.distance ? hit : other
}

const frontNearest = computed(() => nearest(radar.value?.left ?? null, radar.value?.right ?? null))
const upNearest = computed(() => nearest(radar.value?.upLeft ?? null, radar.value?.upRight ?? null))

function toneOf(hit: RadarHit | null): string {
  if (!hit) return 'tone--clear'
  if (hit.distance < RADAR_NEAR_METERS) return 'tone--near'
  if (hit.distance < RADAR_MID_METERS) return 'tone--mid'
  return 'tone--far'
}

function describe(hit: RadarHit | null, range: number): string {
  if (!hit) return '视场内净空'
  return `${hit.label} · ${formatNumber(hit.distance, 1)} m`
}

/** 传感器是否绑到了模型的玻璃节点上 —— 绑不上就退化成固定锚点,读数会偏 */
const bound = computed(() => detecting.value)
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <span class="panel__title">测距雷达</span>
      <span class="tag" :class="detecting ? 'tag--ok' : 'tag'">
        {{ detecting ? '工作中' : '未上电' }}
      </span>
    </header>

    <div class="panel__body">
      <!-- 瞄准模式 -->
      <div class="group">
        <div class="row row--between">
          <span class="field-label">镜头瞄准</span>
          <span class="hint">沿玻璃面法线 / 转正前上</span>
        </div>
        <div class="grid">
          <button
            v-for="item in AIM_OPTIONS"
            :key="item.key"
            :class="{ active: radarAim === item.key }"
            @click="setRadarAim(item.key)"
          >
            {{ item.label }}
          </button>
        </div>
      </div>

      <!-- 前视 -->
      <div class="group">
        <div class="row row--between">
          <span class="field-label">前视双镜头</span>
          <span class="hint mono">量程 {{ frontRange }} m</span>
        </div>
        <div class="readout" :class="toneOf(frontNearest)">
          <span class="readout__value mono">
            {{ frontNearest ? formatNumber(frontNearest.distance, 1) : '--' }}
          </span>
          <span class="readout__unit">m</span>
          <span class="readout__label">{{ frontNearest?.label ?? '视场内净空' }}</span>
        </div>
        <dl class="info">
          <div>
            <dt>左镜头</dt>
            <dd class="mono" :class="toneOf(radar?.left ?? null)">
              {{ describe(radar?.left ?? null, frontRange) }}
            </dd>
          </div>
          <div>
            <dt>右镜头</dt>
            <dd class="mono" :class="toneOf(radar?.right ?? null)">
              {{ describe(radar?.right ?? null, frontRange) }}
            </dd>
          </div>
        </dl>
      </div>

      <!-- 上视 -->
      <div class="group">
        <div class="row row--between">
          <span class="field-label">上视双孔</span>
          <span class="hint mono">量程 {{ upRange }} m</span>
        </div>
        <div class="readout" :class="toneOf(upNearest)">
          <span class="readout__value mono">
            {{ upNearest ? formatNumber(upNearest.distance, 1) : '--' }}
          </span>
          <span class="readout__unit">m</span>
          <span class="readout__label">{{ upNearest?.label ?? '上方净空' }}</span>
        </div>
        <dl class="info">
          <div>
            <dt>左孔</dt>
            <dd class="mono" :class="toneOf(radar?.upLeft ?? null)">
              {{ describe(radar?.upLeft ?? null, upRange) }}
            </dd>
          </div>
          <div>
            <dt>右孔</dt>
            <dd class="mono" :class="toneOf(radar?.upRight ?? null)">
              {{ describe(radar?.upRight ?? null, upRange) }}
            </dd>
          </div>
        </dl>
      </div>

      <!-- 可视化 -->
      <div class="group">
        <span class="field-label">可视化</span>
        <button :class="{ active: radarBeamsVisible }" @click="setRadarBeamsVisible(!radarBeamsVisible)">
          {{ radarBeamsVisible ? '隐藏测距射线' : '显示测距射线' }}
        </button>
        <p class="hint">
          射线只影响画面,读数照常工作。命中不到玻璃节点时传感器会退化成固定锚点{{ bound ? '' : '(当前未上电)' }}。
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.grid button {
  width: 100%;
  padding: 5px 2px;
}

.readout {
  display: flex;
  align-items: baseline;
  gap: 4px;
  padding: 6px 9px;
  border-radius: 8px;
  background: var(--panel-soft);
  border: 1px solid var(--border-soft);
}

.readout__value {
  font-size: 19px;
  line-height: 1;
  font-weight: 600;
}

.readout__unit {
  font-size: 11px;
  color: var(--text-faint);
}

.readout__label {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tone--near .readout__value,
.tone--near {
  color: var(--danger);
}

.tone--mid .readout__value,
.tone--mid {
  color: var(--warn);
}

.tone--far .readout__value,
.tone--far {
  color: var(--accent);
}

.tone--clear .readout__value,
.tone--clear {
  color: var(--text-faint);
}

.info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
}

.info > div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 0;
  border-bottom: 1px dashed var(--border-soft);
  font-size: 11px;
}

.info dt {
  color: var(--text-faint);
  white-space: nowrap;
}

.info dd {
  margin: 0;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
