/**
 * 流程图与代码对账。
 *
 * 这些图是会过期的资料:加一个包、改一条依赖,图不会自己更新。
 * 所以这里拿三样东西互相钉住:
 *   1. 图里的包清单 === 架构守卫认定的「已实现包」(目录真的存在)
 *   2. 图里的每一条边,A 都必须允许依赖 B(读的是守卫那份 allow 白名单)
 *   3. 每条边的两个端点都在本图的节点表里
 *
 * 守卫脚本是 .mjs 且带副作用(会 process.exit),所以这里只做文本抽取,不 import 它。
 * 抽不出来会直接失败 —— 沉默地跳过等于没有这道防线。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FLOW_GRAPHS, PACKAGES_GRAPH_NODES } from '../flow/graphs'

/**
 * 找仓库根。
 *
 * 不能用 import.meta.url —— 测试跑在 jsdom 里,那个 URL 是 http 协议,不是文件路径。
 * 所以从工作目录往上找守卫脚本这个标志物,不管从哪一层调起都对。
 */
function findRepoRoot(): string {
  let current = process.cwd()
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'scripts', 'check-architecture.mjs'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  // 实在找不到就按「apps/drone-simulator」这个已知深度退一步
  return resolve(process.cwd(), '..', '..')
}

const ROOT = findRepoRoot()

interface ManifestEntry {
  readonly name: string
  readonly layer: string
  readonly allow: ReadonlyArray<string>
  readonly dir: string
}

function readManifest(): ManifestEntry[] {
  const scriptPath = join(ROOT, 'scripts', 'check-architecture.mjs')
  expect(existsSync(scriptPath), `找不到架构守卫脚本:${scriptPath}`).toBe(true)

  const source = readFileSync(scriptPath, 'utf8')
  const pattern =
    /^\s{2}'?([a-z][a-z0-9-]*)'?:\s*\{\s*layer:\s*'([A-Za-z]+)',\s*allow:\s*\[([^\]]*)\],\s*dir:\s*'([^']+)'/gm

  const entries: ManifestEntry[] = []
  for (const match of source.matchAll(pattern)) {
    const [, name, layer, allowRaw, dir] = match
    if (!name || !layer || allowRaw === undefined || !dir) continue
    const allow = [...allowRaw.matchAll(/'([^']+)'/g)].map((item) => item[1]!)
    entries.push({ name, layer, allow, dir })
  }
  return entries
}

const manifest = readManifest()
const byName = new Map(manifest.map((entry) => [entry.name, entry]))
const implemented = manifest.filter((entry) => existsSync(join(ROOT, entry.dir)))

describe('流程图数据', () => {
  it('能解析出架构守卫的包清单', () => {
    // 抽到空数组说明正则和守卫脚本的写法对不上了,必须马上知道
    expect(manifest.length).toBeGreaterThanOrEqual(20)
    expect(implemented.length).toBeGreaterThanOrEqual(10)
  })

  it('包依赖图的节点恰好是「已实现」的那些包', () => {
    const expected = implemented.map((entry) => entry.name).sort()
    expect([...PACKAGES_GRAPH_NODES].sort()).toEqual(expected)
  })

  it('图里的每个包都对应真实存在的目录', () => {
    for (const name of PACKAGES_GRAPH_NODES) {
      const entry = byName.get(name)
      expect(entry, `图里的 ${name} 没有登记在架构守卫里`).toBeDefined()
      expect(existsSync(join(ROOT, entry!.dir)), `${entry!.dir} 不存在`).toBe(true)
    }
  })

  it('包依赖图的每条边都在 allow 白名单里', () => {
    const packages = FLOW_GRAPHS.find((graph) => graph.id === 'packages')
    expect(packages).toBeDefined()

    // 图里用短 id 当连线端点,label 才是包名 —— 先建一层映射
    const packageOf = new Map(packages!.nodes.map((node) => [node.id, node.label]))

    for (const edge of packages!.edges) {
      const fromName = packageOf.get(edge.from)
      const toName = packageOf.get(edge.to)
      expect(fromName, `边的起点 ${edge.from} 不在本图节点表里`).toBeDefined()
      expect(toName, `边的终点 ${edge.to} 不在本图节点表里`).toBeDefined()

      const from = byName.get(fromName!)
      expect(from, `${fromName} 没有登记在架构守卫里`).toBeDefined()
      const allowed = from!.allow.includes('*') || from!.allow.includes(toName!)
      expect(
        allowed,
        `${fromName}(${from!.layer}) 不允许依赖 ${toName};允许:${from!.allow.join('、') || '无'}`,
      ).toBe(true)
    }
  })

  it('每张图的边端点都存在,且节点 id 不重复', () => {
    for (const graph of FLOW_GRAPHS) {
      const ids = graph.nodes.map((node) => node.id)
      expect(new Set(ids).size, `${graph.title} 有重复的节点 id`).toBe(ids.length)

      const known = new Set(ids)
      for (const edge of graph.edges) {
        expect(known.has(edge.from), `${graph.title}:边起点 ${edge.from} 不存在`).toBe(true)
        expect(known.has(edge.to), `${graph.title}:边终点 ${edge.to} 不存在`).toBe(true)
      }
    }
  })
})
