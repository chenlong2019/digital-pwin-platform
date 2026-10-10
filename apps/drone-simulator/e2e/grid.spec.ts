import { expect, test, type Page } from '@playwright/test'

/**
 * 电网巡检的浏览器护栏。
 *
 * 这条链路是本仓库里最长的一条:资产台账 → 航线规划 → 逐塔转场/对准/采集 →
 * 缺陷判定 → 报告导出。它同时也证明了一件架构上的事 —— **行业能力可以整体插进来**:
 * 内核、视口、日志面板一行都没改,只是换了一份 `grid-inspection` 包并多了一条路由。
 *
 * 断言钉在**可推导的量**与**领域语义**上,不钉像素:
 *   · 拍点与部位数是按拍摄配方推导出来的(24 / 66),不是界面写死的;
 *   · 改镜头倍率会让「采集净时长」变、但不会让航线几何变 —— 倍率是作业方案,不是飞法;
 *   · 任务一启动,方案就锁定(改了会让界面与任务手里的航线对不上);
 *   · 报告在巡检途中就能看,状态标「巡检中(进度截面)」而不是假装已完成;
 *   · 检查点按作业口径单独成表:被禁用的那条不飞、但如实显示「跳过」,不悄悄少一行;
 *   · 导出真的落盘,扩展名与内容都对得上。
 */

/** 打开巡检页并等待三维视口起来 */
async function openGrid(page: Page): Promise<void> {
  await page.goto('/grid')
  await expect(page.getByRole('heading', { name: '无人机电网巡检' })).toBeVisible()
  await expect(page.locator('canvas')).toBeVisible({ timeout: 60_000 })
}

/** 切到侧栏某个标签页 */
async function openTab(page: Page, tab: string): Promise<void> {
  await page.getByTestId(`tab-${tab}`).click()
}

