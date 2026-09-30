import { test, expect } from '@playwright/test'

// 冒烟:页面能起来,三维视口挂在 DOM 上,控制台没有未捕获错误。
test('沙盒页面能加载并渲染视口', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')

  await expect(page.getByRole('heading', { name: '智能体沙盒仿真' })).toBeVisible()
  // three 的 canvas 由渲染适配器插入
  await expect(page.locator('canvas')).toBeVisible()
  // 模型载入完成后会显示部件识别结果
  await expect(page.getByText(/已识别/).first()).toBeVisible({ timeout: 30_000 })

  expect(errors).toEqual([])
})
