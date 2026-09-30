<script setup lang="ts">
/**
 * FlightControls —— 飞控按钮组。
 *
 * 这里**没有**任何 `drone.takeOff()` 之类的直接调用:每个按钮都只是把一次
 * 用户意图写成一条 Command,交给 Domain API 走 Authority → Runtime → Agent。
 * 所以 AI / MCP / 自动化将来要复刻同样的动作,走的是同一条路(README §69)。
 *
 * 按钮的可用性只是「提示」,不是「校验」:真正拒绝非法动作的是 Authority 与检查单。
 */
import { computed } from 'vue'
import { PLATFORM_COMMAND } from '@simulation/contracts'
import { DRONE_COMMAND, FLIGHT_MODE_LIST } from '@simulation/drone-agent'
import { useSandbox } from '../simulation/injection'

const { telemetry, sendToDrone, setArmFolded, forceBattery, cameraMode, setCameraMode, resetCamera, clearTrail } =
  useSandbox()

const phase = computed(() => telemetry.value?.phase ?? 'powerOff')
const airborne = computed(() => telemetry.value?.airborne ?? false)
const motorsOn = computed(() => telemetry.value?.motorsOn ?? false)
const armFolded = computed(() => (telemetry.value?.armFold ?? 1) > 0.5)

const canPowerOn = computed(() => phase.value === 'powerOff')
const canTakeOff = computed(() => phase.value === 'standby' || phase.value === 'motorsOn')
const canLand = computed(() => airborne.value)
/**
 * 紧急停桨只在**落地后**可用 —— 空中停桨会直接坠机,真机与仿真都禁止,
 * 空中调用会被内核拒绝并写一条警告。所以这里的可用性条件不是「电机开着」,
 * 而是「电机开着且在地面」。
 */
const canEmergencyStop = computed(() => motorsOn.value && !airborne.value)

const mode = computed(() => telemetry.value?.mode ?? 'normal')
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <span class="panel__title">飞控指令</span>
      <span class="hint">每个按钮 = 一条 Command</span>
    </header>

    <div class="panel__body">
      <!-- 电源与机械 -->
      <div class="group">
        <span class="field-label">电源 / 机械</span>
        <div class="grid">
          <button :disabled="!canPowerOn" class="primary" @click="sendToDrone(PLATFORM_COMMAND.powerOn)">
            开机自检
          </button>
          <button :disabled="phase === 'powerOff'" @click="sendToDrone(PLATFORM_COMMAND.powerOff)">关机</button>
          <button :class="{ active: !armFolded }" :disabled="airborne" @click="setArmFolded(!armFolded)">
            {{ armFolded ? '展开机臂' : '收纳机臂' }}
          </button>
          <button
            :disabled="!canEmergencyStop"
            :title="airborne ? '空中停桨会导致坠落,内核会拒绝;请先降落' : '落地后停桨保护'"
            class="danger"
            @click="sendToDrone(DRONE_COMMAND.emergencyStop)"
          >
            紧急停桨
          </button>
        </div>
        <p class="hint">紧急停桨仅落地后可用:空中停桨会坠机,空中调用会被内核拒绝并写警告。</p>
      </div>

      <!-- 飞行 -->
      <div class="group">
        <span class="field-label">飞行</span>
        <div class="grid">
          <button :disabled="!canTakeOff" class="primary" @click="sendToDrone(PLATFORM_COMMAND.takeOff)">
            一键起飞
          </button>
          <button :disabled="!airborne" @click="sendToDrone(PLATFORM_COMMAND.hover)">悬停 · 摇杆归中</button>
          <button :disabled="!airborne" @click="sendToDrone(PLATFORM_COMMAND.returnToHome, { reason: '操作员指令' })">
            智能返航
          </button>
          <button :disabled="!canLand" @click="sendToDrone(PLATFORM_COMMAND.land)">自动降落</button>
          <button :disabled="!airborne" class="ghost" @click="sendToDrone(PLATFORM_COMMAND.cancelReturnToHome)">
            取消返航
          </button>
          <button @click="sendToDrone(PLATFORM_COMMAND.reset)">重置机体</button>
        </div>
      </div>

      <!-- 挡位 -->
      <div class="group">
        <span class="field-label">飞行挡位</span>
        <div class="grid grid--3">
          <button
            v-for="item in FLIGHT_MODE_LIST"
            :key="item.key"
            :class="{ active: mode === item.key }"
            @click="sendToDrone(DRONE_COMMAND.setMode, { mode: item.key })"
          >
            {{ item.label }}
          </button>
        </div>
      </div>

      <!-- 演示用:直接压电量,复现低电量返航 / 迫降的失效保护 -->
      <div class="group">
        <span class="field-label">失效保护演示(直接写电量)</span>
        <div class="grid grid--3">
          <button @click="forceBattery(100)">100 %</button>
          <button @click="forceBattery(25)">25 %</button>
          <button @click="forceBattery(10)">10 %</button>
        </div>
      </div>

      <!-- 视角 -->
      <div class="group">
        <span class="field-label">视角</span>
        <div class="grid grid--3">
          <button :class="{ active: cameraMode === 'orbit' }" @click="setCameraMode('orbit')">观察者</button>
          <button :class="{ active: cameraMode === 'follow' }" @click="setCameraMode('follow')">跟随</button>
          <button :class="{ active: cameraMode === 'fpv' }" @click="setCameraMode('fpv')">机载</button>
        </div>
        <div class="grid">
          <button class="ghost" @click="resetCamera()">复位相机</button>
          <button class="ghost" @click="clearTrail()">清除航迹</button>
        </div>
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

.grid--3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.grid button {
  width: 100%;
}
</style>
