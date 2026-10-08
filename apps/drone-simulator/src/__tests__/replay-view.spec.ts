/**
 * 回放视图与看板数据的对账(README §22 · §58 · §77)。
 *
 * §77「回放必须精确还原记录值」已经由 result-replay.spec 钉住了,这里不重复。
 * 这里补的是本轮新加的那层转换:记录数据 → 渲染快照 / 曲线 / 统计,
 * 以及**投影的能力边界** —— 哪些能投影(位姿)、哪些必须不投影(灯光与电量)。
 * 边界比功能更需要护栏:哪天有人「顺手」在回放里编一个电量读数,这里会红。
 */
import { describe, expect, it } from 'vitest'
import type { AgentSnapshot } from '@simulation/contracts'
import type { TrackPoint } from '@simulation/recorder'
import {
  REPLAY_AIRBORNE_ALTITUDE,
  REPLAY_ENVIRONMENT,
  buildReplaySeries,
  createReplayData,
  primaryTrack,
  projectReplayAgent,
  replayToRenderSnapshot,
  sampleReplayData,
  summarizePoints,
} from '@simulation/replay'
import { defaultScenario } from '@simulation/sandbox-core'
import { clearReplay, saveReplay, useReplayStore } from '../simulation/replay-store'

// ————————————————————————————— 夹具 —————————————————————————————

const FIRST_POINT: TrackPoint = { tick: 0, simulationTime: 0, x: 0, y: 0, z: 0, headingDeg: 0 }

const TRACK_POINTS: TrackPoint[] = [
  FIRST_POINT,
  { tick: 20, simulationTime: 1, x: 3, y: 4, z: 0, headingDeg: 0 },
  { tick: 40, simulationTime: 2, x: 3, y: 4, z: 4, headingDeg: 0 },
]

function agent(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: 'drone-01',
    type: 'drone',
    label: 'Mini 4 Pro',
    position: { x: 0, y: 0, z: 0 },
    headingDeg: 0,
    status: 'active',
    payload: null,
    ...overrides,
  }
}

// ————————————————————————————— 投影 —————————————————————————————

describe('回放投影 · 位姿是唯一真值', () => {
  it('位置与航向一对一透传,中间时刻按插值取', () => {
    const data = createReplayData({
      sessionId: 's1',
      tracks: [
        {
          agentId: 'drone-01',
          type: 'drone',
          label: 'Mini 4 Pro',
          points: [
            { tick: 0, simulationTime: 0, x: 0, y: 0, z: 0, headingDeg: 0 },
            { tick: 60, simulationTime: 1, x: 10, y: 20, z: -5, headingDeg: 90 },
          ],
        },
      ],
    })

    const snapshot = replayToRenderSnapshot(sampleReplayData(data, 0.5))
    const projected = snapshot.agents[0]

    expect(projected?.id).toBe('drone-01')
    expect(projected?.type).toBe('drone')
    expect(projected?.position).toEqual({ x: 5, y: 10, z: -2.5 })
    expect(projected?.headingDeg).toBeCloseTo(45, 6)
    expect(projected?.status).toBe('active')
  })

  it('空中才转桨,地面不转;机臂一律展开,灯光一律不猜', () => {
    const grounded = projectReplayAgent(agent())
    const airborne = projectReplayAgent(agent({ position: { x: 0, y: 12, z: 0 } }))

    expect(grounded?.rig?.motorLoad).toBe(0)
    expect(airborne?.rig?.motorLoad ?? 0).toBeGreaterThan(0)
    // 真机在空中必然是展开态 —— 这是必然关系,不是编造
    expect(airborne?.rig?.armFold).toBe(0)
    // 灯光与电量记录器没采 —— 必须是 null,不能编一个读数
    expect(grounded?.lights).toBeNull()
    expect(airborne?.lights).toBeNull()
    // 俯仰/横滚同样没采,保持水平
    expect(airborne?.pose.pitchDeg).toBe(0)
    expect(airborne?.pose.rollDeg).toBe(0)
  })

  it('阈值边界:恰好等于阈值仍算地面', () => {
    const at = projectReplayAgent(agent({ position: { x: 0, y: REPLAY_AIRBORNE_ALTITUDE, z: 0 } }))
    const above = projectReplayAgent(agent({ position: { x: 0, y: REPLAY_AIRBORNE_ALTITUDE + 0.01, z: 0 } }))
    expect(at?.rig?.motorLoad).toBe(0)
    expect(above?.rig?.motorLoad ?? 0).toBeGreaterThan(0)
  })

  it('环境用中性默认值,任务为空、事件照搬', () => {
    const data = createReplayData({
      sessionId: 's1',
      events: [{ eventId: 'e1', type: 'drone.tookOff', level: 'info', simulationTime: 1, tick: 60, sessionId: 's1' }],
    })
    const snapshot = replayToRenderSnapshot(sampleReplayData(data, 5))

    expect(snapshot.sessionId).toBe('s1')
    expect(snapshot.environment).toEqual(REPLAY_ENVIRONMENT)
    expect(snapshot.tasks).toEqual([])
    expect(snapshot.events.map((item) => item.eventId)).toEqual(['e1'])
  })

  it('类型不在契约枚举里时收窄成 npc,而不是把脏数据透给适配器', () => {
    const data = createReplayData({
      sessionId: 's1',
      tracks: [{ agentId: 'x-01', type: 'submarine', label: '未知', points: TRACK_POINTS }],
    })
    const snapshot = replayToRenderSnapshot(sampleReplayData(data, 1))
    expect(snapshot.agents[0]?.type).toBe('npc')
  })
})

