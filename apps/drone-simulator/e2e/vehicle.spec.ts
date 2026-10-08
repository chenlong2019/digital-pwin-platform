import { expect, test, type Page } from '@playwright/test'

/**
 * 汽车沙盒的浏览器护栏。
 *
 * 这个文件存在的意义不只是「汽车页能打开」——它是「同一套内核跑两种载体」这个主张的
 * **端到端证据**。无人机那 9 个用例全程不曾被改动一行,这里新增的每一条都只走公共面:
 *
 *   · 同一个 SimulationDomainAPI(只是装配换成 vehicle binding)
 *   · 同一个 SimulationViewport / LogPanel(同一个注入 key,零改动复用)
 *   · 同一条 Command → Authority → 仿真 → Snapshot → 界面回路
 *
 * 断言尽量钉在**领域语义**上,而不是「某个 div 有某个 class」:
 *   · 挡位不是开关,是档位 —— 给油自动挂 D 起步,行驶中挂 P 被领域层拒绝
 *   · 同一份平台级 move 载荷在汽车上就是油门与转向(无人机上则是升降与偏航)
 *   · 四门开度由领域层按机械速度演进,界面只显示结果
 */

/** 定位「标签 → 数值」的仪表格 */
function gauge(page: Page, label: string): ReturnType<Page['locator']> {
  return page
    .locator('.gauge')
    .filter({ has: page.locator('.gauge__label', { hasText: label }) })
    .locator('.gauge__value')
}

async function gaugeText(page: Page, label: string): Promise<string> {
  return (await gauge(page, label).innerText()).replace(/\s+/g, '')
}

async function speedKph(page: Page): Promise<number> {
  const match = /(-?\d+)/.exec(await gaugeText(page, '车速'))
  return match ? Number(match[1]) : 0
}

async function odometerM(page: Page): Promise<number> {
  const match = /([\d.]+)/.exec(await gaugeText(page, '里程'))
  return match ? Number(match[1]) : 0
}

/** 汽车页打开即自动上电;模型自检文案出现说明机体真的载进来了 */
async function waitForReady(page: Page): Promise<void> {
  await expect(page.locator('canvas')).toBeVisible()
  // 「全部 N 项部件已识别」——N 由 CarView 的部件表决定,这里只要求「不缺件」
  await expect(page.getByText(/全部 \d+ 项部件已识别/).first()).toBeVisible({ timeout: 60_000 })
}

