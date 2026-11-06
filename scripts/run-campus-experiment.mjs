#!/usr/bin/env node
/** Exercise the real UI -> capture API -> GPU worker -> held-out evaluation path. */
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('..', import.meta.url))
const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')),
)
const ui = options.ui ?? 'http://127.0.0.1:45679'
const api = options.api ?? 'http://127.0.0.1:8090'
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || process.platform === 'win32'
    ? { channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL ?? 'msedge' }
    : {}),
})
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
let jobId = ''
try {
  if (options.dataset) {
    const response = await fetch(`${api}/api/v1/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dataset_id: options.dataset,
        steps: Number(options.steps ?? 400),
        gaussians: 8000,
      }),
    })
    const result = await response.json()
    assert.equal(response.ok, true, JSON.stringify(result))
    await page.addInitScript(
      (saved) => localStorage.setItem('campus.experiment.active', JSON.stringify(saved)),
      { datasetId: options.dataset, jobId: result.job_id },
    )
  }
  await page.goto(
    `${ui}/experiments${options.job ? `?job=${encodeURIComponent(options.job)}` : ''}`,
    { waitUntil: 'domcontentloaded' },
  )
  const button = page.getByTestId('experiment-start')
  await button.waitFor({ state: 'visible', timeout: 30_000 })
  if (!options.dataset && !options.job) {
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="experiment-start"]')?.disabled,
      null,
      { timeout: 60_000 },
    )
    if (options.steps) await page.getByTestId('experiment-steps').selectOption(options.steps)
    await button.click()
  }
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="experiment-status"]')?.getAttribute('data-job-id') ||
      document.querySelector('[role="alert"]')?.textContent,
    null,
    { timeout: 120_000 },
  )
  jobId = await page.getByTestId('experiment-status').getAttribute('data-job-id')
  assert.ok(
    jobId,
    (await page.locator('[role="alert"]').allTextContents()).join('\n') ||
      'No experiment was submitted',
  )
  console.log(`Training ${jobId}`)
  let last = ''
  const deadline = Date.now() + 20 * 60_000
  while (Date.now() < deadline) {
    const response = await fetch(`${api}/api/v1/jobs/${jobId}`, {
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(response.ok, true, `Job request failed (${response.status})`)
    const job = await response.json()
    const state = `${job.status} ${job.result?.stage ?? ''} ${job.result?.step ?? 0}/${job.result?.steps ?? ''}`
    if (state !== last) {
      console.log(state)
      last = state
    }
    if (job.status === 'failed') throw new Error(job.error ?? 'Training failed')
    if (job.status === 'completed') {
      const base = `${api}/api/v1/experiments/${jobId}/artifacts/`
      const report = await (await fetch(`${base}report.json`)).json()
      assert.equal(
        report.train_frames.some((id) => report.test_frames.includes(id)),
        false,
      )
      assert.equal(report.test_frames.length, 8)
      for (const value of [report.quality.psnr, report.quality.ssim, report.performance.fps])
        assert.ok(Number.isFinite(value))
      assert.ok(report.training_history.length > 1)
      assert.deepEqual(errors, [])
      await page.getByTestId('experiment-report').waitFor({ state: 'visible', timeout: 10_000 })
      // Existing reports can arrive before the point-cloud worker has decoded
      // the preview. Wait for both scene readiness and test images before export.
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="experiment-start"]')?.disabled,
        null,
        { timeout: 60_000 },
      )
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.comparison-grid img')].every(
            (img) => img.complete && img.naturalWidth > 0,
          ),
        null,
        { timeout: 10_000 },
      )
      await page.mouse.move(0, 0)
      const destination = path.join(
        root,
        'services/neural-render-service/data/experiment-deliverables',
        jobId,
      )
      await mkdir(destination, { recursive: true })
      await page.screenshot({ path: path.join(destination, 'console.png'), fullPage: true })
      await page.getByRole('button', { name: '查看结果 ↓' }).click()
      await page.screenshot({ path: path.join(destination, 'results.png') })
      for (const name of ['report.json', 'comparison.png', 'model.ply']) {
        const artifact = await fetch(base + name)
        assert.equal(artifact.ok, true)
        await writeFile(path.join(destination, name), Buffer.from(await artifact.arrayBuffer()))
      }
      console.log(
        JSON.stringify(
          {
            jobId,
            output: destination,
            quality: report.quality,
            initial: report.initial_quality,
            performance: report.performance,
          },
          null,
          2,
        ),
      )
      break
    }
    await delay(2000)
  }
  assert.ok(
    await page.getByTestId('experiment-report').count(),
    'Experiment did not finish before timeout',
  )
} catch (error) {
  console.error(`Experiment ${jobId || '(capture)'}: ${error.message}`)
  console.error((await page.locator('[role="alert"]').allTextContents()).join('\n'))
  throw error
} finally {
  await browser.close()
}
