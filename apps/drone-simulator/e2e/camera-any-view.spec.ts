import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * 非云台视角下的拍照与录像取景。
 *
 * 真机只有一个云台相机,所以拍照与录像都必须是它拍的 —— 与用户当前在看哪个视角无关。
 * 这里不满足于「能不能拍出文件」,而是比像素:把「观察者视角下拍出的照片」分别与
 * 「机载视角画面」「观察者视角画面」比对相似度(16×16 下采样的平均绝对差,越小越像)。
 *
 * 阈值取自实测:两种不同取景之间差 ~21,同一取景(拍照 vs 机载画面)差 ~3.6。
 */
const SAME_VIEW_MAX_DIFF = 9
const DIFFERENT_VIEW_MIN_DIFF = 10
/** 1.5 s @ 8 Mbps 理论约 1.5 MB;远低于这个量级说明录制器没收到帧 */
const RECORD_MIN_BYTES = 20_000

async function imageDiff(page: Page, dataUrlA: string, dataUrlB: string): Promise<number> {
  return page.evaluate(
    async ([a, b]) => {
      const load = (src: string): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = () => reject(new Error('图片解码失败'))
          image.src = src
        })
      const [imageA, imageB] = await Promise.all([load(a), load(b)])
      const size = 16
      const sample = (image: HTMLImageElement): Uint8ClampedArray => {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const context = canvas.getContext('2d')
        if (!context) throw new Error('缺少 2d 上下文')
        context.drawImage(image, 0, 0, size, size)
        return context.getImageData(0, 0, size, size).data
      }
      const dataA = sample(imageA)
      const dataB = sample(imageB)
      let sum = 0
      for (let i = 0; i < dataA.length; i += 4) {
        sum += Math.abs((dataA[i] ?? 0) - (dataB[i] ?? 0))
        sum += Math.abs((dataA[i + 1] ?? 0) - (dataB[i + 1] ?? 0))
        sum += Math.abs((dataA[i + 2] ?? 0) - (dataB[i + 2] ?? 0))
      }
      return sum / (size * size * 3)
    },
    [dataUrlA, dataUrlB] as const,
  )
}

async function shotDataUrl(page: Page): Promise<string> {
  const buffer = await page.locator('.viewport__canvas canvas').screenshot()
  return `data:image/png;base64,${buffer.toString('base64')}`
}

/**
 * 从录制成片里抽一帧。
 *
 * MediaRecorder 产出的 WebM 通常没写时长元数据,seek 不可靠,所以直接播到目标
 * 时刻再抓画面 —— 这样拿到的是"录像里那一刻观众真正会看到的画面"。
 */
async function videoFrameDataUrl(page: Page, videoBase64: string, atSeconds: number): Promise<string> {
  return page.evaluate(
    async ([base64, seconds]) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }))
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.src = url
      try {
        await new Promise<void>((resolve, reject) => {
          video.onloadeddata = () => resolve()
          video.onerror = () => reject(new Error('录制成片无法解码'))
        })
        await video.play()
        await new Promise<void>((resolve) => {
          const step = (): void => {
            if (video.currentTime >= seconds) {
              video.pause()
              resolve()
              return
            }
            if (typeof video.requestVideoFrameCallback === 'function') {
              video.requestVideoFrameCallback(() => step())
            } else {
              requestAnimationFrame(() => step())
            }
          }
          step()
        })
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth || 1
        canvas.height = video.videoHeight || 1
        const context = canvas.getContext('2d')
        if (!context) throw new Error('缺少 2d 上下文')
        context.drawImage(video, 0, 0)
        return canvas.toDataURL('image/png')
      } finally {
        URL.revokeObjectURL(url)
      }
    },
    [videoBase64, atSeconds] as const,
  )
}

