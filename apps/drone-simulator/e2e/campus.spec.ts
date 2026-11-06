import { expect, test } from '@playwright/test'

test('远程细节离线时仍可浏览园区、起飞并拍摄机载照片', async ({ page, context }) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await context.route('http://49.235.216.125/pointcloud/**', (route) => route.abort())
  await page.goto('/')
  const status = page.getByTestId('campus-status')
  await expect(status).toHaveAttribute('data-points', '606306', { timeout: 30_000 })
  await expect(status).toHaveAttribute('data-state', 'degraded', { timeout: 30_000 })
  await page.getByRole('button', { name: '聚焦无人机', exact: true }).click()
  const takeoff = page.getByRole('button', { name: '一键起飞', exact: true })
  await expect(takeoff).toBeEnabled({ timeout: 30_000 })
  await takeoff.click()
  await page.getByTestId('tab-telemetry').click()
  await expect(page.getByText('飞行中', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await page.locator('.camera-switch').getByRole('button', { name: '机载', exact: true }).click()
  await page.getByTestId('tab-camera').click()
  await page.getByTestId('photo-button').click()
  const photo = page.getByTestId('photo-thumb')
  await expect(photo).toBeVisible()
  const image = await photo.evaluate(async (element) => {
    const img = element as HTMLImageElement
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const context = canvas.getContext('2d')!
    context.drawImage(img, 0, 0)
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    const colors = new Set<number>()
    let lit = 0,
      samples = 0
    for (let i = 0; i < data.length; i += 64) {
      const r = data[i]!,
        g = data[i + 1]!,
        b = data[i + 2]!
      colors.add((r << 16) | (g << 8) | b)
      if (r + g + b > 180) lit++
      samples++
    }
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      colors: colors.size,
      lit: lit / samples,
    }
  })
  expect(image.width).toBeGreaterThan(500)
  expect(image.height).toBeGreaterThan(200)
  expect(image.colors).toBeGreaterThan(50)
  expect(image.lit).toBeGreaterThan(0.05)
  await page.getByTestId('campus-overview').click()
  await expect(status).not.toHaveAttribute('data-state', 'error')
  expect(errors).toEqual([])
})

test('离开并重进园区会重新创建场景，汽车场景仍可单独使用', async ({ page, context }) => {
  test.setTimeout(60_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await context.route('http://49.235.216.125/pointcloud/**', (route) => route.abort())
  await page.goto('/')
  await expect(page.getByTestId('campus-status')).toHaveAttribute('data-points', '606306', {
    timeout: 30_000,
  })
  await page.getByRole('link', { name: '汽车沙盒', exact: true }).click()
  await expect(page.getByTestId('campus-status')).toHaveCount(0)
  await expect(page.locator('.viewport__canvas canvas')).toHaveCount(1)
  await page.getByRole('link', { name: '无人机沙盒', exact: true }).click()
  await expect(page.getByTestId('campus-status')).toHaveAttribute('data-points', '606306', {
    timeout: 30_000,
  })
  await expect(page.locator('.viewport__canvas canvas')).toHaveCount(1)
  expect(errors).toEqual([])
})

test('概览加载失败时提供明确状态，飞行面板仍可用', async ({ page }) => {
  await page.route('**/scenes/campus-road/index.json', (route) =>
    route.fulfill({ status: 503, body: 'Unavailable' }),
  )
  await page.goto('/')
  await expect(page.getByTestId('campus-status')).toHaveAttribute('data-state', 'error')
  await expect(page.getByText('园区点云载入失败', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '一键起飞', exact: true })).toBeVisible()
})
