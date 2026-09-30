import { test, expect } from '@playwright/test'

/**
 * 交互冒烟:证明「界面按钮 → Command → Authority → 仿真 → Snapshot → 界面」这条回路是通的。
 *
 * 完整的航点任务在 `src/__tests__/sandbox-headless.spec.ts` 里以 60 Hz 无头方式跑完
 * (36 秒航程足够用毫秒级跑完),这里只做一件事:确认按钮真的能推动飞机。
 */
test('一键起飞:按钮驱动仿真并回灌遥测', async ({ page }) => {
  test.setTimeout(90_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')

  // 出厂在地面:自检(2.6 s)+ 预热(2.4 s)+ 搜星后才允许起飞
  // 注意:页面打开时会自动上电,所以这里等的是「地面待机」而不是「未上电」
  const takeOff = page.getByRole('button', { name: '一键起飞' })
  await expect(takeOff).toBeVisible()
  await expect(takeOff).toBeEnabled({ timeout: 30_000 })
  // 「地面待机」在遥测面板与检查单里各出现一次,取第一个即可
  await expect(page.getByText('地面待机', { exact: true }).first()).toBeVisible({ timeout: 30_000 })

  await takeOff.click()

  // 遥测面板的「空中」标签只在机体离地后出现 —— 说明快照回到了界面
  // 「空中」标签在遥测面板头部,该面板在「遥测」标签页里(默认隐藏)
  await page.getByTestId('tab-telemetry').click()
  await expect(page.getByText('空中', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('飞行中', { exact: true }).first()).toBeVisible({ timeout: 30_000 })

  // 指令日志应当记下这次起飞
  await page.getByRole('button', { name: /^指令/ }).click()
  await expect(page.getByText('起飞', { exact: true }).first()).toBeVisible()

  expect(errors).toEqual([])
})
