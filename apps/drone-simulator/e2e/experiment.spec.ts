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
  await expect(page.getByRole('link', { name: '查看三维模型 ↗' }).first()).toHaveAttribute(
    'href',
    `/experiments/${jobId}/model`,
  )
  await page.locator('.view-picker select').selectOption('1')
  await expect(page.getByAltText('训练后的高斯渲染')).toHaveAttribute(
    'src',
    /test-1-prediction\.png$/,
  )
  await page.reload()
  await expect(page.getByTestId('experiment-report')).toBeVisible()
  expect(errors).toEqual([])
})

test('单栋精细为新实验默认档位，旧实验保持原设置；测试图按原始尺寸查看并支持关闭', async ({
  page,
}) => {
  await mockService(page)
  await page.goto('/experiments')
  await expect(page.getByTestId('experiment-preset')).toHaveValue('building')
  await expect(page.getByTestId('experiment-steps')).toHaveValue('6000')
  await expect(page.locator('input[type="number"]')).toHaveValue('180000')
  await expect(page.getByRole('heading', { name: '西南独立楼 A · 精细采集' })).toBeVisible()
  await expect(page.locator('.capture-summary')).toContainText('64 个训练视角')
  await page.getByTestId('experiment-preset').selectOption('baseline')
  await expect(page.getByTestId('experiment-steps')).toHaveValue('400')
  await page.goto(`/experiments?job=${jobId}`)
  await expect(page.getByTestId('experiment-report')).toBeVisible()
  await expect(page.getByTestId('experiment-preset')).toHaveValue('baseline')
  await page.getByRole('button', { name: '放大高斯渲染', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '测试图原始像素' })
  await expect(dialog).toBeVisible()
  const original = dialog.getByAltText('当前测试图原始像素')
  await expect(original).toHaveAttribute('width', '256')
  await expect(original).toHaveAttribute('src', /test-0-prediction\.png$/)
  await dialog.getByRole('button', { name: '参考图', exact: true }).click()
  await expect(original).toHaveAttribute('src', /test-0-reference\.png$/)
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
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

test('桌面滚轮能从采集预览滚动到结果区域', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  await mockService(page)
  await page.goto(`/experiments?job=${jobId}`)
  const results = page.getByRole('heading', { name: '独立测试结果', exact: true })
  await expect(results).toBeAttached()
  await expect(results).not.toBeInViewport()

  // Use actual wheel input. scrollIntoView can move overflow:hidden ancestors
  // programmatically and would hide this user-facing scrolling regression.
  await page.mouse.move(400, 450)
  await page.mouse.wheel(0, 650)
  await expect
    .poll(() => page.locator('.experiment').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100)
  await expect(results).toBeInViewport()

  await page.locator('.experiment').focus()
  await page.keyboard.press('Home')
  await expect
    .poll(() => page.locator('.experiment').evaluate((element) => element.scrollTop))
    .toBe(0)
  await page.keyboard.press('End')
  await expect(page.getByAltText('绝对误差放大三倍')).toBeInViewport()
})

test('顶部查看结果入口可直接定位到指标和图像对比', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  await mockService(page)
  await page.goto(`/experiments?job=${jobId}`)
  const results = page.getByRole('heading', { name: '独立测试结果', exact: true })
  await expect(results).toBeAttached()
  await expect(results).not.toBeInViewport()
  await page.getByRole('button', { name: '查看结果 ↓' }).click()
  await expect(results).toBeInViewport()
  await expect(page.getByTestId('experiment-report')).toBeFocused()
})

test.describe('触屏滚动', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

  test('手指滑动能到达结果区', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Native touch gesture verification uses Chromium CDP')
    await mockService(page)
    await page.goto(`/experiments?job=${jobId}`)
    const results = page.getByRole('heading', { name: '独立测试结果', exact: true })
    await expect(results).toBeAttached()
    await expect(results).not.toBeInViewport()
    const session = await page.context().newCDPSession(page)
    try {
      for (let swipe = 0; swipe < 3; swipe++) {
        if (
          await results.evaluate((element) => {
            const bounds = element.getBoundingClientRect()
            return bounds.top >= 0 && bounds.bottom <= innerHeight
          })
        )
          break
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: 180, y: 700 }],
        })
        for (let move = 1; move <= 10; move++) {
          await session.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: 180, y: 700 - move * 45 }],
          })
          // Space real touch moves across frames; dwell before release so the
          // gesture stops at the target instead of introducing a fling.
          await page.waitForTimeout(20)
        }
        await page.waitForTimeout(100)
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      }
      await expect
        .poll(() => page.locator('.experiment').evaluate((element) => element.scrollTop))
        .toBeGreaterThan(100)
      await expect(results).toBeInViewport()
    } finally {
      await session.detach()
    }
  })
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
