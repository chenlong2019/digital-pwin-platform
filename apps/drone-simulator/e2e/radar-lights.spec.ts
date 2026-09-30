import { test, expect } from '@playwright/test'

/**
 * 测距雷达 + 灯光系统的浏览器冒烟。
 *
 * 这两套东西只存在于渲染层(传感器与灯珠都挂在机体模型上),无头测试覆盖不到,
 * 只能靠真实浏览器验证:模型载得进来 → 传感器绑上玻璃节点 → 读数回到面板。
 *
 * 场景布局让这个断言是确定的:灯杆在起飞点正前方 16 m(量程 18 m),
 * 机体起飞后悬停在原点朝北,前视视场必然罩住它。
 */
test('测距雷达与灯光在真实浏览器里工作', async ({ page }) => {
  test.setTimeout(120_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')
  await expect(page.locator('canvas')).toBeVisible()

// 侧栏已改标签页分组:雷达与灯光在「感知」页里,先切过去
await page.getByTestId('tab-sense').click()
  const radarPanel = page.locator('section.panel', { has: page.getByText('测距雷达', { exact: true }) })
  await expect(radarPanel).toBeVisible()
  // 页面打开即自动上电,雷达随之上线
  await expect(radarPanel.getByText('工作中', { exact: true })).toBeVisible({ timeout: 20_000 })

  // 等模型载完(部件自检出现)与检查单通过再起飞
  await expect(page.getByText(/已识别/).first()).toBeVisible({ timeout: 60_000 })
  // 「一键起飞」在「飞行」页:切过去起飞,再切回「感知」页看雷达读数
  await page.getByTestId('tab-flight').click()
  const takeOff = page.getByRole('button', { name: '一键起飞' })
  await expect(takeOff).toBeVisible()
  await expect(takeOff).toBeEnabled({ timeout: 30_000 })
  await takeOff.click()
  await page.getByTestId('tab-sense').click()

  // 正前方的灯杆应当被前视视场量到
  await expect(radarPanel.getByText('灯杆').first()).toBeVisible({ timeout: 20_000 })

  // 射线可视化开关(默认关)
  const beams = radarPanel.getByRole('button', { name: '显示测距射线' })
  await expect(beams).toBeVisible()
  await beams.click()
  await expect(radarPanel.getByRole('button', { name: '隐藏测距射线' })).toBeVisible()

  // 瞄准模式切换
  await radarPanel.getByRole('button', { name: '镜头朝向' }).click()
  await expect(radarPanel.getByRole('button', { name: '镜头朝向' })).toHaveClass(/active/)

  // 灯光面板:灯语卡片要有内容,手动锁定后应标出「手动锁定」
  const lightsPanel = page.locator('section.panel', { has: page.getByText('灯光系统', { exact: true }) })
  await expect(lightsPanel.getByText('跟随飞行状态', { exact: true })).toBeVisible()
  await expect(lightsPanel.locator('.led')).toHaveCount(4)
  await lightsPanel.locator('select').first().selectOption({ index: 1 })
  await expect(lightsPanel.getByText('手动锁定', { exact: true })).toBeVisible()

  expect(errors).toEqual([])
})
