import { expect, test, type Page } from '@playwright/test'

const jobId = 'job-demo'
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=',
  'base64',
)
const report = {
  width: 256,
  height: 192,
  gaussians: 8000,
  training_seconds: 11,
  quality: { psnr: 22.05, ssim: 0.8615, foreground_psnr: 16.12, foreground_fraction: 0.2425 },
  initial_quality: { psnr: 18.42, ssim: 0.7801 },
  performance: { fps: 22.34, p95_ms: 66.49, peak_allocated_mb: 164 },
  views: [0, 1].map((i) => ({
    frame_id: `test-${i}`,
    psnr: 22 + i,
    ssim: 0.86,
    reference_image: `test-${i}-reference.png`,
    prediction_image: `test-${i}-prediction.png`,
    difference_image: `test-${i}-difference.png`,
  })),
}

async function mockService(
  page: Page,
  options: {
    online?: () => boolean
    reportFailsOnce?: boolean
    draft?: boolean
    missingTest?: boolean
  } = {},
) {
  const posts: string[] = []
  let reportAttempts = 0
  await page.route('**/api/v1/**', async (route) => {
    if (options.online && !options.online()) return route.abort('connectionrefused')
    const pathname = new URL(route.request().url()).pathname
    const method = route.request().method()
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    }
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (method === 'POST') posts.push(pathname)
    if (pathname.endsWith('.png'))
      return route.fulfill({ headers, contentType: 'image/png', body: image })
    if (pathname.endsWith('/report.json')) {
      if (options.reportFailsOnce && reportAttempts++ === 0)
        return route.fulfill({ status: 503, headers, json: { detail: '报告暂时不可用' } })
      return route.fulfill({ headers, json: report })
    }
    const job = {
      job_id: jobId,
      status: 'completed',
      request: { dataset_id: 'campus', steps: 400, gaussians: 8000, seed: 1 },
      result: { stage: 'completed', step: 400, steps: 400 },
      error: null,
    }
    const json = pathname.endsWith('/capabilities')
      ? { gpu: 'RTX 4060' }
      : pathname.endsWith('/manifest')
        ? {
            frames: Array.from({ length: 10 }, (_, i) => ({
              frameId: `view-${i}`,
              metadata: { split: i < 8 || options.missingTest ? 'train' : 'test' },
            })),
          }
        : pathname === '/api/v1/datasets/campus'
          ? { status: options.draft ? 'draft' : 'ready' }
          : pathname.endsWith('/finalize')
            ? { dataset: { status: 'ready' } }
            : job
    return route.fulfill({ headers, json })
  })
  return posts
}

test('指定实验链接恢复结果，报告读取失败后自动重试，切换测试视角', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await mockService(page, { reportFailsOnce: true })
  await page.goto(`/experiments?job=${jobId}`)
  await expect(page.getByTestId('experiment-report')).toBeVisible({ timeout: 12_000 })
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.metric-grid')).toContainText('22.05')
  await page.locator('.view-picker select').selectOption('1')
  await expect(page.getByAltText('训练后的高斯渲染')).toHaveAttribute(
    'src',
    /test-1-prediction\.png$/,
  )
  await page.reload()
  await expect(page.getByTestId('experiment-report')).toBeVisible()
  expect(errors).toEqual([])
})

test('离线时可重新连接，窄屏可以查看完整结果', async ({ page }) => {
  let online = false
  await page.setViewportSize({ width: 390, height: 844 })
  await mockService(page, { online: () => online })
  await page.goto(`/experiments?job=${jobId}`)
  await expect(page.getByRole('button', { name: '重新连接服务' })).toBeVisible()
  online = true
  await page.getByRole('button', { name: '重新连接服务' }).click()
  await expect(page.getByTestId('experiment-report')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByAltText('训练后的高斯渲染').scrollIntoViewIfNeeded()
  await expect(page.getByAltText('训练后的高斯渲染')).toBeInViewport()
})

for (const missingTest of [false, true]) {
  test(`恢复采集后提交已有数据：${missingTest ? '缺少独立测试视角时继续采集' : '先封存再训练'}`, async ({
    page,
  }) => {
    const posts = await mockService(page, { draft: true, missingTest })
    await page.addInitScript(() =>
      localStorage.setItem('campus.experiment.active', JSON.stringify({ datasetId: 'campus' })),
    )
    await page.goto('/experiments')
    await page.getByRole('button', { name: '提交已有数据训练' }).click()
    if (missingTest) {
      await expect(page.getByRole('alert')).toContainText(
        '至少需要 8 个训练视角和 2 个独立测试视角',
      )
      expect(posts).toEqual([])
    } else {
      await expect(page).toHaveURL(/\?job=job-demo$/)
      expect(posts).toEqual(['/api/v1/datasets/campus/finalize', '/api/v1/experiments'])
    }
  })
}
