/**
 * @simulation/result —— 任务结果聚合层(README §21 · §57 · Capability)。
 *
 *   Task → Completed → Result Builder → TaskResult
 *
 * 负责(§32):TaskResult / ResultSummary / Statistics / ResultExporter。
 * 可以读(§57):Task / AgentTrack / Events / Media / Recorder。
 * 不做:不记录(那是 recorder)、不渲染(那是 UI)、不落盘(IO 归调用方)。
 *
 * 与 Replay(§22)是同一批数据的两种用途:Result 回答「这次干得怎么样」,
 * Replay 回答「这次是怎么干的」。
 */
export * from './report'
export * from './exporter'
