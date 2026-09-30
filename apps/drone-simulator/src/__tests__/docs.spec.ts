/**
 * 文档页对账。
 *
 * 这一页最大的风险不是渲染错,而是**悄悄漏内容**:README 加了一章、侧栏分组
 * 忘了改,页面看不出任何异常,只是少了一章。所以这里把「解析结果」和
 * 「README 原文」「真实组件」互相钉住 —— 任何一边单独改动都会红。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GUIDE } from '../docs/guide'
import { slugify } from '../docs/markdown'
import { SPEC_CHAPTERS, SPEC_PARTS, SPEC_PRELUDE, SPEC_PRELUDE_SECTIONS } from '../docs/spec'

/** 从当前工作目录往上找仓库根(带 workspaces 的那层) */
function findRepoRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'README.md')) && existsSync(join(dir, 'packages'))) return dir
    dir = join(dir, '..')
  }
  throw new Error(`未能在 ${process.cwd()} 之上找到仓库根`)
}

const REPO_ROOT = findRepoRoot()
const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8')

/** 组件源码全拼起来 —— 手册里点名的按钮得能在里面找到 */
function readVueSources(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return readVueSources(full)
      return entry.name.endsWith('.vue') ? readFileSync(full, 'utf8') : ''
    })
    .join('\n')
}

describe('slugify', () => {
  it('中文与数字保留,空白与点号折成连字符', () => {
    expect(slugify('42. Package 静态依赖规则')).toBe('42-package-静态依赖规则')
  })

  it('斜杠这类标点被丢掉,而不是变成一串连字符', () => {
    expect(slugify('World / Sandbox / Scenario')).toBe('world-sandbox-scenario')
  })

  it('首尾不留连字符', () => {
    expect(slugify('① Package Dependency')).toBe('package-dependency')
  })
})

describe('README 章节解析', () => {
  it('章节号从 1 起连续,不重不漏', () => {
    const numbers = SPEC_CHAPTERS.map((chapter) => chapter.number)
    expect(numbers.length).toBeGreaterThan(50)
    expect(numbers).toEqual(numbers.map((_, index) => index + 1))
  })

  it('章节数等于 README 里 `# N.` 的行数(代码围栏内的不算)', () => {
    let inFence = false
    let count = 0
    for (const line of README.split(/\r?\n/)) {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence
        continue
      }
      if (!inFence && /^#\s+\d+\./.test(line)) count += 1
    }
    expect(count).toBeGreaterThan(50)
    expect(SPEC_CHAPTERS.length).toBe(count)
  })

  it('每章都有正文、唯一 id,且正文里带自己的标题', () => {
    const ids = new Set<string>()
    for (const chapter of SPEC_CHAPTERS) {
      const escaped = chapter.title
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')

      expect(chapter.html.length, `第 ${chapter.number} 章正文为空`).toBeGreaterThan(0)
      expect(chapter.html).toContain(`<h1 id="${chapter.id}"`)
      expect(chapter.html, `第 ${chapter.number} 章正文里没有标题`).toContain(escaped)
      expect(ids.has(chapter.id), `锚点 id 重复:${chapter.id}`).toBe(false)
      ids.add(chapter.id)
    }
  })
})

describe('目录分组', () => {
  it('分区恰好覆盖全部章节,不重不漏', () => {
    const grouped = SPEC_PARTS.flatMap((part) => part.chapters.map((chapter) => chapter.number))
    expect(grouped).toEqual(SPEC_CHAPTERS.map((chapter) => chapter.number))
  })

  it('每个分区内的章节号连续', () => {
    for (const part of SPEC_PARTS) {
      const numbers = part.chapters.map((chapter) => chapter.number)
      for (let i = 1; i < numbers.length; i += 1) {
        expect(numbers[i], `分区「${part.title}」的章节号断了`).toBe((numbers[i - 1] ?? 0) + 1)
      }
    }
  })
})

describe('README 快速开始', () => {
  it('排在编号章节之前,所以侧栏要单独给它一个入口', () => {
    const ids = SPEC_PRELUDE_SECTIONS.map((heading) => heading.id)
    expect(ids, 'README 文件头里找不到「快速开始」').toContain('快速开始')
    // 它不该占用编号,否则 92 章整体错位、代码里引用的 §74 之类全会失准
    expect(SPEC_CHAPTERS.map((chapter) => chapter.title)).not.toContain('快速开始')
  })

  it('正文里点名的 npm run 脚本,在根 package.json 里真实存在', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const scripts = Object.keys(pkg.scripts ?? {})
    const used = [...SPEC_PRELUDE.html.matchAll(/npm run ([a-z][\w:-]*)/g)].map((match) => match[1] ?? '')

    expect(used.length, '快速开始里没写任何 npm run 命令').toBeGreaterThan(3)
    for (const name of new Set(used)) {
      expect(scripts, `快速开始里的 npm run ${name} 在根 package.json 里不存在`).toContain(name)
    }
  })

  it('内容确实进了文档页正文,而不是只躺在 README 里', () => {
    expect(SPEC_PRELUDE.html).toContain('快速开始')
    expect(SPEC_PRELUDE.html).toContain('npm ci')
    expect(SPEC_PRELUDE.html).toContain('http://localhost:5173')
  })
})

