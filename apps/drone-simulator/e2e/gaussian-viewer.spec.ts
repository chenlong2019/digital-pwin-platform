import { expect, test, type Page } from '@playwright/test'

const jobId = 'job-gaussian-fixture'
const count = 64
const properties = [
  'x',
  'y',
  'z',
  'nx',
  'ny',
  'nz',
  'f_dc_0',
  'f_dc_1',
  'f_dc_2',
  'opacity',
  'scale_0',
  'scale_1',
  'scale_2',
  'rot_0',
  'rot_1',
  'rot_2',
  'rot_3',
]
// Same binary PLY contract as the training exporter, with asymmetric geometry,
// anisotropic scales, SH DC colors, logit opacity and wxyz quaternion rotations.
const header = Buffer.from(
  `ply\nformat binary_little_endian 1.0\nelement vertex ${count}\n${properties.map((property) => `property float ${property}\n`).join('')}end_header\n`,
)
const body = Buffer.alloc(count * properties.length * 4)
for (let i = 0; i < count; i++) {
  const color = [i % 2 ? 0.8 : 0.2, i % 3 ? 0.3 : 0.8, 0.4]
  const theta = ((i % 4) * Math.PI) / 8
  const values = [
    (i % 8) - 3.5,
    (i % 5) * 0.7,
    Math.floor(i / 8) - 3.5,
    0,
    0,
    0,
    ...color.map((value) => (value - 0.5) / 0.28209479177387814),
    Math.log(9),
    Math.log(0.6),
    Math.log(0.2),
    Math.log(0.35),
    Math.cos(theta),
    0,
    Math.sin(theta),
    0,
  ]
  values.forEach((value, index) => body.writeFloatLE(value, (i * properties.length + index) * 4))
}
const ply = Buffer.concat([header, body])
const frames = [0, 1].map((i) => ({
  frameId: `test-${i}`,
  cameraPose: {
    positionM: { x: 0, y: 6, z: i ? -18 : 18 },
    quaternionXyzw: i ? { x: 0, y: 1, z: 0, w: 0 } : { x: 0, y: 0, z: 0, w: 1 },
    coordinateFrame: 'platform-world',
  },
  cameraIntrinsics: { width: 512, height: 384, fy: 350 },
}))

async function mockModel(
  page: Page,
  options: { failOnce?: boolean; status?: string; corrupt?: boolean } = {},
) {
  let attempts = 0
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  }
  await page.route('**/api/v1/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/model.ply')) {
      if (options.failOnce && attempts++ === 0) return route.fulfill({ status: 503, headers })
      return route.fulfill({
        contentType: 'application/octet-stream',
        body: options.corrupt ? Buffer.from('invalid model') : ply,
        headers,
      })
    }
    const json = path.endsWith('/report.json')
      ? {
          gaussians: count,
          steps: 400,
          width: 512,
          height: 384,
          test_frames: frames.map((frame) => frame.frameId),
          quality: { psnr: 20, ssim: 0.8, foreground_psnr: 16, foreground_fraction: 0.3 },
          initial_quality: { psnr: 15, ssim: 0.5 },
          training_seconds: 10,
          performance: { fps: 20, p95_ms: 50, peak_allocated_mb: 100 },
          views: [],
        }
      : path.endsWith('/manifest.json')
        ? { coordinateFrame: 'platform-world', frames }
        : {
            job_id: jobId,
            backend: 'torch-3dgs-reference',
            status: options.status ?? 'completed',
            request: { dataset_id: 'fixture', steps: 400, gaussians: count, seed: 1 },
            result: { stage: 'completed', steps: 400, step: 400 },
          }
    return route.fulfill({ json, headers })
  })
}

test('真实高斯PLY可交互渲染，切换视角改变画面，退出后可再次加载', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await mockModel(page)
  await page.goto(`/experiments/${jobId}/model`)
  const viewer = page.getByTestId('gaussian-viewer')
  await expect(viewer).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  await expect(page.getByTestId('gaussian-fps')).toContainText(/浏览器 [1-9]\d* FPS/)
  await expect(page.getByText('64 个高斯', { exact: true })).toBeVisible()
  const canvas = page.getByLabel('交互式三维高斯模型')
  const initial = await canvas.screenshot()
  await page.getByRole('button', { name: '俯视', exact: true }).click()
  await expect.poll(async () => !(await canvas.screenshot()).equals(initial)).toBe(true)
  await page.getByRole('button', { name: '自动环绕', exact: true }).click()
  await expect(page.getByRole('button', { name: '停止环绕' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: '重置视角', exact: true }).click()
  await expect(page.getByRole('button', { name: '自动环绕' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await page.getByLabel('三维模型视角').selectOption('test-0')
  await page.getByLabel('三维模型视角').selectOption('test-1')
  await expect(page.getByRole('link', { name: '下载 PLY' })).toHaveAttribute(
    'href',
    new RegExp(`/${jobId}/artifacts/model.ply$`),
  )
  await page.getByRole('link', { name: '← 实验结果', exact: true }).click()
  await expect(canvas).toHaveCount(0)
  await page.goBack()
  await expect(viewer).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  expect(errors).toEqual([])
})

test('模型读取失败有明确提示，重新加载可恢复', async ({ page }) => {
  await mockModel(page, { failOnce: true })
  await page.goto(`/experiments/${jobId}/model`)
  await expect(page.getByRole('alert')).toContainText('503', { timeout: 30_000 })
  await page.getByRole('button', { name: '重新加载', exact: true }).click()
  await expect(page.getByTestId('gaussian-viewer')).toHaveAttribute('data-state', 'ready', {
    timeout: 30_000,
  })
})

test('训练未完成时不请求或展示高斯模型', async ({ page }) => {
  const models: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/model.ply')) models.push(request.url())
  })
  await mockModel(page, { status: 'running' })
  await page.goto(`/experiments/${jobId}/model`)
  await expect(page.getByRole('alert')).toContainText('尚未完成')
  await expect(page.getByLabel('交互式三维高斯模型')).toHaveCount(0)
  expect(models).toEqual([])
})

test('损坏的模型不静默显示空场景', async ({ page }) => {
  await mockModel(page, { corrupt: true })
  await page.goto(`/experiments/${jobId}/model`)
  await expect(page.getByTestId('gaussian-viewer')).toHaveAttribute('data-state', 'error', {
    timeout: 30_000,
  })
  await expect(page.getByRole('button', { name: '重新加载' })).toBeVisible()
})

test('窄屏保留视口和操作入口，无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockModel(page)
  await page.goto(`/experiments/${jobId}/model`)
  await expect(page.getByTestId('gaussian-viewer')).toHaveAttribute('data-state', 'ready', {
    timeout: 30_000,
  })
  await expect(page.getByLabel('交互式三维高斯模型')).toBeInViewport()
  await expect(page.getByRole('button', { name: '重置视角' })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