test('巡检页能打开:线路台账与航线规模都是推导出来的', async ({ page }) => {
  test.setTimeout(120_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await openGrid(page)

  // 会话标签带着线路名,种子来自场景
  await expect(page.getByText('220 kV 西岭线 · 1–6 号塔 巡检').first()).toBeVisible()

  // 线路台账:六基塔、220 kV
  await expect(page.getByText('220 kV 西岭线 · 1–6 号塔').first()).toBeVisible()
  await expect(page.locator('.tower')).toHaveCount(6)

  // 航线规模:24 个拍点 / 66 个部位 —— 按「方位 + 距离」分组推出来的
  await expect(page.getByTestId('plan-scale')).toHaveText('24 / 66')

  // 拍点清单可以展开,里面每一拍都写清了拍什么、从哪个方位拍
  await page.getByText('航线拍点(24 个)').click()
  await expect(page.locator('.shot')).toHaveCount(24)
  await expect(page.getByText(/线路右侧 18 m/).first()).toBeVisible()

  // 还没创建任务:报告页给的是「怎么让它长出来」的说明,而不是一张空表
  await openTab(page, 'report')
  await expect(page.getByTestId('report-status')).toHaveText('未生成')
  await expect(page.getByText(/还没有报告/)).toBeVisible()

  // 场景里多了导线这个纯视觉元素(普通沙盒没有,所以按钮只在巡检页出现)
  await openTab(page, 'scene')
  await expect(page.getByTestId('toggle-wires')).toBeVisible()
  await expect(page.getByText('20 条(纯视觉,不参与避障)')).toBeVisible()

  expect(errors).toEqual([])
})

test('作业方案:倍率与采集时长进方案,但不改航线几何', async ({ page }) => {
  test.setTimeout(120_000)

  await openGrid(page)

  const scale = page.getByTestId('plan-scale')
  const capture = page.getByTestId('plan-capture')
  await expect(scale).toHaveText('24 / 66')
  const initialCapture = await capture.innerText()

  // 默认 2× / 2.4 s ⇒ 24 × 2.4 = 57.6 s
  expect(initialCapture).toBe('00:57')

  // 倍率不参与几何:拍点数一个都不变
  await page.getByTestId('lens-zoom').fill('3.5')
  await expect(scale).toHaveText('24 / 66')

  // 采集时长 5.4 s(滑杆步长 0.2,取值会被浏览器吸附到格格上)⇒ 24 × 5.4 = 129.6 s
  await page.getByTestId('dwell-seconds').fill('5.4')
  await expect(capture).toHaveText('02:09')

  // 改回默认值 —— 它必须落在滑杆自己的格子上,否则一碰就跳
  await page.getByTestId('dwell-seconds').fill('2.4')
  await expect(capture).toHaveText(initialCapture)
})

test('启动巡检:方案锁定、逐塔推进、报告途中就能看、导出真的落盘', async ({ page }) => {
  test.setTimeout(180_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await openGrid(page)

  // 时间倍率调到 4×:巡检在 1× 下要飞 370 秒仿真时间,浏览器里等不起。
  // 这不是「为了让测试过而调参」—— 固定步长下仿真时间与真实时间本就解耦,时间倍率是它的正常用法。
  await openTab(page, 'scene')
  await page.getByRole('button', { name: '4×' }).click()
  await openTab(page, 'inspection')

  const createButton = page.getByTestId('create-inspection')
  await expect(createButton).toBeEnabled()
  await createButton.click()

  // 任务一起,方案就锁定 —— 否则界面上的航线与任务手里的那份会对不上
  await expect(createButton).toBeDisabled()
  await expect(page.getByTestId('lens-zoom')).toBeDisabled()

  // 状态从「待启动」走到「巡检中」(面板用 v-show 保状态,所以定位要落在自己那一格里)
  const inspectionStatus = page.getByTestId('pane-inspection').locator('.panel__head .tag')
  const reportStatus = page.getByTestId('pane-report').locator('.panel__head .tag')
  await expect(inspectionStatus).toHaveText('巡检中', { timeout: 30_000 })
  await expect(reportStatus).toHaveText('巡检中(进度截面)')

  // 头部的覆盖率标签由**报告记录**驱动 —— 它涨起来说明采集真的落了记录
  await expect
    .poll(async () => page.getByText(/已检 \d+\/66 部位/).innerText({ timeout: 2_000 }), {
      timeout: 120_000,
      intervals: [1_000],
    })
    .toMatch(/已检 [1-9]\d*\/66 部位/)

  // 报告在途中就能看:状态标明这是进度截面,不是完成的报告
  await openTab(page, 'report')
  await expect(page.getByTestId('report-status')).toHaveText('巡检中(进度截面)')
  await expect(page.getByText('汇总').first()).toBeVisible()
  // 真值对账那块必须明确标注 —— 现场拿不到真值,不能让人以为现场也能这么统计
  await expect(page.getByText('仅用于对账').first()).toBeVisible()

  // 导出真的落盘:文件名带线路名与时间戳,内容不是空的
  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-json').click(),
  ])
  expect(jsonDownload.suggestedFilename()).toMatch(/^巡检报告_220_kV_西岭线_1_6_号塔_\d{8}_\d{6}\.json$/)
  const stream = await jsonDownload.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    status: string
    summary: { partsTotal: number }
  }
  expect(parsed.summary.partsTotal).toBe(66)
  expect(parsed.status).toBe('inProgress')

  // Markdown 那份是给人贴工单的
  const [mdDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-markdown').click(),
  ])
  expect(mdDownload.suggestedFilename()).toMatch(/\.md$/)

  // 中止:任务停下,云台从目标上松开,方案解锁
  await openTab(page, 'inspection')
  await page.getByTestId('abort-inspection').click()
  await expect(inspectionStatus).toHaveText('已中止', { timeout: 30_000 })
  await expect(page.getByTestId('lens-zoom')).toBeEnabled()

  // 中止之后机体还在空中,所以「创建并启动」仍是灰的 —— 但安全出口必须给得出去,
  // 否则这一页(没有手动摇杆)就再也落不了地了。
  await expect(page.getByTestId('inspection-rth')).toBeEnabled()
  await expect(page.getByTestId('inspection-land')).toBeEnabled()
  await expect(createButton).toBeDisabled()

  expect(errors).toEqual([])
})

