/** Real HTTP + platform UI + Chromium capture, across service and worker restarts. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from '@playwright/test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DRONE = path.resolve(process.env.DRONE_CAMERA_ROOT ?? path.join(ROOT, '../drone-camera'))
const SERVICE = path.join(ROOT, 'services/neural-render-service')
const python = process.env.CAPTURE_PYTHON ?? path.join(SERVICE, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const output = path.join(SERVICE, 'data', `capture-integration-${Date.now()}`)
const workerRoot = path.join(output, 'worker')
mkdirSync(output, { recursive: true })
const processes = new Set()
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function port() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const value = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return value
}
function start(executable, args, cwd, env, name) {
  const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  child.output = ''
  child.stdout.on('data', (data) => { child.output += data; appendFileSync(path.join(output, `${name}.log`), data) })
  child.stderr.on('data', (data) => appendFileSync(path.join(output, `${name}.log`), data))
  child.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  child.done.catch(() => {})
  processes.add(child)
  return child
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    await new Promise((resolve) => { killer.once('error', resolve); killer.once('exit', resolve) })
  } else { try { process.kill(-child.pid, 'SIGTERM') } catch { /* already exited */ } }
  await child.done.catch(() => {})
}
async function ready(url, child) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode}): ${url}; see ${output}`)
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return } catch { /* starting */ }
    await delay(200)
  }
  throw new Error(`Server did not start: ${url}; see ${output}`)
}
function chromePath() {
  if (process.env.DRONE_MCP_CHROME) return process.env.DRONE_MCP_CHROME
  const cache = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : path.join(homedir(), '.cache/ms-playwright')
  if (!existsSync(cache)) return undefined
  for (const folder of readdirSync(cache).filter((item) => /^chromium-\d+$/.test(item)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    for (const relative of ['chrome-win64/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const candidate = path.join(cache, folder, relative)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

let browser
try {
  assert.ok(existsSync(python), 'Install the Python service virtual environment or set CAPTURE_PYTHON')
  assert.ok(existsSync(path.join(DRONE, 'agent/platform-worker.mjs')), 'Set DRONE_CAMERA_ROOT to the updated drone-camera checkout')
  const apiPort = await port(), uiPort = await port()
  const apiUrl = `http://127.0.0.1:${apiPort}`, uiUrl = `http://127.0.0.1:${uiPort}`
  const serviceEnv = { STORAGE_ROOT: path.join(output, 'storage'), DATABASE_URL: '' }
  const startService = () => start(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(apiPort)], SERVICE, serviceEnv, 'service')
  let service = startService()
  const ui = start(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(ROOT, 'apps/drone-simulator'), { VITE_NEURAL_RENDER_URL: apiUrl }, 'platform')
  await Promise.all([ready(`${apiUrl}/health`, service), ready(uiUrl, ui)])
  browser = await chromium.launch({ executablePath: chromePath() })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1300 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`${uiUrl}/capture-tasks`)
  await page.getByText('采集服务已连接', { exact: true }).waitFor()
  await page.getByLabel('任务名称', { exact: true }).fill('平台与采集 Agent 联调')
  const created = page.waitForResponse((response) => response.url() === `${apiUrl}/api/v1/capture-tasks` && response.request().method() === 'POST')
  await page.getByRole('button', { name: '下发采集任务', exact: true }).click()
  const response = await created
  assert.equal(response.status(), 201)
  const task = await response.json()
  console.log(`Created ${task.task_id} through the platform UI`)
  async function runWorker(...extra) {
    const child = start(process.execPath, ['agent/platform-worker.mjs', '--url', apiUrl, '--root', workerRoot, '--worker-id', 'integration-worker', '--once', ...extra], DRONE, {}, 'worker')
    const timeout = setTimeout(() => { void stop(child) }, 300000)
    let code
    try { code = await child.done } finally { clearTimeout(timeout) }
    assert.equal(code, 0, `Worker failed; see ${path.join(output, 'worker.log')}`)
    return JSON.parse(child.output.trim().split('\n').at(-1))
  }
  const partial = await runWorker('--max-shots', '1')
  assert.equal(partial.status, 'paused')
  assert.equal(partial.uploaded, 1)
  const taskDirectory = path.join(workerRoot, task.task_id)
  const firstImage = path.join(taskDirectory, 'images/view-01.png')
  const originalHash = hash(readFileSync(firstImage))
  console.log('First image committed and registered; restarting the API service and worker process')
  await stop(service)
  service = startService()
  await ready(`${apiUrl}/health`, service)
  const persisted = await (await fetch(`${apiUrl}/api/v1/capture-tasks/${task.task_id}`)).json()
  assert.equal(persisted.status, 'paused')
  assert.equal(persisted.uploaded, 1)
  // This run's own test artifact only: exercise repair from the server's committed bytes.
  assert.ok(!path.relative(output, firstImage).startsWith('..'))
  unlinkSync(firstImage)
  await page.reload()
  await page.getByRole('button', { name: '继续任务', exact: true }).click()
  const completed = await runWorker()
  assert.equal(completed.status, 'completed')
  assert.equal(completed.uploaded, 3)
  assert.equal(hash(readFileSync(firstImage)), originalHash)
  const checkpoint = JSON.parse(readFileSync(path.join(taskDirectory, 'checkpoint.json')))
  assert.equal(checkpoint.attempts['view-01'], 1, 'first shot must be restored, never recaptured')
  const datasetRoute = `${apiUrl}/api/v1/datasets/${task.dataset_id}`
  const dataset = await (await fetch(datasetRoute)).json()
  assert.equal(dataset.status, 'ready')
  const manifest = await (await fetch(datasetRoute + '/manifest')).json()
  const validation = await (await fetch(datasetRoute + '/validate', { method: 'POST' })).json()
  assert.equal(validation.valid, true, JSON.stringify(validation))
  assert.equal(validation.frame_count, 3)
  assert.equal(manifest.frames.length, 3)
  for (const frame of manifest.frames) {
    const receipt = frame.metadata.sourceReceipt
    const expectedPosition = { x: receipt.image.position[0], y: receipt.image.position[2], z: -receipt.image.position[1] }
    for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(frame.cameraPose.positionM[axis] - expectedPosition[axis]) < 1e-9)
    assert.equal(frame.simulationTime, receipt.observation.elapsed)
    const image = Buffer.from(await (await fetch(datasetRoute + `/images/${frame.frameId}`)).arrayBuffer())
    assert.equal(hash(image), receipt.image.contentHash)
    assert.equal(hash(readFileSync(path.join(taskDirectory, receipt.image.file))), receipt.image.contentHash)
  }
  assert.notEqual(manifest.frames[0].metadata.simulationSessionId, manifest.frames[1].metadata.simulationSessionId)
  await page.getByText('采集完成', { exact: true }).last().waitFor({ timeout: 15000 })
  await page.waitForFunction(() => document.querySelectorAll('.image-grid img').length === 3 && [...document.querySelectorAll('.image-grid img')].every((image) => image.complete && image.naturalWidth === 960))
  assert.deepEqual(pageErrors, [])
  const screenshot = path.join(output, 'platform-capture.png')
  await page.screenshot({ path: screenshot, fullPage: true })
  writeFileSync(path.join(output, 'platform-manifest.json'), JSON.stringify(manifest, null, 2))
  const report = { ok: true, taskId: task.task_id, datasetId: task.dataset_id, serverRestarted: true, workerProcessRestarted: true,
    firstShotAttempts: checkpoint.attempts['view-01'], firstImageRestoredFromServer: true, firstImageHashUnchanged: true,
    uploaded: completed.uploaded, datasetStatus: dataset.status, validation, workerRoot, screenshot,
    bundle: path.join(taskDirectory, 'capture-colmap.zip') }
  writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, report: path.join(output, 'verification.json') }))
} finally {
  await browser?.close()
  await Promise.allSettled([...processes].map(stop))
}
