/**
 * 缺陷判定 —— 巡检的「传感器 + 算法」,也是整个功能唯一需要**说明白它是假的**的地方。
 *
 * 真实系统里这一环是视觉大模型或人工看图;这里用确定性规则 + 成像质量模型代替。
 * 这么做的价值不在于「像真模型」,而在于它把两件事变成可验证的量:
 *
 *   ① **成像质量**是一个有物理含义的分数:由「特征尺寸 / 距离 / 变焦」算出目标特征
 *      落在几个像素上(见 `CAMERA_MODEL`),再乘上偏心、俯仰、机身对准、天气、风的惩罚。
 *      所以「这基塔为什么没看出来」有答案,而不是「随机漏了」。
 *   ② **漏检与误检**是按塔号 + 部位 + 会话种子派生出来的:**同一次会话跑两遍结果完全
 *      一样**(README §75),换个种子才变。于是报告里的召回率/精度是真指标,不是装饰。
 *
 * 判定只读资产、不写资产:真实缺陷在 `grid-assets.ts` 的地面真值里,这里产出的
 * 是**巡检结论**。两者在报告里并列出现,是为了对账,不是为了糊弄 —— 界面上
 * 真值一律标注「仅用于对账」。
 */
import type { WeatherKind } from '@simulation/contracts'
import { createSeededRandom } from '@simulation/simulation-core'
import type { DefectKind, DefectSeverity, PartDefect, PartKind } from './grid-assets'
import { DEFECT_LABELS, SEVERITY_LABELS } from './grid-assets'

/** 检测器版本 —— 报告里要记,算法换了以后旧报告仍可追溯 */
export const DETECTOR_VERSION = 'rule-v1'

/**
 * 相机成像模型(Mini 4 Pro 广角端的公开参数 + 一个经验阈值)。
 *
 * `requiredFeaturePixels = 9` 是「判定看清」的门槛:低于约 9 px 的特征,
 * 人眼与算法都开始不可靠。这个数直接决定每个部位的极限拍摄距离,
 * 所以它写在模型里而不是散在各个判定分支里。
 */
export const CAMERA_MODEL = {
  wideFovDeg: 82,
  widePixels: 3840,
  requiredFeaturePixels: 9,
  /** 云台自身能补掉的机身偏航(度)—— 超出部分才会让画面歪掉 */
  gimbalYawRangeDeg: 5,
  /** 偏心到视场边缘时的成像折扣 */
  edgePenalty: 0.8,
  /** 俯仰超过该角度开始出现畸变(度) */
  tiltSoftLimitDeg: 35,
  /** 俯仰畸变的最大折扣 */
  tiltPenalty: 0.3,
  /** 机身对准误差超出云台行程后的最大折扣 */
  aimPenalty: 0.9,
} as const

const WEATHER_FACTORS: Record<WeatherKind, number> = {
  clear: 1,
  cloudy: 0.98,
  overcast: 0.94,
  rain: 0.78,
  fog: 0.6,
}

/** 误检时最容易被误判成缺陷的邻近缺陷类型(按部位区分) */
const FALSE_ALARM_KINDS: Record<PartKind, DefectKind> = {
  insulator: 'insulatorPollution',
  arm: 'armDeformation',
  towerHead: 'boltMissing',
  towerBody: 'towerRust',
  foundation: 'foundationSettlement',
}

/** 一次拍摄的几何观测 —— 由任务从实际位姿算出,不是计划的理想值 */
export interface PartObservation {
  /** 机体到部位的直线距离(米) */
  readonly rangeM: number
  /** 部位偏离镜头光轴的夹角(度):0 = 正中,越大越靠画面边缘 */
  readonly offAxisDeg: number
  /** 镜头俯仰角(度,正 = 抬头) */
  readonly tiltDeg: number
  /** 机身与部位方位的夹角(度):云台只能补 5°,超出就得靠转机身 */
  readonly headingErrorDeg: number
}

/** 成像质量拆解 —— 每一项都可单独断言,也便于界面上解释「为什么没看清」 */
export interface QualityBreakdown {
  /** 特征落在几个像素上 */
  readonly featurePixels: number
  /** 分辨率项 */
  readonly resolution: number
  readonly offAxis: number
  readonly tilt: number
  readonly aim: number
  readonly weather: number
  readonly wind: number
  /** 总成像质量 0~1 */
  readonly quality: number
}