test('检查点:预检查放行合格方案,被禁用的点不飞但在报告里如实显示「跳过」', async ({ page }) => {
  test.setTimeout(300_000)

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await openGrid(page)
  await openTab(page, 'inspection')

  // 默认方案一路通过预检查 —— 而且要说清「查过哪些东西」,不能只给一句绿色
  await expect(page.getByTestId('precheck-state')).toHaveText('校验通过')
  await expect(page.getByTestId('precheck-clear')).toContainText('起降点')
  await expect(page.getByTestId('create-inspection')).toBeEnabled()

  // 禁用一条检查点:预检查转成「提示」而不是「错误」—— 飞得通,只是覆盖率上限掉了
  await page.getByText('航线拍点(24 个)').click()
  await page.getByTestId('shot-toggle-T01/S1').uncheck()
  await expect(page.getByTestId('precheck-state')).toHaveText('通过 · 1 项提示')
  await expect(page.getByTestId('precheck-points-disabled')).toBeVisible()
  await expect(page.getByTestId('create-inspection')).toBeEnabled()

  // 禁用的是「飞不飞」,不是「算不算」:航线规模一个数都没变,部位仍计入分母
  await expect(page.getByTestId('plan-scale')).toHaveText('24 / 66')
  await expect(page.locator('.shot--off')).toHaveCount(1)

  // 4× 跑完整场(1× 要 370 秒仿真时间,浏览器里等不起)
  await openTab(page, 'scene')
  await page.getByRole('button', { name: '4×' }).click()
  await openTab(page, 'inspection')
  await page.getByTestId('create-inspection').click()
  // 任务一起方案就冻住 —— 否则界面上的航线与任务手里那份会对不上
  await expect(page.getByTestId('shot-toggle-T01/S1')).toBeDisabled()

  await openTab(page, 'report')
  await expect(page.getByTestId('report-status')).toHaveText('已完成', { timeout: 240_000 })

  // 24 个检查点一条不少:没有失败,恰好一条跳过,四类相加等于拍点数
  const raw = await page.getByTestId('point-counts').innerText()
  const counts = raw.split('/').map((part) => Number(part.trim()))
  expect(counts).toHaveLength(4)
  expect(counts[2], '不该有检查点判失败').toBe(0)
  expect(counts[3], '被禁用的那一条应当判「跳过」').toBe(1)
  expect(counts.reduce((sum, value) => sum + value, 0)).toBe(24)

  // 被禁用的那一条要看得见原因,不是悄悄少一行
  await expect(page.getByTestId('point-status-T01/S1')).toHaveText('跳过')
  await expect(page.getByTestId('point-T01/S1')).toContainText('检查点已禁用')

  // 检查点清单能单独导出(现场拿去排复拍用)
  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-points-csv').click(),
  ])
  expect(csv.suggestedFilename()).toMatch(/\.csv$/)

  expect(errors).toEqual([])
})

test('入口互通:沙盒页能进巡检页,巡检页能回沙盒页', async ({ page }) => {
  test.setTimeout(120_000)

  await page.goto('/')
  await expect(page.getByRole('heading', { name: '智能体沙盒仿真', exact: true })).toBeVisible()

  await page.getByRole('link', { name: '电网巡检' }).click()
  await expect(page).toHaveURL(/\/grid$/)
  await expect(page.getByRole('heading', { name: '无人机电网巡检' })).toBeVisible()

  await page.getByRole('link', { name: '无人机沙盒' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: '智能体沙盒仿真', exact: true })).toBeVisible()
})
