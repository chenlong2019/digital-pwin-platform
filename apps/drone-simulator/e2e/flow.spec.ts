import { expect, test, type Page } from '@playwright/test'

/**
 * 模块流程图页面的护栏。
 *
 * 断的是「图真的画出来了」而不是「文件存在」:
 *   · vue-flow 的节点是真的渲染成 DOM 的,所以能数、能读文字
 *   · 边是 SVG path,能数条数 —— 数据写错导致某条边被跳过时,这条会红
 *   · 每张图都点一遍,确认切换不炸(切图是整块重挂载,最容易漏测试)
 */

/** 等 vue-flow 把节点渲染出来 */
async function waitForGraph(page: Page): Promise<void> {
  await expect(page.locator('.vue-flow__node').first()).toBeVisible({ timeout: 15_000 })
}

test('流程图页能打开并渲染出节点与连线', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/flow')
  await waitForGraph(page)

  // 默认是「分层依赖」,里面必然有六层的名字
  await expect(page.getByText('Domain API', { exact: true })).toBeVisible()
  await expect(page.getByText('Contracts 契约', { exact: true })).toBeVisible()

  const nodes = await page.locator('.vue-flow__node').count()
  const edges = await page.locator('.vue-flow__edge').count()
  expect(nodes).toBeGreaterThanOrEqual(10)
  expect(edges).toBeGreaterThanOrEqual(10)

  expect(errors).toEqual([])
})

test('五张图都能切换,且每张都画出了节点', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/flow')
  await waitForGraph(page)

  const tabs = ['layering', 'packages', 'tick', 'command', 'data']
  for (const id of tabs) {
    await page.getByTestId(`flow-tab-${id}`).click()
    await waitForGraph(page)
    const nodes = await page.locator('.vue-flow__node').count()
    expect(nodes, `图 ${id} 没渲染出节点`).toBeGreaterThanOrEqual(8)
    const edges = await page.locator('.vue-flow__edge').count()
    expect(edges, `图 ${id} 没渲染出连线`).toBeGreaterThanOrEqual(7)
  }

  expect(errors).toEqual([])
})

test('包依赖图列出的是真实存在的包', async ({ page }) => {
  await page.goto('/flow')
  await page.getByTestId('flow-tab-packages').click()
  await waitForGraph(page)

  for (const name of ['domain-api', 'drone-agent', 'simulation-core', 'three-adapter', 'recorder']) {
    await expect(page.locator('.vue-flow__node').getByText(name, { exact: true })).toBeVisible()
  }
})

test('沙盒页与流程图页可以互相跳转', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('link', { name: '模块流程' }).click()
  await expect(page).toHaveURL(/\/flow$/)
  await waitForGraph(page)

  await page.getByRole('link', { name: '返回沙盒' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: '智能体沙盒仿真' })).toBeVisible()
})
