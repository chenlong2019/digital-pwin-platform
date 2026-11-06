import { expect, test, type Page } from '@playwright/test'

const tasks = [
  { task_id: 'city-orbit', name: '城市环绕采集', status: 'running', total: 6, uploaded: 2 },
  {
    task_id: 'camera-calibration',
    name: '相机标定验证',
    status: 'completed',
    total: 3,
    uploaded: 3,
  },
  { task_id: 'low-altitude', name: '低空轨迹采集', status: 'queued', total: 4, uploaded: 0 },
].map((task) => ({
  ...task,
  dataset_id: `capture-${task.task_id}`,
  completed: task.uploaded,
  worker_id: task.status === 'queued' ? null : 'camera-local',
  pause_requested: false,
  error: null,
  lease_expires_at: task.status === 'running' ? new Date(Date.now() + 120_000).toISOString() : null,
  plan: {
    schemaVersion: 1,
    taskId: task.task_id,
    sceneId: 'three-demo-city-webgl-husky-v1',
    maxAttempts: 2,
    shots: Array.from({ length: task.total }, (_, index) => ({
      id: `view-${index}`,
      positionEnu: [index * 2, 0, 6],
      heading: 0,
      pitch: -25,
    })),
  },
}))

const datasets = tasks.map((task) => ({
  dataset_id: task.dataset_id,
  name: task.name,
  scene_id: task.plan.sceneId,
  scene_version: null,
  metadata: { captureTaskId: task.task_id, expectedFrameCount: task.total },
  status: task.status === 'completed' ? 'ready' : 'draft',
  created_at: '2026-11-06T02:00:00Z',
}))

// Fixture responses keep UI checks independent of the live capture queue.
async function mockService(
  page: Page,
  mode: () => 'online' | 'offline' | 'tasks-unavailable',
): Promise<void> {
  await page.route(/\/(?:health|api\/v1\/(?:capture-tasks|datasets)(?:\/.*)?)$/, async (route) => {
    const current = mode()
    if (current === 'offline') return route.abort('connectionrefused')
    const pathname = new URL(route.request().url()).pathname
    const headers = { 'access-control-allow-origin': '*' }
    if (current === 'tasks-unavailable' && pathname === '/api/v1/capture-tasks') {
      return route.fulfill({ status: 503, headers, json: { detail: 'temporarily unavailable' } })
    }
    const json =
      pathname === '/health'
        ? { status: 'ok', service: 'neural-render-service', renderer_backend: 'placeholder' }
        : pathname === '/api/v1/capture-tasks'
          ? tasks
          : pathname === '/api/v1/datasets'
            ? datasets
            : { frames: [] }
    return route.fulfill({ headers, json })
  })
}

test('离线时显示未同步状态，桌面底部内容仍可滚动访问', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockService(page, () => 'offline')
  await page.goto('/console')

  await expect(page).toHaveTitle('控制台 · 智能体仿真平台')
  await expect(page.getByRole('heading', { name: '控制台', exact: true })).toBeVisible()
  await expect(page.getByTestId('service-status')).toHaveText('服务未连接')
  await expect(page.getByTestId('stat-tasks').locator('strong')).toHaveText('—')
  await expect(page.getByText('暂时无法读取任务', { exact: true })).toBeVisible()
  await expect(page.getByText('状态未确认', { exact: true })).toBeAttached()
  const environment = page.getByRole('heading', { name: '当前连接', exact: true })
  await environment.scrollIntoViewIfNeeded()
  await expect(environment).toBeInViewport()
  await expect(page.getByRole('link', { name: '新建采集任务', exact: true })).toBeAttached()
  expect(errors).toEqual([])
})

test('重新连接后显示任务，后续断连会保留结果并标明更新失败', async ({ page }) => {
  let mode: 'online' | 'offline' = 'offline'
  await mockService(page, () => mode)
  await page.goto('/console')
  await expect(page.getByTestId('service-status')).toHaveText('服务未连接')

  mode = 'online'
  await page.getByRole('button', { name: '刷新控制台', exact: true }).click()
  await expect(page.getByTestId('service-status')).toHaveText('服务在线')
  await expect(page.getByTestId('stat-tasks').locator('strong')).toHaveText('3')
  await expect(page.getByTestId('stat-running').locator('strong')).toHaveText('1')
  await expect(page.getByTestId('stat-completed').locator('strong')).toHaveText('1')
  await expect(page.getByTestId('stat-datasets').locator('small')).toHaveText('1 个可重建')
  await expect(page.locator('.task-item').first()).toContainText('33% 已上传')

  mode = 'offline'
  await page.getByRole('button', { name: '刷新控制台', exact: true }).click()
  await expect(page.getByTestId('service-status')).toHaveText('服务未连接')
  await expect(page.getByText('任务更新失败，暂时保留上次结果。')).toBeVisible()
  await expect(page.getByTestId('stat-tasks').locator('strong')).toHaveText('3')
})

test('任务接口失败时保留其他区域，并能打开指定采集结果', async ({ page }) => {
  let mode: 'online' | 'tasks-unavailable' = 'tasks-unavailable'
  await mockService(page, () => mode)
  await page.goto('/console')
  await expect(page.getByTestId('service-status')).toHaveText('服务在线')
  await expect(page.getByTestId('stat-tasks').locator('strong')).toHaveText('—')
  await expect(page.getByTestId('stat-datasets').locator('strong')).toHaveText('3')
  await expect(page.getByText('暂时无法读取任务', { exact: true })).toBeVisible()

  mode = 'online'
  await page.getByRole('button', { name: '刷新控制台', exact: true }).click()
  await expect(page.locator('.task-item')).toHaveCount(3)
  await page.locator('.task-item').filter({ hasText: '相机标定验证' }).click()
  await expect(page).toHaveURL(/\/capture-tasks\?task=camera-calibration$/)
  await expect(
    page.getByTestId('capture-task-detail').getByRole('heading', { name: '相机标定验证' }),
  ).toBeVisible()
  await expect(page.locator('.task-row.selected')).toContainText('相机标定验证')
})

test('窄屏不横向溢出，数据集导航和底部内容可访问', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockService(page, () => 'online')
  await page.goto('/console')
  await expect(page.getByTestId('service-status')).toHaveText('服务在线')
  const sizing = await page.evaluate(() => {
    const main = document.querySelector('.console-main')!
    return {
      pageWidth: document.documentElement.scrollWidth,
      viewport: innerWidth,
      mainWidth: main.clientWidth,
      contentWidth: main.scrollWidth,
    }
  })
  expect(sizing.pageWidth).toBeLessThanOrEqual(sizing.viewport)
  expect(sizing.contentWidth).toBeLessThanOrEqual(sizing.mainWidth)
  await page.getByTestId('console-nav').getByRole('link', { name: '数据集', exact: true }).click()
  await expect(page.getByRole('heading', { name: '数据集', exact: true })).toBeInViewport()
  const environment = page.getByRole('heading', { name: '当前连接', exact: true })
  await environment.scrollIntoViewIfNeeded()
  await expect(environment).toBeInViewport()
})
