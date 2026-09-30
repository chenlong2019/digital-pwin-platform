/**
 * 使用手册 —— 面向使用者,讲的是「这个沙盒怎么操作」。
 *
 * 正文在 guide.md。它和平台规范(README)是两种东西:规范解释平台为什么这么设计,
 * 手册只讲界面上有什么、点了会怎样。所以刻意不复用 README 的内容。
 */
import guideSource from './guide.md?raw'
import { renderMarkdown } from './markdown'

export const GUIDE = renderMarkdown(guideSource)
