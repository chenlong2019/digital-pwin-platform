import { expect, test } from '@playwright/test'

test.describe('项目文档页', () => {
  test('默认落在使用手册,目录能跳到章节', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))

    await page.goto('/docs')
    await expect(page.getByTestId('docs-article')).toContainText('一键起飞')

    // 点手册里的某一章,正文应当真的滚过去
    const article = page.getByTestId('docs-article')
    await page.getByTestId('docs-link-9-常见问题').click()
    await expect.poll(() => article.evaluate((el) => el.scrollTop)).toBeGreaterThan(200)
    await expect(page.getByTestId('docs-link-9-常见问题')).toHaveClass(/docs__link--active/)

    expect(errors).toEqual([])
  })

  test('平台规范渲染 README 全文,目录按分区铺开', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))

    await page.goto('/docs')
    await page.getByTestId('docs-mode-spec').click()

    const article = page.getByTestId('docs-article')
    await expect(article).toContainText('通用智能体仿真与数字孪生平台')
    await expect(article).toContainText('最终模块边界总表')
    await expect(article).toContainText('92. 结论')

    // README 的 92 章要一章不落地进目录 —— 漏一章是这一页最难发现的 bug;
    // 另外文件头的「快速开始」「实现状态」各占一个入口,所以是 94 条链接 / 8 组
    await expect(page.getByTestId('docs-nav').locator('.docs__link')).toHaveCount(94)
    await expect(page.getByTestId('docs-nav').locator('.docs__group')).toHaveCount(8)
    await expect(page.getByTestId('docs-link-快速开始')).toBeVisible()
    await expect(page.getByTestId('docs-link-实现状态')).toBeVisible()

    expect(errors).toEqual([])
  })

  test('搜索按标题过滤目录', async ({ page }) => {
    await page.goto('/docs')
    await page.getByTestId('docs-mode-spec').click()

    const links = page.getByTestId('docs-nav').locator('.docs__link')
    await page.getByTestId('docs-search').fill('内存稳定性')

    await expect(links).toHaveCount(1)
    await expect(page.getByTestId('docs-link-81-内存稳定性')).toBeVisible()

    await page.getByTestId('docs-search').fill('')
    await expect(links).toHaveCount(94)
  })

  test('跳到 README 末章:目录高亮跟着走', async ({ page }) => {
    await page.goto('/docs')
    await page.getByTestId('docs-mode-spec').click()

    const article = page.getByTestId('docs-article')
    await page.getByTestId('docs-link-92-结论').click()

    await expect.poll(() => article.evaluate((el) => el.scrollTop)).toBeGreaterThan(1000)
    await expect(page.getByTestId('docs-link-92-结论')).toHaveClass(/docs__link--active/)
  })

  test('沙盒页头部能进文档页,也能从文档页回沙盒', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: '项目文档' }).click()
    await expect(page).toHaveURL(/\/docs$/)

    await page.getByRole('link', { name: '返回沙盒' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('.viewport__canvas')).toBeVisible()
  })
})
