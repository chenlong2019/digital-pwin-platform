#!/usr/bin/env node
/**
 * 架构静态检查 —— 落地 README §42 / §43 / §74 的强制约束。
 *
 * 检查项:
 *   1. 依赖方向:包只能依赖自己 allow 列表里的内部包(低层不得依赖高层)
 *   2. 循环依赖:A → B → A 直接失败
 *   3. Internal 泄漏:禁止跨包引用 `@simulation/x/src/internal/...`(只能用包根)
 *   4. Renderer 隔离:Core / Domain / Capability / API 不得依赖 three
 *   5. UI 隔离:Core / Domain / Capability / API / Adapter / MCP 不得依赖 vue / pinia
 *
 * 零外部依赖:自己遍历源码抽 import,避免为了一件小事引入 dependency-cruiser。
 * 用法:node scripts/check-architecture.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 每个包的层级与允许依赖的内部包(严格白名单,不靠"层级数字"推断) */
const MANIFEST = {
  contracts: { layer: 'Core', allow: [], dir: 'packages/contracts' },
  'simulation-core': { layer: 'Core', allow: ['contracts'], dir: 'packages/simulation-core' },
  'agent-core': { layer: 'Core', allow: ['contracts', 'simulation-core'], dir: 'packages/agent-core' },
  'sandbox-core': { layer: 'Core', allow: ['contracts', 'simulation-core'], dir: 'packages/sandbox-core' },

  'task-core': { layer: 'Capability', allow: ['contracts', 'simulation-core'], dir: 'packages/task-core' },
  recorder: { layer: 'Capability', allow: ['contracts'], dir: 'packages/recorder' },
  result: { layer: 'Capability', allow: ['contracts', 'recorder'], dir: 'packages/result' },
  replay: { layer: 'Capability', allow: ['contracts', 'recorder', 'simulation-core'], dir: 'packages/replay' },
  collaboration: { layer: 'Capability', allow: ['contracts'], dir: 'packages/collaboration' },
  realtime: { layer: 'Capability', allow: ['contracts'], dir: 'packages/realtime' },
  input: { layer: 'Capability', allow: ['contracts', 'domain-api'], dir: 'packages/input' },

  'drone-agent': {
    layer: 'Domain',
    allow: ['contracts', 'simulation-core', 'agent-core', 'sandbox-core'],
    dir: 'packages/drone-agent',
  },
  'vehicle-agent': {
    layer: 'Domain',
    allow: ['contracts', 'simulation-core', 'agent-core', 'sandbox-core'],
    dir: 'packages/vehicle-agent',
  },
  'boat-agent': {
    layer: 'Domain',
    allow: ['contracts', 'simulation-core', 'agent-core', 'sandbox-core'],
    dir: 'packages/boat-agent',
  },
  'robot-agent': {
    layer: 'Domain',
    allow: ['contracts', 'simulation-core', 'agent-core', 'sandbox-core'],
    dir: 'packages/robot-agent',
  },

  'domain-api': {
    layer: 'API',
    allow: ['contracts', 'simulation-core', 'agent-core', 'sandbox-core', 'task-core', 'recorder', 'drone-agent'],
    dir: 'packages/domain-api',
  },

  'three-adapter': { layer: 'Adapter', allow: ['contracts'], dir: 'packages/three-adapter' },
  'cesium-adapter': { layer: 'Adapter', allow: ['contracts'], dir: 'packages/cesium-adapter' },
  'device-adapters': { layer: 'Adapter', allow: ['contracts', 'domain-api'], dir: 'packages/device-adapters' },

  'mcp-server': { layer: 'Integration', allow: ['contracts', 'domain-api'], dir: 'mcp/mcp-server' },

  'drone-simulator': { layer: 'Application', allow: ['*'], dir: 'apps/drone-simulator' },
  // README §29 声明了「每个领域各配一个产品应用」,这两个是已规划未实现 ——
  // 登记在这里,等目录一出现守卫就会自动开始检查它们的依赖方向
  'vehicle-simulator': { layer: 'Application', allow: ['*'], dir: 'apps/vehicle-simulator' },
  'robot-simulator': { layer: 'Application', allow: ['*'], dir: 'apps/robot-simulator' },

  // 服务侧宿主(README §29 的推荐仓库结构 · §59~§61)。它们也是「宿主」,
  // 不是被依赖的能力包,所以放在 Application 层、目录不在 packages/ 下
  'simulation-server': { layer: 'Application', allow: ['*'], dir: 'services/simulation-server' },
  'realtime-server': { layer: 'Application', allow: ['*'], dir: 'services/realtime-server' },
  'persistence-server': { layer: 'Application', allow: ['*'], dir: 'services/persistence-server' },
}

/** 各层禁止依赖的外部运行时库 */
const FORBIDDEN_EXTERNAL = {
  Core: ['three', 'vue', 'pinia', 'vue-router'],
  Capability: ['three', 'vue', 'pinia', 'vue-router'],
  Domain: ['three', 'vue', 'pinia', 'vue-router'],
  API: ['three', 'vue', 'pinia', 'vue-router'],
  Integration: ['three', 'vue', 'pinia', 'vue-router'],
  Adapter: ['vue', 'pinia', 'vue-router'],
  Application: [],
}

const SCOPE = '@simulation/'
const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.vue']

