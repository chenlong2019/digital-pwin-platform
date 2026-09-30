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
import { SPEC_CHAPTERS, SPEC_PARTS } from '../docs/spec'

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
