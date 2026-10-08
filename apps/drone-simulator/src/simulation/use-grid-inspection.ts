/**
 * useGridInspection —— 电网巡检页的会话组合。
 *
 * 它做两件事,一件都不多:
 *   ① 把**作业方案**摆出来:用哪条线路、多大镜头、每个拍点停多久,并据此规划航线;
 *   ② 通过行业任务插件,把「创建巡检任务 / 取巡检报告」这两个动作接到通用会话上。
 *
 * 它自己不认识渲染、不认识三维,也不碰 Runtime —— 三维视口与各面板照旧只跟
 * 注入的会话说话。所以巡检页能复用沙盒页那一整套面板,一行都没复制。
 */
import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { Command, TaskId } from '@simulation/contracts'
import { PLATFORM_COMMAND } from '@simulation/contracts'
import type {
  GridLine,
  InspectionRecord,
  InspectionReport,
  InspectionRoute,
} from '@simulation/grid-inspection'
import {
  DEFAULT_DWELL_SECONDS,
  DEFAULT_LENS_ZOOM,
  conductorSpans,
  gridInspectionLine,
  gridInspectionScenario,
  gridLaunchSite,
  planInspectionRoute,
} from '@simulation/grid-inspection'
import type { SceneWire } from '@simulation/three-adapter'
import { conductorSpansToSceneWires } from './scene-mapping'
import type { IndustryTaskPlugin } from './session-types'
import type { SandboxSimulation } from './use-sandbox-simulation'
import { useSandboxSimulation } from './use-sandbox-simulation'

export interface UseGridInspectionOptions {
  /** 线路台账;不传 = 内置的 220 kV 西岭线 */
  readonly line?: GridLine
  /** 镜头倍率(全航线统一)。检测器按它算成像质量,相机也按它变焦 */
  readonly lensZoom?: number
  /** 单拍点悬停采集时长(秒) */
  readonly dwellSeconds?: number
}

export interface GridInspectionSession extends SandboxSimulation {
  /** 线路台账 */
  readonly line: GridLine
  /** 巡检航线(由台账 + 作业方案推导;改镜头倍率会重算) */
  readonly route: ComputedRef<InspectionRoute>
  /** 导线折线(纯视觉) */
  readonly wires: ReadonlyArray<SceneWire>
  /** 当前巡检任务 id */
  readonly inspectionTaskId: Ref<TaskId | null>
  /** 当前巡检报告 —— 巡检进行中拿到的是进度截面 */
  readonly report: ComputedRef<InspectionReport | null>
  readonly records: ComputedRef<ReadonlyArray<InspectionRecord>>
  readonly lensZoom: Ref<number>
  readonly dwellSeconds: Ref<number>

  /** 按当前方案创建巡检任务(不自动启动) */
  createInspectionTask(): TaskId | null
  /** 生成一份**此刻**的报告(导出用,时间是现取的) */
  buildReportNow(): InspectionReport | null
  /** 中止巡检,并把云台从目标上松开 */
  abortInspection(): Command | null
}

export function useGridInspection(options: UseGridInspectionOptions = {}): GridInspectionSession {
  const line = options.line ?? gridInspectionLine()
  const launch = gridLaunchSite()
  const lensZoom = ref(options.lensZoom ?? DEFAULT_LENS_ZOOM)
  const dwellSeconds = ref(options.dwellSeconds ?? DEFAULT_DWELL_SECONDS)

  const route = computed<InspectionRoute>(() =>
    planInspectionRoute(line, {
      lensZoom: lensZoom.value,
      dwellSeconds: dwellSeconds.value,
      // 起飞点必须与场景里的出生点一致,否则转场里程从一开始就是错的
      home: { x: launch.x, y: launch.y, z: launch.z },
    }),
  )
  const wires = conductorSpansToSceneWires(conductorSpans(line))
  // 场景只装配一次:它同时被会话(出生点/障碍物)与任务(种子)使用,
  // 两处各装配一份虽然结果相同,但读取了同一份台账却没有同一个对象,属于没必要的重复。
  const scenario = gridInspectionScenario({ line })

  const inspectionTaskId = ref<TaskId | null>(null)
  /** 报告时间戳。只在「创建 / 任务收尾」时更新 —— 每个 HUD tick 取一次墙钟会让报告文字一直跳 */
  const reportStamp = ref('')
  let plugin: IndustryTaskPlugin | null = null

  const session = useSandboxSimulation({
    scenario,
    label: `${line.label} 巡检`,
    industryTask: (api) => {
      // 插件只做两件**领域**的事:建任务、取报告。其余(认领当前任务、同步镜头倍率、
      // 盖报告时间戳)都留在下面的 createInspectionTask() 里 —— 那些是「页面怎么组织
      // 一次作业」的知识,不属于插件。
      const created: IndustryTaskPlugin = {
        create: () =>
          api.createGridInspectionTask({
            label: `${line.label} 巡检 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
            route: route.value,
            seed: scenario.seed,
            landAtEnd: true,
          }),
        artifact: (id, generatedAt) => api.getInspectionReport(id, generatedAt),
      }
      plugin = created
      return created
    },
  })

  // 记录随时间增长,但记录不是响应式的 —— 用任务快照(10 Hz)当刷新信号
  const revision = ref(0)
  watch(session.task, (task) => {
    revision.value += 1
    if (task && (task.status === 'completed' || task.status === 'failed' || task.status === 'aborted')) {
      reportStamp.value = new Date().toISOString()
    }
  })

  const report = computed<InspectionReport | null>(() => {
    void revision.value
    const id = inspectionTaskId.value
    if (!id || !plugin) return null
    // 插件返回 unknown:这个插件是本文件自己造的,收窄是安全的
    return plugin.artifact(id, reportStamp.value) as InspectionReport | null
  })

  const records = computed<ReadonlyArray<InspectionRecord>>(() => report.value?.records ?? [])

  function createInspectionTask(): TaskId | null {
    if (!plugin) return null
    // 报告时间戳在这一刻盖上:任务已经开始,后续每个 HUD tick 都取墙钟会让报告文字一直跳
    reportStamp.value = new Date().toISOString()
    const id = plugin.create()
    if (id === null) return null
    inspectionTaskId.value = id
    // 会话必须知道「当前任务是谁」—— 巡检任务是插件建的,不认领的话第二次巡检会失焦
    session.focusTask(id)
    // 镜头倍率是航线方案的一部分:检测器按 route.lensZoom 判成像质量,
    // 相机不跟着变焦的话,「看得很清楚」就只是报告里的一个说法
    session.setCameraZoom(route.value.lensZoom)
    return id
  }

  function buildReportNow(): InspectionReport | null {
    const id = inspectionTaskId.value
    if (!id || !plugin) return null
    return plugin.artifact(id, new Date().toISOString()) as InspectionReport | null
  }

  function abortInspection(): Command | null {
    const command = session.abortTask()
    // 中止时把云台松开:否则云台会一直咬着最后一个拍点,和「任务已停」自相矛盾
    session.sendToDrone(PLATFORM_COMMAND.clearAim, { reason: '巡检任务中止' })
    return command
  }

  return {
    ...session,
    line,
    route,
    wires,
    inspectionTaskId,
    report,
    records,
    lensZoom,
    dwellSeconds,
    createInspectionTask,
    buildReportNow,
    abortInspection,
  }
}