const errors = []
const warnings = []

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (SOURCE_EXT.some((ext) => entry.name.endsWith(ext))) out.push(full)
  }
  return out
}

/** 抽取一个源文件里的全部模块说明符(静态 import / 动态 import / re-export / require) */
function extractSpecifiers(code) {
  const found = new Set()
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) found.add(match[1])
    }
  }
  return [...found]
}

/** '@simulation/drone-agent/src/internal/x' → { pkg: 'drone-agent', deep: true } */
function parseInternalSpecifier(specifier) {
  if (!specifier.startsWith(SCOPE)) return null
  const rest = specifier.slice(SCOPE.length)
  const segments = rest.split('/')
  const name = segments[0]
  if (!name) return null
  return { pkg: name, deep: segments.length > 1, full: specifier }
}

function externalRoot(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null
  if (specifier.startsWith(SCOPE)) return null
  const segments = specifier.split('/')
  if (specifier.startsWith('@')) return segments.slice(0, 2).join('/')
  return segments[0]
}

// ————————————————————————————— 逐包检查 —————————————————————————————

const graph = new Map()
const present = []

for (const [name, meta] of Object.entries(MANIFEST)) {
  const absDir = join(ROOT, meta.dir)
  if (!existsSync(absDir)) continue
  present.push(name)
  graph.set(name, new Set())

  const pkgJsonPath = join(absDir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    errors.push(`${meta.dir}/package.json 不存在 —— workspace 包必须有 package.json`)
    continue
  }
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  const declared = Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies })
    .filter((dep) => dep.startsWith(SCOPE))
    .map((dep) => dep.slice(SCOPE.length))

  const srcDir = join(absDir, 'src')
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    errors.push(`${meta.dir}/src 不存在`)
    continue
  }
  const files = walk(srcDir)
  const importedInternals = new Set()
  const externals = new Set()

  for (const file of files) {
    const code = readFileSync(file, 'utf8')
    for (const specifier of extractSpecifiers(code)) {
      const internal = parseInternalSpecifier(specifier)
      if (internal) {
        const where = relative(ROOT, file).split(sep).join('/')
        if (internal.deep) {
          errors.push(
            `Internal 泄漏:${where} 引用了 ${internal.full} —— 跨包只能用包根 ${SCOPE}${internal.pkg}`,
          )
        }
        importedInternals.add(internal.pkg)
        continue
      }
      const ext = externalRoot(specifier)
      if (ext) externals.add(ext)
    }
  }

  // 1. 依赖方向
  for (const dep of new Set([...declared, ...importedInternals])) {
    if (dep === name) continue
    if (!MANIFEST[dep]) {
      warnings.push(`${name} 依赖了未登记的包 ${SCOPE}${dep}(若为新增包请补进 check-architecture.mjs)`)
      continue
    }
    if (!meta.allow.includes('*') && !meta.allow.includes(dep)) {
      errors.push(
        `依赖方向违规:${name}(${meta.layer})不允许依赖 ${SCOPE}${dep}(${MANIFEST[dep].layer})` +
          `;允许:${meta.allow.length ? meta.allow.map((a) => SCOPE + a).join('、') : '无'}`,
      )
    }
    graph.get(name).add(dep)
  }

  // 2. 外部库隔离
  const forbidden = FORBIDDEN_EXTERNAL[meta.layer] ?? []
  for (const ext of externals) {
    if (forbidden.includes(ext)) {
      errors.push(`${meta.layer} 层不得依赖 ${ext}:${name} 在使用 ${ext}`)
    }
  }
}

// ————————————————————————————— 循环依赖 —————————————————————————————

const WHITE = 0
const GRAY = 1
const BLACK = 2
const color = new Map()
const stack = []

function walkGraph(node) {
  color.set(node, GRAY)
  stack.push(node)
  for (const next of graph.get(node) ?? []) {
    const state = color.get(next) ?? WHITE
    if (state === GRAY) {
      const cycle = [...stack.slice(stack.indexOf(next)), next]
      errors.push(`循环依赖:${cycle.join(' → ')}`)
    } else if (state === WHITE) {
      walkGraph(next)
    }
  }
  stack.pop()
  color.set(node, BLACK)
}

for (const node of graph.keys()) {
  if ((color.get(node) ?? WHITE) === WHITE) walkGraph(node)
}

// ————————————————————————————— 报告 —————————————————————————————

const definedButAbsent = Object.entries(MANIFEST)
  .filter(([name, meta]) => !present.includes(name) && existsSync(join(ROOT, 'packages')) && meta.dir.startsWith('packages/'))
  .map(([name]) => name)

console.log('架构静态检查 — README §42 / §43 / §74')
console.log(`已实现包(${present.length}):${present.join('、')}`)
if (definedButAbsent.length) {
  console.log(`已规划未实现(${definedButAbsent.length}):${definedButAbsent.join('、')}`)
}
console.log('')

if (warnings.length) {
  console.log(`警告 ${warnings.length} 条:`)
  for (const item of warnings) console.log(`  · ${item}`)
  console.log('')
}

if (errors.length) {
  console.log(`失败 ${errors.length} 条:`)
  for (const item of errors) console.log(`  ✗ ${item}`)
  process.exit(1)
}

console.log('通过:依赖方向、循环依赖、Internal 泄漏、Renderer/UI 隔离 均无违规。')
