/**
 * Simulation Clock —— 仿真时间的唯一来源。
 *
 * 铁律(README §13):核心仿真时间绝不来自 Date.now() / performance.now() /
 * requestAnimationFrame。外部渲染循环把「真实经过了多少秒」交给这里,由时钟
 * 换算成整数个固定步长。这样仿真结果只与 tick 序列有关,与浏览器抖动无关,
 * 确定性才有保障。
 */

export interface SimulationClockOptions {
  /** 固定步长(秒),默认 1/60 */
  fixedDeltaTime?: number
  /** 单帧最多补几步,防止卡顿后追帧爆炸(死亡螺旋) */
  maxStepsPerFrame?: number
  /** 单帧接收的真实时间上限(秒),超出部分直接丢弃 */
  maxFrameTime?: number
  /** 时间倍速,1 = 实时 */
  timeScale?: number
}

export interface ClockStats {
  /** 已执行的固定步数 */
  readonly ticks: number
  /** 累计仿真时间(秒) */
  readonly simulationTime: number
  /** 累计真实时间(秒) */
  readonly realTime: number
  /** 因追不上而丢弃的积压步数 */
  readonly droppedSteps: number
  /** 上次 advance 执行的步数 */
  readonly lastSteps: number
}

export class SimulationClock {
  readonly fixedDeltaTime: number
  private readonly maxStepsPerFrame: number
  private readonly maxFrameTime: number
  private accumulator = 0
  private timeScale: number
  private ticks = 0
  private lastSteps = 0
  private realTime = 0
  private droppedSteps = 0

  constructor(options: SimulationClockOptions = {}) {
    this.fixedDeltaTime = options.fixedDeltaTime ?? 1 / 60
    this.maxStepsPerFrame = options.maxStepsPerFrame ?? 240
    this.maxFrameTime = options.maxFrameTime ?? 0.25
    this.timeScale = options.timeScale ?? 1
  }

  get simulationTime(): number {
    return this.ticks * this.fixedDeltaTime
  }

  get tick(): number {
    return this.ticks
  }

  get scale(): number {
    return this.timeScale
  }

  get stats(): ClockStats {
    return {
      ticks: this.ticks,
      simulationTime: this.simulationTime,
      realTime: this.realTime,
      droppedSteps: this.droppedSteps,
      lastSteps: this.lastSteps,
    }
  }

  setTimeScale(scale: number): void {
    this.timeScale = Math.max(0, scale)
  }

  /**
   * 投入一段真实时间,返回本帧应该执行的固定步数。
   * 只做「入账 + 取整」,不推进任何状态 —— 推进由 Runtime 负责。
   */
  advance(realDeltaSeconds: number): number {
    const clamped = Math.max(0, Math.min(realDeltaSeconds, this.maxFrameTime))
    this.realTime += clamped
    if (this.timeScale <= 0) {
      this.lastSteps = 0
      return 0
    }
    this.accumulator += clamped * this.timeScale
    let steps = 0
    while (this.accumulator >= this.fixedDeltaTime && steps < this.maxStepsPerFrame) {
      this.accumulator -= this.fixedDeltaTime
      steps += 1
    }
    if (steps >= this.maxStepsPerFrame && this.accumulator >= this.fixedDeltaTime) {
      // 实在追不上:丢弃积压,宁可跳时间也不阻塞主线程
      this.droppedSteps += Math.floor(this.accumulator / this.fixedDeltaTime)
      this.accumulator = 0
    }
    this.lastSteps = steps
    return steps
  }

  /** 由 Runtime 在每个固定步开始时调用 */
  commitTick(): void {
    this.ticks += 1
  }

  /** 本帧尚未消费的零头,渲染插值可用 */
  get interpolationAlpha(): number {
    return this.accumulator / this.fixedDeltaTime
  }

  reset(): void {
    this.accumulator = 0
    this.ticks = 0
    this.lastSteps = 0
    this.realTime = 0
    this.droppedSteps = 0
  }
}
