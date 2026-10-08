import { expect, test, type Page } from '@playwright/test'

/**
 * 回放与数据看板的浏览器护栏(README §22 · §58 · §77)。
 *
 * 这条链路串起的是「飞完能复盘」的完整回路:
 *   飞一段 → 保存本次飞行 → 跳回放页 → 播放 / 拖动 / 跳事件 → 导出报告
 *
 * 断言钉在**数据语义**上而不是画面像素:
 *   · 播放时时钟真的在涨、暂停时真的停住 —— 回放是被帧驱动的,不是 CSS 动画;
 *   · 统计卡片里的航程来自记录数据而不是零 —— 说明快照真的喂进了看板;
 *   · 事件条数随回放时刻变化、点击能把时间轴拽回去 —— 这是 §77「事件按时刻浮现」;
 *   · 导出触发真实下载且扩展名对得上。
 */

/** 把「mm:ss」或「hh:mm:ss」解析成秒 */
function secondsOf(clock: string): number {
  return clock
    .split(':')
    .map((part) => Number(part) || 0)
    .reduce((sum, value) => sum * 60 + value, 0)
}

/**
 * 进度条的取值必须写成 `String(Number(x))` 的规范形式。
 * playwright 对 number / range 的 fill 会比对 `String(Number(value)) === value`,
 * 所以 toFixed 出来的尾随零（"17.20"）会被判成格式非法 —— 那是测试写法问题,不是产品问题。
 * 落在哪个 step 上不用操心,浏览器自己会 snap。
 */
function rangeValue(value: number): string {
  return String(value)
}

/** 读时间轴上的「当前 / 总长」 */
async function clock(page: Page): Promise<{ current: number; total: number }> {
  const text = (await page.getByTestId('replay-clock').innerText()).replace(/\s+/g, '')
  const [current = '0', total = '0'] = text.split('/')
  return { current: secondsOf(current), total: secondsOf(total) }
}

/**
 * 完整走一遍「飞 → 存 → 回放」。
 *
 * 每个用例都得自己来一遍:playwright 给每个用例独立的浏览器上下文,
 * sessionStorage 不跨用例共享 —— 这正好也证明了回放数据是自洽的,不靠外部状态。
 */
async function flyAndOpenReplay(page: Page): Promise<void> {
  await page.goto('/')

  // 机体载入完成 —— 自检文案出现说明 GLB 真的挂进场景了。
  // 注意别写死「全部 N 项已识别」:无人机模型有一个部件本来就缺件,
  // 文案会是「49/50 项已识别,缺少:…」。这里只判「机体进了场景」,缺件与否归领域层管。
  await expect(page.locator('canvas')).toBeVisible()
  await expect(page.getByText(/项已识别/).first()).toBeVisible({ timeout: 90_000 })

  // 起飞并飞一小段,让记录里有真实的位移(而不是一堆原地采样点)
  const takeOff = page.getByRole('button', { name: '一键起飞' })
  await expect(takeOff).toBeEnabled({ timeout: 60_000 })
  await takeOff.click()
  await page.waitForTimeout(5_000)

  // 保存本次飞行(入口在遥测面板底部)
  await page.getByTestId('tab-telemetry').click()
  const save = page.getByTestId('save-replay')
  await expect(save).toBeEnabled({ timeout: 30_000 })
  await save.click()

  await expect(page).toHaveURL(/\/replay$/)
  await expect(page.getByRole('heading', { name: '飞行回放' })).toBeVisible()
  await expect(page.getByTestId('replay-clock')).toBeVisible({ timeout: 30_000 })
}

test('飞完保存,回放页能看到这次飞行的数据', async ({ page }) => {
  test.setTimeout(180_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await flyAndOpenReplay(page)

  // 记录本身有内容:总时长不为零
  const { total } = await clock(page)
  expect(total).toBeGreaterThan(0)

  // 看板:八格统计 + 两条曲线
  await expect(page.getByTestId('replay-stats').locator('.stat')).toHaveCount(8)
  await expect(page.locator('.chart__svg')).toHaveCount(2)

  // 统计来自记录数据而不是空壳:航程与采样点都不为零
  const stats = (await page.getByTestId('replay-stats').innerText()).replace(/\s+/g, '')
  expect(stats).not.toContain('航程0.0m')
  expect(stats).toContain('采样点')

  // 机体也真的载进来了(回放复用同一套渲染适配器)
  await expect(page.getByText(/项已识别/).first()).toBeVisible({ timeout: 60_000 })

  expect(errors).toEqual([])
})

test('时间轴:播放推进、暂停停住、拖动跳转、事件可点回', async ({ page }) => {
  test.setTimeout(180_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await flyAndOpenReplay(page)

  const play = page.getByTestId('replay-play')

  // ① 播放:时钟必须真的往前走
  await page.getByTestId('replay-range').fill('0')
  const before = (await clock(page)).current
  await play.click()
  await page.waitForTimeout(1_500)
  const during = (await clock(page)).current
  expect(during).toBeGreaterThan(before)

  // ② 暂停:时钟必须真的停住(回放靠 rAF 驱动,不是 CSS 动画)
  await play.click()
  const paused = (await clock(page)).current
  await page.waitForTimeout(900)
  expect((await clock(page)).current).toBe(paused)

  // ③ 拖动:拖到六成位置,时钟跟着跳
  const { total } = await clock(page)
  await page.getByTestId('replay-range').fill(rangeValue(total * 0.6))
  const dragged = (await clock(page)).current
  expect(dragged).toBeGreaterThan(total * 0.4)

  // ④ 点最早的一条事件,时间轴被拽回那一刻
  const rows = page.locator('[data-testid="replay-events"] .events__row')
  await expect(rows.first()).toBeVisible()
  const earliest = rows.last()
  const targetText = (await earliest.locator('.events__time').innerText()).replace(/\s+/g, '')
  await earliest.click()
  await expect.poll(async () => (await clock(page)).current).toBe(secondsOf(targetText))

  // ⑤ 倍速按钮真的改倍速(不崩、且当前档位高亮)
  await page.getByTestId('replay-speed-4').click()
  await expect(page.getByTestId('replay-speed-4')).toHaveClass(/active/)

  expect(errors).toEqual([])
})

test('三种格式的结果报告都能导出下载', async ({ page }) => {
  test.setTimeout(180_000)

  await flyAndOpenReplay(page)

  for (const [format, extension] of [
    ['json', 'json'],
    ['markdown', 'md'],
    ['csv', 'csv'],
  ] as const) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId(`export-${format}`).click(),
    ])
    expect(download.suggestedFilename()).toMatch(new RegExp(`^飞行报告_.+\\.${extension}$`))
  }
})
