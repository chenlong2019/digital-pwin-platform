import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import type { Download } from '@playwright/test'

/**
 * 领域层自行停录时的成片落盘。
 *
 * 录像的**状态**在领域层(快照的 recording),录制器却在渲染层。降落收尾、重置这类
 * 动作由领域层自己把 recording 置为 false —— 如果没人把这个变化对账到渲染层,
 * 就会出现「界面显示录像已结束、REC 计时消失,但录制器还在录,成片永远拿不到」。
 *
 * 这个用例走的就是那条路:起飞 → 开录 → 点「自动降落」(全程没碰停止录像),
 * 降落后应当自动拿到成片。
 */
test('自动降落后录像自动收尾并落盘', async ({ page }) => {
  test.setTimeout(180_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const downloads: Download[] = []
  page.on('download', (download) => downloads.push(download))

  await page.goto('/')
  await expect(page.locator('canvas')).toBeVisible()

  const takeOff = page.getByRole('button', { name: '一键起飞' })
  await expect(takeOff).toBeEnabled({ timeout: 60_000 })
  await takeOff.click()

  // 等真的离地:降落按钮只在空中可用
  await page.getByTestId('tab-telemetry').click()
  await expect(page.getByText('空中', { exact: true }).first()).toBeVisible({ timeout: 30_000 })

  // 开录
  await page.getByTestId('tab-camera').click()
  const panel = page.locator('section.panel', { has: page.getByText('云台与相机', { exact: true }) })
  await expect(panel).toBeVisible()
  await panel.getByTestId('record-toggle').click()
  await expect(panel.getByTestId('record-toggle')).toHaveText('停止录像')
  await page.waitForTimeout(1500)

  // 关键:不点「停止录像」,而是让飞机自己降落 —— 停录由领域层收尾触发
  await page.getByTestId('tab-flight').click()
  await page.getByRole('button', { name: '自动降落' }).click()

  // 降落分三段:降向 1 米悬停位 → 低位悬停 → 缓慢触地。界面上的阶段文案应当跟着细分走
  // (「1 米悬停确认」只停 1 秒,这里断言窗口更长的「缓慢触地」那一档)
  await expect(page.getByTestId('status-phase')).toContainText('降落 · 缓慢触地', { timeout: 30_000 })

  // 落地 → 领域层自动停录 → 渲染层被对账收尾 → 交片
  await expect
    .poll(() => downloads.length, {
      timeout: 60_000,
      message: '降落收尾后应当自动落盘一次录像(修复前这里会一直等不到文件)',
    })
    .toBeGreaterThan(0)

  const video = downloads[0] as Download
  const videoPath = await video.path()
  expect(videoPath).toBeTruthy()
  const videoBytes = readFileSync(videoPath as string)
  // WebM/Matroska 魔数 1A 45 DF A3
  expect([...videoBytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
  expect(videoBytes.length, `降落收尾后的成片只有 ${videoBytes.length} 字节`).toBeGreaterThan(5000)

  // 界面回到「未录制」,并给出成片去向(自动下载被浏览器拦掉时还有手动通道)
  await page.getByTestId('tab-camera').click()
  await expect(panel.getByTestId('record-toggle')).toHaveText('开始录像')
  await expect(panel.getByTestId('record-note')).toContainText('已保存')
  await expect(panel.getByTestId('record-download')).toBeVisible()

  expect(errors).toEqual([])
})