test('观察者视角下拍照与录像都走云台取景', async ({ page }) => {
  test.setTimeout(180_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')
  await expect(page.locator('canvas')).toBeVisible()
  // 默认停在「飞行」页:起飞按钮可用 = 自检与检查单已过,云台节点绑上了模型
  await expect(page.getByRole('button', { name: '一键起飞' })).toBeEnabled({ timeout: 60_000 })
  await page.getByTestId('tab-camera').click()

  const panel = page.locator('section.panel', { has: page.getByText('云台与相机', { exact: true }) })
  await expect(panel).toBeVisible()

  // —— 基准:机载视角画面 = 云台取景 ——
  await panel.getByTestId('fpv-toggle').click()
  await expect(panel.getByTestId('fpv-toggle')).toHaveText('退出机载视角')
  await page.waitForTimeout(900)
  const gimbalShot = await shotDataUrl(page)

  // —— 切回观察者视角:这是用户实际在看、但**不该**被拍下来的画面 ——
  await panel.getByTestId('fpv-toggle').click()
  await expect(panel.getByTestId('fpv-toggle')).toHaveText('切到机载视角')
  await page.waitForTimeout(900)
  const observerShot = await shotDataUrl(page)

  const diffViews = await imageDiff(page, gimbalShot, observerShot)
  expect(diffViews, '前提:机载视角与观察者视角的画面必须明显不同').toBeGreaterThan(DIFFERENT_VIEW_MIN_DIFF)

  // —— 就在观察者视角下按快门 ——
  const photoDownload = page.waitForEvent('download')
  await panel.getByTestId('photo-button').click()
  const photo = await photoDownload
  const photoPath = await photo.path()
  expect(photoPath).toBeTruthy()
  const photoShot = `data:image/png;base64,${readFileSync(photoPath as string).toString('base64')}`

  const diffToGimbal = await imageDiff(page, photoShot, gimbalShot)
  const diffToObserver = await imageDiff(page, photoShot, observerShot)
  expect(
    diffToGimbal,
    `观察者视角下拍出的照片应当就是云台取景(与机载视角画面差异 ${diffToGimbal.toFixed(1)})`,
  ).toBeLessThan(SAME_VIEW_MAX_DIFF)
  expect(
    diffToObserver,
    `照片不应当是观察者视角的画面(与观察者画面差异 ${diffToObserver.toFixed(1)})`,
  ).toBeGreaterThan(DIFFERENT_VIEW_MIN_DIFF)

  // 缩略图与领域层计数照旧:命令闭环没被取景改动打断
  await expect(panel.getByTestId('photo-thumb')).toBeVisible()
  await expect(panel.getByTestId('photo-button')).toContainText('已拍 1')

  // —— 录像:仍在观察者视角下录,录制帧走同一条云台取景路径 ——
  const recordDownload = page.waitForEvent('download')
  await panel.getByTestId('record-toggle').click()
  await expect(panel.getByTestId('record-toggle')).toHaveText('停止录像')
  await page.waitForTimeout(1500)
  await panel.getByTestId('record-toggle').click()
  await expect(panel.getByTestId('record-toggle')).toHaveText('开始录像')

  const video = await recordDownload
  const videoPath = await video.path()
  expect(videoPath).toBeTruthy()
  const videoBytes = readFileSync(videoPath as string)
  // WebM/Matroska 魔数 1A 45 DF A3
  expect([...videoBytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
  // 手动抓帧模式下录制器只在云台帧上 requestFrame:文件太小就说明帧根本没进去
  expect(
    videoBytes.length,
    `录制成片只有 ${videoBytes.length} 字节,说明云台取景帧没有被推进录制器`,
  ).toBeGreaterThan(RECORD_MIN_BYTES)
  await expect(panel.getByTestId('record-note')).toContainText('已保存')

  // —— 关键:录进文件里的画面到底是哪个视角 ——
  // 光有文件不够:画布捕获是「绘制之后」抓帧的,顺序错了会把随后渲染的用户视角
  // 录进去。这里直接把成片抽帧,和两种视角的画面比像素。
  const recordedFrame = await videoFrameDataUrl(page, videoBytes.toString('base64'), 0.8)
  const recordedToGimbal = await imageDiff(page, recordedFrame, gimbalShot)
  const recordedToObserver = await imageDiff(page, recordedFrame, observerShot)
  expect(
    recordedToGimbal,
    `录到的画面应当是云台取景(与机载视角画面差异 ${recordedToGimbal.toFixed(1)})`,
  ).toBeLessThan(SAME_VIEW_MAX_DIFF)
  expect(
    recordedToObserver,
    `录到的画面不应当是观察者视角(与观察者画面差异 ${recordedToObserver.toFixed(1)})`,
  ).toBeGreaterThan(DIFFERENT_VIEW_MIN_DIFF)

  console.log(
    `[录像取景] 成片帧 vs 机载画面 = ${recordedToGimbal.toFixed(2)},成片帧 vs 观察者画面 = ${recordedToObserver.toFixed(2)}`,
  )

  expect(errors).toEqual([])
})