describe('README 实现状态', () => {
  /**
   * 从「实现状态」小节里读模块清单。
   *
   * 约定:该小节用两张表分别列「已落地」与「未实现」,表里的模块名一律写成
   * 行内代码(`` `contracts` ``)。这个约定让 README 与架构守卫可以互相钉住 ——
   * 文档说「已落地」而目录不存在,或说「未实现」而目录已经出现,这里就会红。
   */
  function readStatusSection(): { shipped: string[]; planned: string[] } {
    const section = /^# 实现状态\s*$([\s\S]*?)^# /m.exec(README)?.[1]
    expect(section, 'README 里找不到「实现状态」小节').toBeTruthy()
    if (!section) return { shipped: [], planned: [] }

    const [head, tail = ''] = section.split('## 未实现')
    const plannedPart = tail.split('## 验收指标')[0] ?? ''
    const names = (text: string): string[] =>
      [...text.matchAll(/`([a-z][a-z0-9-]*)`/g)].map((match) => match[1] ?? '')

    return { shipped: names(head ?? ''), planned: names(plannedPart) }
  }

  /** 架构守卫登记的模块(名称 → 目录) */
  function readManifest(): Map<string, string> {
    const source = readFileSync(join(REPO_ROOT, 'scripts', 'check-architecture.mjs'), 'utf8')
    const pattern =
      /^\s{2}'?([a-z][a-z0-9-]*)'?:\s*\{\s*layer:\s*'([A-Za-z]+)',\s*allow:\s*\[([^\]]*)\],\s*dir:\s*'([^']+)'/gm
    const entries = new Map<string, string>()
    for (const match of source.matchAll(pattern)) {
      const [, name, , , dir] = match
      if (name && dir) entries.set(name, dir)
    }
    return entries
  }

  const status = readStatusSection()
  const manifest = readManifest()

  it('能解析出「已落地」与「未实现」两张清单', () => {
    expect(manifest.size, '没能从架构守卫里抽出模块清单').toBeGreaterThanOrEqual(20)
    expect(status.shipped.length).toBeGreaterThanOrEqual(10)
    expect(status.planned.length).toBeGreaterThanOrEqual(8)
  })

  it('「已落地」里的模块:守卫里有登记,而且目录真的存在', () => {
    for (const name of status.shipped) {
      const dir = manifest.get(name)
      expect(dir, `实现状态里说 ${name} 已落地,但它没登记在架构守卫里`).toBeDefined()
      expect(existsSync(join(REPO_ROOT, dir ?? '')), `实现状态里说 ${name} 已落地,但 ${dir} 不存在`).toBe(true)
    }
  })

  it('「未实现」里的模块:守卫里有登记,而且目录确实还没出现', () => {
    for (const name of status.planned) {
      const dir = manifest.get(name)
      expect(dir, `实现状态里说 ${name} 未实现,但它没登记在架构守卫里`).toBeDefined()
      expect(
        existsSync(join(REPO_ROOT, dir ?? '')),
        `实现状态里说 ${name} 未实现,但 ${dir} 已经存在了 —— 该把它挪进「已落地」`,
      ).toBe(false)
    }
  })

  it('两张表合起来恰好覆盖守卫登记的全部模块,不重不漏', () => {
    const listed = [...status.shipped, ...status.planned].sort()
    expect(new Set(listed).size, '实现状态里出现了重复模块').toBe(listed.length)
    expect(listed).toEqual([...manifest.keys()].sort())
  })
})

describe('使用手册', () => {
  it('章节各有唯一 id,而且正文确实渲染了', () => {
    const heads = GUIDE.headings.filter((heading) => heading.level === 1)
    expect(heads.length).toBeGreaterThan(5)
    expect(new Set(heads.map((heading) => heading.id)).size).toBe(heads.length)
    expect(GUIDE.html.length).toBeGreaterThan(2000)
  })

  it('手册点名的按钮在界面上真实存在', () => {
    const sources = readVueSources(join(REPO_ROOT, 'apps/drone-simulator/src/components'))
    const labels = [
      '一键起飞',
      '智能返航',
      '自动降落',
      '悬停 · 摇杆归中',
      '开机自检',
      '紧急停桨',
      '取消返航',
      '复位相机',
    ]
    for (const label of labels) {
      expect(sources, `手册提到的「${label}」在组件里找不到`).toContain(label)
    }
  })
})
