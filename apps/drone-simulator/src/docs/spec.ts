/**
 * 平台规范文档(仓库根的 README)。
 *
 * README 有 3500 行、92 个编号章节,整篇塞进页面没法用,所以按 `# N. 标题`
 * 切成章节,再按语义卷分组给目录。
 *
 * 切的是**源 markdown**而不是渲染后的 HTML:先整篇渲染再按 DOM 切,一是
 * 「目录锚点」和「正文标题」会有机会对不上,二是代码块里的 `# 3. 装依赖`
 * 这类注释会被当成章节切走(README 里有 200 多个代码块)。
 */
import readmeSource from '../../../../README.md?raw'
import { renderMarkdown, type DocHeading } from './markdown'

export interface SpecChapter {
  readonly number: number
  /** 目录与标题栏显示用,形如 `42. Package 静态依赖规则` */
  readonly title: string
  readonly id: string
  /** 渲染好的正文,章节标题本身也在里面 */
  readonly html: string
  /** 章节内部的小节(README 的 ## / ###),正文里自带,这里留给搜索用 */
  readonly sections: readonly DocHeading[]
}

export interface SpecPart {
  readonly title: string
  readonly note: string
  readonly chapters: readonly SpecChapter[]
}

/**
 * 目录分组。区间必须恰好覆盖全部章节 —— 有测试盯着,README 加了新章节
 * 而这里忘了改,侧栏就会静默漏掉它。
 */
const PARTS: ReadonlyArray<{ title: string; note: string; from: number; to: number }> = [
  { title: '平台定义', note: '平台是什么、为谁做、怎么演进', from: 1, to: 9 },
  { title: '核心概念', note: 'World / Agent / Task / Runtime / Snapshot 等基础词汇', from: 10, to: 29 },
  { title: '包与模块', note: '六层分层与各层包含的包', from: 30, to: 38 },
  { title: '接口与流程', note: '逐个接口的契约、运行时流程与依赖方向', from: 39, to: 70 },
  { title: '规则与验收', note: '架构静态检查、非功能指标、测试策略', from: 71, to: 86 },
  { title: '总纲与结论', note: '模块边界总表、核心原则与四条主线', from: 87, to: 92 },
]

const CHAPTER_HEADING = /^#\s+(\d+)\.\s*(.*)$/
const FENCE = /^\s*(?:```|~~~)/

interface RawChapter {
  readonly number: number
  readonly title: string
  readonly lines: string[]
}

function splitChapters(source: string): { prelude: string; chapters: RawChapter[] } {
  const prelude: string[] = []
  const chapters: RawChapter[] = []
  let current: RawChapter | null = null
  let inFence = false

  for (const line of source.split(/\r?\n/)) {
    // 围栏内的行一律不算章节:README 的代码块里有 `# 1. ...` 这样的注释
    if (FENCE.test(line)) inFence = !inFence

    const match = inFence ? null : CHAPTER_HEADING.exec(line)
    if (match) {
      const number = Number(match[1] ?? 0)
      current = { number, title: `${number}. ${match[2] ?? ''}`.trim(), lines: [line] }
      chapters.push(current)
      continue
    }

    if (current) current.lines.push(line)
    else prelude.push(line)
  }

  return { prelude: prelude.join('\n'), chapters }
}

const parsed = splitChapters(readmeSource)

export const SPEC_CHAPTERS: readonly SpecChapter[] = parsed.chapters.map((raw) => {
  const rendered = renderMarkdown(raw.lines.join('\n').trim())
  const head = rendered.headings[0]
  return {
    number: raw.number,
    title: raw.title,
    id: head?.id ?? `chapter-${raw.number}`,
    html: rendered.html,
    sections: rendered.headings.slice(1),
  }
})

export const SPEC_PARTS: readonly SpecPart[] = PARTS.map((part) => ({
  title: part.title,
  note: part.note,
  chapters: SPEC_CHAPTERS.filter((chapter) => chapter.number >= part.from && chapter.number <= part.to),
})).filter((part) => part.chapters.length > 0)

/** README 文件头(平台名 + 一句定位),单独当「概述」放在正文最前面 */
export const SPEC_PRELUDE = renderMarkdown(parsed.prelude.trim())
