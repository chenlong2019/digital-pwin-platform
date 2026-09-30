import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * 云台与机载相机视角的浏览器验证。
 *
 * 这两样只活在渲染层:云台是模型上的三个节点,机载视角是相机摆位 ——
 * 无头测试完全碰不到。所以这里不看数字,直接比**视口画布的截图**:
 * 切到机载视角、把云台压到垂直向下,取景就必须真的换掉,而不是面板上换个读数。
 */

/** 拨动 range 滑杆 —— range input 不支持 fill(),得手动派发 input 事件 */
async function setRange(page: Page, testId: string, value: number): Promise<void> {
  await page.locator(`[data-testid="${testId}"]`).evaluate((element, next) => {
    const input = element as HTMLInputElement
    input.value = String(next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

async function viewportShot(page: Page): Promise<Buffer> {
  return page.locator('.viewport__canvas canvas').screenshot()
}

test('云台与机载相机视角在真实浏览器里生效', async ({ page }) => {
  test.setTimeout(150_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')
  await expect(page.locator('canvas')).toBeVisible()
  // 等模型载入(部件自检出现):云台三个节点绑不上,机载取景就拿不到变换
  await expect(page.getByText(/已识别/).first()).toBeVisible({ timeout: 60_000 })

  // 侧栏已改标签页分组:云台与相机面板在「相机」页里,先切过去
  await page.getByTestId('tab-camera').click()
  const panel = page.locator('section.panel', { has: page.getByText('云台与相机', { exact: true }) })
  await expect(panel).toBeVisible()
  // 两个读数:0 = 云台俯仰,1 = 相机变焦
  const pitchReadout = panel.locator('.readout').nth(0)
  const zoomReadout = panel.locator('.readout').nth(1)
  // 出厂云台角度:略微俯视 −10°
  await expect(pitchReadout).toHaveText('-10.0°')
  await expect(zoomReadout).toHaveText('1.0×')

  // —— 观察者视角 ——
  const observerShot = await viewportShot(page)

  // —— 切到机载视角:取景应当整个换掉 ——
  await panel.getByTestId('fpv-toggle').click()
  await expect(panel.getByTestId('fpv-toggle')).toHaveText('退出机载视角')
  await page.waitForTimeout(700)
  const fpvShot = await viewportShot(page)
  expect(fpvShot.equals(observerShot), '切到机载视角后取景必须变化').toBe(false)

  // —— 云台垂直向下:画面应当朝地面 ——
  await setRange(page, 'gimbal-pitch', -90)
  await expect(pitchReadout).toHaveText('-90.0°')
  await page.waitForTimeout(700)
  const downShot = await viewportShot(page)
  expect(downShot.equals(fpvShot), '云台垂直向下后取景必须变化').toBe(false)

  // —— 水平前视(0°)作为变焦比较的基准 ——
  await panel.getByRole('button', { name: '水平前视' }).click()
  await expect(pitchReadout).toHaveText('0.0°')
  await page.waitForTimeout(500)
  const levelShot = await viewportShot(page)

  // —— 变焦 1× → 4× ——
  await setRange(page, 'camera-zoom', 4)
  await expect(zoomReadout).toHaveText('4.0×')
  await page.waitForTimeout(500)
  const zoomShot = await viewportShot(page)
  expect(zoomShot.equals(levelShot), '变焦后取景必须变化').toBe(false)

  // —— 回中(云台复位到 −10°)与退出机载视角 ——
  await panel.getByRole('button', { name: '回中' }).click()
  await expect(pitchReadout).toHaveText('-10.0°')
  await panel.getByTestId('fpv-toggle').click()
  await expect(panel.getByTestId('fpv-toggle')).toHaveText('切到机载视角')

  expect(errors).toEqual([])
})

test('拍照与录像:云台取景 + 落盘', async ({ page }) => {
  test.setTimeout(150_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')
  await expect(page.locator('canvas')).toBeVisible()
  await expect(page.getByText(/已识别/).first()).toBeVisible({ timeout: 60_000 })

  // 侧栏已改标签页分组:云台与相机面板在「相机」页里,先切过去
  await page.getByTestId('tab-camera').click()
  const panel = page.locator('section.panel', { has: page.getByText('云台与相机', { exact: true }) })

  // —— 拍照:取景走云台,成片自动下载 ——
  const photoDownload = page.waitForEvent('download')
  await panel.getByTestId('photo-button').click()
  const photo = await photoDownload
  expect(photo.suggestedFilename()).toMatch(/^DJI_Mini4Pro_photo_\d{8}_\d{6}\.png$/)

  const photoPath = await photo.path()
  expect(photoPath).toBeTruthy()
  const photoBytes = readFileSync(photoPath as string)
  // PNG 魔数 89 50 4E 47
  expect([...photoBytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  expect(photoBytes.length).toBeGreaterThan(1000)

  // 缩略图 + 提示 + 领域层计数(命令闭环走通了才会 +1)
  await expect(panel.getByTestId('photo-thumb')).toBeVisible()
  await expect(panel.getByTestId('photo-note')).toContainText('已保存')
  await expect(panel.getByTestId('photo-button')).toContainText('已拍 1')

  // —— 录像:开始 → REC 计时 → 停止 → 成片下载 ——
  const recordDownload = page.waitForEvent('download')
  await panel.getByTestId('record-toggle').click()
  await expect(panel.getByTestId('record-toggle')).toHaveText('停止录像')
  await expect(panel.getByTestId('record-note')).toContainText('录制中')

  await page.waitForTimeout(1500)
  await panel.getByTestId('record-toggle').click()
  await expect(panel.getByTestId('record-toggle')).toHaveText('开始录像')

  const video = await recordDownload
  expect(video.suggestedFilename()).toMatch(/^DJI_Mini4Pro_record_\d{8}_\d{6}\.webm$/)
  const videoPath = await video.path()
  expect(videoPath).toBeTruthy()
  const videoBytes = readFileSync(videoPath as string)
  // WebM/Matroska 魔数 1A 45 DF A3
  expect([...videoBytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
  expect(videoBytes.length).toBeGreaterThan(0)

  await expect(panel.getByTestId('record-note')).toContainText('已保存')

  expect(errors).toEqual([])
})