// ————————————————————————————— 曲线与统计 —————————————————————————————

describe('回放看板 · 曲线与统计口径', () => {
  it('首个采样点没有前一点,速度记 0 而不是「停在原地」', () => {
    const series = buildReplaySeries(TRACK_POINTS)

    expect(series).toHaveLength(3)
    expect(series[0]?.speed).toBe(0)
    expect(series[0]?.climbRate).toBe(0)
    // 水平位移 3 m / 1 s = 3;爬升 4 m / 1 s = 4(垂直分量不进水平速度)
    expect(series[1]?.speed).toBeCloseTo(3, 6)
    expect(series[1]?.climbRate).toBeCloseTo(4, 6)
    expect(series[2]?.speed).toBeCloseTo(4, 6)
    expect(series[2]?.climbRate).toBeCloseTo(0, 6)
  })

  it('航程含垂直分量,极值与峰值都取得到', () => {
    const stats = summarizePoints(TRACK_POINTS, [], [])

    // 段一 (3,4,0) → 5 m;段二 (0,0,4) → 4 m
    expect(stats.distanceFlown).toBeCloseTo(9, 6)
    expect(stats.maxAltitude).toBe(4)
    expect(stats.minAltitude).toBe(0)
    expect(stats.maxSpeed).toBeCloseTo(4, 6)
    expect(stats.points).toBe(3)
  })

  it('下降率取正数 —— 复盘时看「掉得多快」', () => {
    const descending: TrackPoint[] = [
      { tick: 0, simulationTime: 0, x: 0, y: 10, z: 0, headingDeg: 0 },
      { tick: 120, simulationTime: 2, x: 0, y: 4, z: 0, headingDeg: 0 },
    ]
    // 2 秒掉 6 m
    expect(summarizePoints(descending, [], []).maxDescentRate).toBeCloseTo(3, 6)
  })

  it('时长取轨迹 / 事件 / 指令的最晚时刻 —— 落地后的收尾事件也算数', () => {
    const stats = summarizePoints(TRACK_POINTS, [{ simulationTime: 9 }], [{ simulationTime: 5 }])
    expect(stats.duration).toBe(9)
  })

  it('空记录不抛错,极值全部归零', () => {
    const stats = summarizePoints([], [], [])
    expect(stats).toMatchObject({
      duration: 0,
      points: 0,
      distanceFlown: 0,
      maxAltitude: 0,
      minAltitude: 0,
      maxSpeed: 0,
      maxDescentRate: 0,
    })
  })

  it('主轨迹取点数最多的那条;没有轨迹时为 null', () => {
    const data = createReplayData({
      sessionId: 's1',
      tracks: [
        { agentId: 'a-01', type: 'drone', label: 'A', points: [FIRST_POINT] },
        { agentId: 'b-01', type: 'drone', label: 'B', points: TRACK_POINTS },
      ],
    })
    expect(primaryTrack(data)?.agentId).toBe('b-01')
    expect(primaryTrack(createReplayData({ sessionId: 's1' }))).toBeNull()
  })
})

// ————————————————————————————— 中转站 —————————————————————————————

describe('回放中转站 · 存与清', () => {
  it('保存后立刻可读,清空后回到没有记录的状态', () => {
    clearReplay()
    expect(useReplayStore().hasReplay.value).toBe(false)

    saveReplay({
      data: createReplayData({ sessionId: 's1', tracks: [] }),
      scenario: defaultScenario(),
      task: null,
      taskResult: null,
      savedAt: 1_700_000_000_000,
    })

    expect(useReplayStore().hasReplay.value).toBe(true)
    expect(useReplayStore().latest.value?.data.sessionId).toBe('s1')
    expect(useReplayStore().latest.value?.savedAt).toBe(1_700_000_000_000)

    clearReplay()
    expect(useReplayStore().latest.value).toBeNull()
  })
})
