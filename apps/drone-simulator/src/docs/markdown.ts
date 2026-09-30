/**
 * 文档页的 Markdown 渲染。
 *
 * 只做 markdown-it 默认不做的三件事:
 *  1. 给标题写 id —— 目录靠它定位到正文;
 *  2. 表格套一层横向滚动容器 —— README 里有十几列的表,窄屏会直接溢出;
 *  3. 外链补 target / rel。
 *
 * 安全选项保持最严:`html: false`,文档里若出现原生 HTML 会被原样转义显示。
 * 这份内容通篇来自自家仓库,但渲染器不该因为「来源可信」就放开执行权。
 */
import MarkdownIt from 'markdown-it'

export interface DocHeading {
  /** 1 = 章节,2 / 3 = 章节内小节 */
  readonly level: number
  readonly text: string
  readonly id: string
}

export interface RenderedMarkdown {
  readonly html: string
  readonly headings: readonly DocHeading[]
}

/**
 * 标题 → 锚点 id:中文原样保留,空白与点号折成连字符,其余标点丢掉。
 *
 * 例:`42. Package 静态依赖规则` → `42-package-静态依赖规则`;
 * `World / Sandbox / Scenario` → `world-sandbox-scenario`。
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s.·]+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

const md = new MarkdownIt({ html: false, linkify: false, breaks: false })

/**
 * 收集标题并写 id。
 *
 * 目录和正文必须出自同一次解析:若分两遍(一遍取目录、一遍渲正文),两遍的
 * slug 规则一旦有细微差异,就会变成「点目录跳不到」这种只能靠肉眼发现的问题。
 */
md.core.ruler.push('doc_headings', (state) => {
  const collector = state.env.headings as DocHeading[] | undefined
  const used = new Map<string, number>()

  for (let i = 0; i < state.tokens.length; i += 1) {
    const token = state.tokens[i]
    if (token?.type !== 'heading_open') continue

    const text = (state.tokens[i + 1]?.content ?? '').trim()
    const base = slugify(text) || `doc-${i}`
    const seen = used.get(base) ?? 0
    used.set(base, seen + 1)

    const id = seen === 0 ? base : `${base}-${seen + 1}`
    token.attrSet('id', id)
    collector?.push({ level: Number(token.tag.slice(1)), text, id })
  }
})

// 表格外面套一层容器:横向滚动交给容器,表格自身的布局不受影响
md.renderer.rules.table_open = () => '<div class="doc-table">\n<table>\n'
md.renderer.rules.table_close = () => '</table>\n</div>\n'

// 外链新窗口打开;站内相对链接(目前文档里没有)保持原样
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx]
  // attrGet 的值可能是 number(属性值允许数字),这里统一成字符串再判
  const href = String(token?.attrGet('href') ?? '')
  if (token && /^https?:/i.test(href)) {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noreferrer noopener')
  }
  return self.renderToken(tokens, idx, options)
}

/** 渲染一段 markdown,同时拿到它的标题清单 */
export function renderMarkdown(source: string): RenderedMarkdown {
  const headings: DocHeading[] = []
  const html = md.render(source, { headings })
  return { html, headings }
}
