#!/usr/bin/env node
/** Check the deployed result -> real PLY -> interactive THREE.js viewer. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')),
)
const ui = options.ui ?? 'http://127.0.0.1:45679'
const jobId = options.job ?? 'job-75fc935ba176'
const destination = path.resolve(
  options.output ??
    `services/neural-render-service/data/experiment-deliverables/${jobId}/three-viewer`,
)
await mkdir(destination, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
const externalRequests = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('request', (request) => {
  const url = new URL(request.url())
  if (url.protocol.startsWith('http') && !['127.0.0.1', 'localhost'].includes(url.hostname))
    externalRequests.push(url.href)
})
try {
  await page.goto(`${ui}/experiments?job=${encodeURIComponent(jobId)}`)
  const entry = page.getByRole('link', { name: '查看三维模型 ↗' }).first()
  await entry.click()
  const viewer = page.getByTestId('gaussian-viewer')
  await page.waitForFunction(
    () =>
      ['ready', 'error'].includes(
        document.querySelector('[data-testid="gaussian-viewer"]')?.getAttribute('data-state'),
      ),
    null,
    { timeout: 60000 },
  )
  assert.equal(
    await viewer.getAttribute('data-state'),
    'ready',
    (await page.getByRole('alert').allTextContents()).join('\n'),
  )
  await page.waitForFunction(
    () =>
      /浏览器 [1-9]\d* FPS/.test(
        document.querySelector('[data-testid="gaussian-fps"]')?.textContent ?? '',
      ),
    null,
    { timeout: 10000 },
  )
  const canvas = page.getByLabel('交互式三维高斯模型')
  await page.screenshot({ path: path.join(destination, 'overview.png') })
  const initial = await canvas.screenshot()
  const box = await canvas.boundingBox()
  assert.ok(box)
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.67, box.y + box.height * 0.57, { steps: 15 })
  await page.mouse.up()
  assert.equal(
    initial.equals(await canvas.screenshot()),
    false,
    'Dragging must change the real canvas',
  )
  const rotated = await canvas.screenshot()
  await page.mouse.wheel(0, -350)
  assert.equal(
    rotated.equals(await canvas.screenshot()),
    false,
    'Zooming must change the real canvas',
  )
  await page.getByRole('button', { name: '俯视', exact: true }).click()
  await page.screenshot({ path: path.join(destination, 'top.png') })
  await page.getByRole('button', { name: '自动环绕', exact: true }).click()
  assert.equal(
    await page.getByRole('button', { name: '停止环绕' }).getAttribute('aria-pressed'),
    'true',
  )
  await page.getByRole('button', { name: '重置视角', exact: true }).click()
  assert.equal(
    await page.getByRole('button', { name: '自动环绕' }).getAttribute('aria-pressed'),
    'false',
  )
  await page.getByLabel('三维模型视角').selectOption({ label: '测试视角 1' })
  await page.screenshot({ path: path.join(destination, 'test-view.png') })
  const tests = (await page.getByLabel('三维模型视角').locator('option').count()) - 2
  await page.getByLabel('三维模型视角').selectOption({ label: `测试视角 ${tests}` })
  await page.reload()
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="gaussian-viewer"]')?.getAttribute('data-state') ===
      'ready',
    null,
    { timeout: 60000 },
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(destination, 'mobile.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.getByRole('link', { name: '← 实验结果', exact: true }).click()
  await page.getByTestId('experiment-report').waitFor()
  assert.equal(await page.getByLabel('交互式三维高斯模型').count(), 0)
  assert.deepEqual(errors, [])
  assert.deepEqual(externalRequests, [])
  const result = {
    jobId,
    ui,
    tests,
    checked: [
      'result_page_entry',
      'real_ply_rendering',
      'drag_rotation',
      'wheel_zoom',
      'top',
      'auto_orbit',
      'reset',
      'test_cameras',
      'reload',
      'mobile',
      'unmount',
      'no_external_cdn',
    ],
    errors,
  }
  await writeFile(path.join(destination, 'verification.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ...result, output: destination }, null, 2))
} finally {
  await browser.close()
}
