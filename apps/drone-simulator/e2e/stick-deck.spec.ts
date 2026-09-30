import { test, expect } from '@playwright/test'

/**
 * 视口下方的虚拟摇杆台。
 *
 * 锁住真机语义:**左盘横向 = 偏航(绕垂直轴的水平旋转)**,不是平移。
 * 键盘 A/D 与左盘横向是同一个通道 —— 这条就是用户报的「AD 应该是控制水平旋转」的回归护栏。
 *
 * 判据用遥测里的「机头朝向」:拖满左盘一秒多,机头必须真的转过去,
 * 而高度不该被带偏(没碰升降通道)。
 */
test('拖左摇杆盘向右:飞机原地水平旋转,高度不变', async ({ page }) => {
  test.setTimeout(120_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')
  await expect(page.locator('canvas')).toBeVisible()

  const takeOff = page.getByRole('button', { name: '一键起飞' })
  await expect(takeOff).toBeEnabled({ timeout: 60_000 })
  await takeOff.click()

  await page.getByTestId('tab-telemetry').click()
  // 等起飞**结束**(升到 1.2 米悬停),否则会拿到刚离地那一刻的高度当基准
  await expect(page.getByText('飞行中', { exact: true }).first()).toBeVisible({ timeout: 30_000 })

  const heading = page.locator('.details__row', { hasText: '机头朝向' }).locator('dd')
  const altitude = page.locator('.highlight', { hasText: '相对高度' }).locator('.highlight__value')

  const headingBefore = (await heading.textContent()) ?? ''
  const altitudeBefore = Number.parseFloat((await altitude.textContent()) ?? '0')

  // 摇杆台是常驻的,不用切标签页
  const pad = page.getByTestId('stick-pad-left')
  await expect(pad).toBeVisible()
  const box = await pad.boundingBox()
  expect(box, '左摇杆盘应当有布局尺寸').toBeTruthy()
  const centerX = box!.x + box!.width / 2
  const centerY = box!.y + box!.height / 2

  await page.mouse.move(centerX, centerY)
  await page.mouse.down()
  await page.mouse.move(centerX + box!.width * 0.45, centerY, { steps: 4 })
  await page.waitForTimeout(1200)
  await page.mouse.up()

  await expect
    .poll(() => heading.textContent(), { timeout: 20_000, message: '拖左盘向右应当让机头转起来' })
    .not.toBe(headingBefore)

  // 只动了偏航通道:高度不该被带偏
  const altitudeAfter = Number.parseFloat((await altitude.textContent()) ?? '0')
  expect(Math.abs(altitudeAfter - altitudeBefore), `高度从 ${altitudeBefore} 变成了 ${altitudeAfter}`).toBeLessThan(0.5)

  // 松手自回中:杆位读数归零
  const leftValue = page.locator('.stick-dial__value').first()
  await expect(leftValue).toHaveText('0.00 / 0.00')

  // 键盘 A/D 走的是同一通道
  const headingAfterDrag = (await heading.textContent()) ?? ''
  await page.keyboard.down('KeyD')
  await page.waitForTimeout(900)
  await page.keyboard.up('KeyD')
  await expect
    .poll(() => heading.textContent(), { timeout: 20_000, message: '按 D 也应当让机头转起来' })
    .not.toBe(headingAfterDrag)

  expect(errors).toEqual([])
})