test('汽车沙盒页面能打开,机体模型自检通过', async ({ page }) => {
  test.setTimeout(90_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/car')

  await expect(page.getByRole('heading', { name: '智能体沙盒仿真 · 汽车' })).toBeVisible()
  await expect(page.getByText('汽车测试沙盒', { exact: true }).first()).toBeVisible()
  await waitForReady(page)

  // 六个仪表格:挡位 / 车速 / 电量 / 前轮 / 里程 / 灯光
  await expect(page.locator('.gauge')).toHaveCount(6)
  // 出厂停在 P 挡
  await expect(gauge(page, '挡位')).toHaveText('P')

  expect(errors).toEqual([])
})

test('挡位与灯光是档位,不是开关', async ({ page }) => {
  test.setTimeout(90_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/car')
  await waitForReady(page)

  // 挡位:点哪个就是哪个,且四个挡位 chip 里只有一个激活
  // (灯光 chip 也共用 .chip--active,所以要按 data-testid 前缀收窄)
  for (const gear of ['D', 'N', 'R', 'P'] as const) {
    await page.getByTestId(`gear-${gear}`).click()
    await expect(gauge(page, '挡位')).toHaveText(gear)
    await expect(page.getByTestId(`gear-${gear}`)).toHaveClass(/chip--active/)
  }
  await expect(page.locator('[data-testid^="gear-"].chip--active')).toHaveCount(1)

  // 灯光:灯语是档位,选一个就顶掉上一个
  await page.getByTestId('light-low').click()
  await expect(gauge(page, '灯光')).toHaveText('近光灯')
  await page.getByTestId('light-hazard').click()
  await expect(gauge(page, '灯光')).toHaveText('双闪')
  await expect(page.getByTestId('light-low')).not.toHaveClass(/chip--active/)
  await page.getByTestId('light-off').click()
  await expect(gauge(page, '灯光')).toHaveText('关闭')

  // 指令日志认得汽车指令 —— 不能显示生僻的 vehicle.setLights
  await expect(page.getByText('灯光', { exact: true }).first()).toBeVisible()

  expect(errors).toEqual([])
})

test('四门开合与后视镜折叠会联动车身状态', async ({ page }) => {
  test.setTimeout(90_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/car')
  await waitForReady(page)

  // 出厂四门全关、后视镜展开
  for (const door of ['FL', 'FR', 'RL', 'RR']) {
    await expect(page.getByTestId(`door-${door}`)).not.toHaveClass(/chip--active/)
  }
  await expect(page.getByTestId('mirror-toggle')).toHaveText('后视镜折叠')
  await expect(page.getByText('车门未关', { exact: true })).toHaveCount(0)

  // 开单扇门:状态栏立刻标出「车门未关」
  await page.getByTestId('door-FL').click()
  await expect(page.getByTestId('door-FL')).toHaveClass(/chip--active/)
  await expect(page.getByText('车门未关', { exact: true }).first()).toBeVisible()

  // 全部打开 → 四扇一起亮
  await page.getByRole('button', { name: '全部打开' }).click()
  for (const door of ['FL', 'FR', 'RL', 'RR']) {
    await expect(page.getByTestId(`door-${door}`)).toHaveClass(/chip--active/)
  }

  // 全部关闭 → 标签收回去
  await page.getByRole('button', { name: '全部关闭' }).click()
  await expect(page.getByText('车门未关', { exact: true })).toHaveCount(0)

  // 后视镜折叠是可逆的
  await page.getByTestId('mirror-toggle').click()
  await expect(page.getByTestId('mirror-toggle')).toHaveText('后视镜展开')
  await page.getByTestId('mirror-toggle').click()
  await expect(page.getByTestId('mirror-toggle')).toHaveText('后视镜折叠')

  expect(errors).toEqual([])
})

test('WASD 驾驶:平台级 move 载荷驱动汽车起步、转向与制动', async ({ page }) => {
  test.setTimeout(90_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/car')
  await waitForReady(page)

  // ① 出厂停在 P 挡,直接按 W —— 车会「给油自动挂入 D 挡」起步。
  //    这条断言是「同一份 move 载荷喂给不同载具」的实证:
  //    载荷里只有 forward/right,WASD 在无人机那里是升降偏航,在这里被领域层解释成
  //    起步与转向 —— 输入层与内核都不知道谁在用。
  await expect(gauge(page, '挡位')).toHaveText('P')
  await page.keyboard.down('KeyW')
  await expect(gauge(page, '挡位')).toHaveText('D')
  await expect.poll(() => speedKph(page), { timeout: 15_000 }).toBeGreaterThan(10)
  await expect.poll(() => odometerM(page), { timeout: 15_000 }).toBeGreaterThan(2)

  // ② 行驶中挂 P 会被拒绝(真车规则:未停稳不许挂 P)
  //    等一下,让「万一真被挂上了」也有机会反映到 HUD(采样 10 Hz)
  await page.getByTestId('gear-P').click()
  await page.waitForTimeout(400)
  await expect(gauge(page, '挡位')).toHaveText('D')

  // ③ 转向:按住 A 前轮向左打死,松开回正
  await page.keyboard.up('KeyW')
  await page.keyboard.down('KeyA')
  await expect
    .poll(async () => Number((await gaugeText(page, '前轮')).replace(/[^\d-]/g, '')))
    .toBeLessThan(-10)
  await page.keyboard.up('KeyA')
  await expect
    .poll(async () => Number((await gaugeText(page, '前轮')).replace(/[^\d-]/g, '')))
    .toBe(0)

  // ④ 制动按钮把车停下来
  await page.getByRole('button', { name: '制动' }).click()
  await expect.poll(() => speedKph(page), { timeout: 15_000 }).toBe(0)
  // 停稳之后才能挂 P
  await page.getByTestId('gear-P').click()
  await expect(gauge(page, '挡位')).toHaveText('P')

  expect(errors).toEqual([])
})

test('无人机与汽车两个场景可以互相跳转', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '智能体沙盒仿真' })).toBeVisible()

  await page.getByRole('link', { name: '汽车沙盒' }).click()
  await expect(page).toHaveURL(/\/car$/)
  await expect(page.getByRole('heading', { name: '智能体沙盒仿真 · 汽车' })).toBeVisible()
  await expect(page.locator('canvas')).toBeVisible()

  await page.getByRole('link', { name: '无人机沙盒' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: '智能体沙盒仿真', exact: true })).toBeVisible()
})
