/**
 * @simulation/replay —— 历史回放层(README §22 · §58 · Capability)。
 *
 *   Recorder Data → ReplaySession → ReplayController → ReplaySnapshot → Renderer
 *
 * 负责(§32):ReplaySession / ReplayTimeline / ReplayController / ReplaySnapshot。
 * 不做:不记录原始数据(那是 recorder,§58 最后一句)、不重新跑仿真。
 *
 * 回放消费的是一份**抓下来的数据快照**,所以原始会话已经关掉也能放 ——
 * 这正是 §22「第一阶段:历史数据驱动回放」的意思。
 */
export * from './data'
export * from './controller'