export interface QualityInput {
  readonly criticalSizeM: number
  readonly observation: PartObservation
  readonly lensZoom: number
  readonly weather: WeatherKind
  readonly windSpeedMps: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

/** 平滑阶跃:比线性更接近「刚好够 / 清楚」的直觉 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

const radToDeg = (rad: number): number => (rad * 180) / Math.PI

/** 计算成像质量及其分项 */
export function imagingQuality(input: QualityInput): QualityBreakdown {
  const observation = input.observation
  // 目标特征对应的张角 → 除以每像素视场 → 落在几个像素上
  const range = Math.max(observation.rangeM, 0.5)
  const featureAngularDeg = radToDeg(2 * Math.atan(input.criticalSizeM / (2 * range)))
  const ifovDeg = CAMERA_MODEL.wideFovDeg / CAMERA_MODEL.widePixels / Math.max(input.lensZoom, 1)
  const featurePixels = featureAngularDeg / ifovDeg

  const halfFov = CAMERA_MODEL.wideFovDeg / 2
  const resolution = smoothstep(
    CAMERA_MODEL.requiredFeaturePixels * 0.55,
    CAMERA_MODEL.requiredFeaturePixels * 1.9,
    featurePixels,
  )
  const offAxis = 1 - clamp01(observation.offAxisDeg / halfFov) ** 2 * CAMERA_MODEL.edgePenalty
  const tilt =
    1 - clamp01((Math.abs(observation.tiltDeg) - CAMERA_MODEL.tiltSoftLimitDeg) / 40) * CAMERA_MODEL.tiltPenalty
  const aim =
    1 -
    clamp01(
      (Math.abs(observation.headingErrorDeg) - CAMERA_MODEL.gimbalYawRangeDeg) / 20,
    ) *
      CAMERA_MODEL.aimPenalty
  const weather = WEATHER_FACTORS[input.weather]
  const wind = 1 - clamp01((input.windSpeedMps - 6) / 6) * 0.25

  return {
    featurePixels: Math.round(featurePixels * 10) / 10,
    resolution,
    offAxis,
    tilt,
    aim,
    weather,
    wind,
    quality: clamp01(resolution * offAxis * tilt * aim * weather * wind),
  }
}

/** 巡检结论 —— 注意 `unchecked` 不是检测器产出的,是任务「这个拍点没拍成」 */
export type DetectionVerdict = 'ok' | 'suspect' | 'defect' | 'unchecked'

export interface DetectorInput {
  readonly towerId: string
  readonly partId: string
  readonly partKind: PartKind
  readonly criticalSizeM: number
  /** 该部位真实存在的缺陷;null = 正常 */
  readonly truth: PartDefect | null
  readonly observation: PartObservation
  readonly lensZoom: number
  readonly weather: WeatherKind
  readonly windSpeedMps: number
  /** 会话种子 */
  readonly seed: number
}

export interface DetectionResult {
  readonly verdict: DetectionVerdict
  /** 判出的缺陷类型(verdict = defect / suspect 时有值) */
  readonly kind: DefectKind | null
  readonly severity: DefectSeverity | null
  readonly confidence: number
  readonly quality: QualityBreakdown
  readonly note: string
}

/** FNV-1a:把「种子 + 塔号 + 部位」压成一个 32 位整数,做为该部位本次判定的随机源 */
function hashSeed(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/**
 * 判定一个部位。
 *
 * 两个概率都是**成像质量的函数**:
 *   · 真有缺陷却看不出来 → `1 − (0.9·quality + 严重度基数)`。严重(缺件/破损)本身就更容易被注意,
 *     所以 major 的基础检出率天然高于 minor —— 这也是现实里 minor 隐患容易漏的原因。
 *   · 本来没缺陷却报了 → `(1 − quality) × 0.18`,而且只报「疑似」不报「缺陷」:
 *     低质量图片能给的最强结论就是「回去复拍」。
 */
export function detect(input: DetectorInput): DetectionResult {
  const quality = imagingQuality({
    criticalSizeM: input.criticalSizeM,
    observation: input.observation,
    lensZoom: input.lensZoom,
    weather: input.weather,
    windSpeedMps: input.windSpeedMps,
  })
  const random = createSeededRandom(hashSeed(`${input.seed}|${input.towerId}|${input.partId}`))
  const roll = random.next()

  if (!input.truth) {
    const falseAlarmRate = (1 - quality.quality) * 0.18
    if (roll < falseAlarmRate) {
      const kind = FALSE_ALARM_KINDS[input.partKind]
      return {
        verdict: 'suspect',
        kind,
        severity: 'minor',
        confidence: clamp01(0.25 + 0.3 * quality.quality),
        quality,
        note: `成像质量偏低(${percent(quality.quality)}、特征仅 ${quality.featurePixels} px),疑似${DEFECT_LABELS[kind]},建议复拍`,
      }
    }
    return {
      verdict: 'ok',
      kind: null,
      severity: null,
      confidence: clamp01(0.6 + 0.39 * quality.quality),
      quality,
      note: `未见异常(成像质量 ${percent(quality.quality)})`,
    }
  }

  const baseDetect = input.truth.severity === 'major' ? 0.25 : 0.05
  const detectRate = clamp01(0.9 * quality.quality + baseDetect)
  if (roll < detectRate) {
    return {
      verdict: 'defect',
      kind: input.truth.kind,
      severity: input.truth.severity,
      confidence: clamp01(0.55 + 0.44 * quality.quality),
      quality,
      note: `检出${SEVERITY_LABELS[input.truth.severity]}:${DEFECT_LABELS[input.truth.kind]}(置信度随成像质量 ${percent(quality.quality)})`,
    }
  }

  return {
    verdict: 'ok',
    kind: null,
    severity: null,
    confidence: clamp01(0.6 + 0.39 * quality.quality),
    quality,
    note: `本次拍摄未能分辨(成像质量 ${percent(quality.quality)}、特征仅 ${quality.featurePixels} px)`,
  }
}

/** 供报告与界面复用:把检测结论缩成一行人类可读的结论 */
export function describeDetection(result: DetectionResult): string {
  switch (result.verdict) {
    case 'defect':
      return `${SEVERITY_LABELS[result.severity ?? 'minor']} · ${DEFECT_LABELS[result.kind ?? 'boltMissing']}`
    case 'suspect':
      return `疑似${DEFECT_LABELS[result.kind ?? 'boltMissing']} · 待复核`
    case 'unchecked':
      return '未采集'
    default:
      return '正常'
  }
}
