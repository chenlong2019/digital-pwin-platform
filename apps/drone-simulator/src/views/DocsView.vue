<script setup lang="ts">
/**
 * DocsView —— 项目文档页。
 *
 * 两种内容共用一套骨架(目录 + 正文 + 搜索):
 *  - 使用手册:面向操作者,讲界面上有什么、点了会怎样;
 *  - 平台规范:仓库根 README 全文,92 章。
 *
 * 目录不是另手写一份清单,而是**从正文标题解析出来的** —— 单独维护一份目录,
 * 迟早出现「目录里有、正文里没有」这种最难发现的不一致。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { GUIDE } from '../docs/guide'
import { SPEC_CHAPTERS, SPEC_PARTS, SPEC_PRELUDE } from '../docs/spec'

type DocMode = 'guide' | 'spec'

interface NavItem {
  readonly id: string
  readonly label: string
}

interface NavGroup {
  readonly title: string
  readonly note: string
  readonly items: readonly NavItem[]
}

const mode = ref<DocMode>('guide')
const query = ref('')
const articleRef = ref<HTMLElement | null>(null)
const activeId = ref('')

const navGroups = computed<readonly NavGroup[]>(() => {
  if (mode.value === 'guide') {
    return [
      {
        title: '使用手册',
        note: '界面怎么用',
        items: GUIDE.headings
          .filter((heading) => heading.level === 1)
          .map((heading) => ({ id: heading.id, label: heading.text })),
      },
    ]
  }

  return SPEC_PARTS.map((part) => ({
    title: part.title,
    note: part.note,
    items: part.chapters.map((chapter) => ({ id: chapter.id, label: chapter.title })),
  }))
})

const filteredGroups = computed<readonly NavGroup[]>(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return navGroups.value
  return navGroups.value
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.label.toLowerCase().includes(keyword)),
    }))
    .filter((group) => group.items.length > 0)
})

const articleHtml = computed(() =>
  mode.value === 'guide'
    ? GUIDE.html
    : [SPEC_PRELUDE.html, ...SPEC_CHAPTERS.map((chapter) => chapter.html)].join('\n'),
)

/** 正文里的章节标题。只认 h1 —— 章节内的小节太多,拿它们做高亮会一直在抖 */
function chapterHeadings(): HTMLElement[] {
  const root = articleRef.value
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('h1[id]'))
}

/** 当前滚到哪个章节:标题越过容器顶部 28px 就算「已进入」 */
function syncActive(): void {
  const root = articleRef.value
  if (!root) return
  const heads = chapterHeadings()
  if (heads.length === 0) return

  // 已经滚到底:末尾那几章短,永远够不到容器顶部,只能在这里兜住,
  // 否则点目录跳到最后几章会看到高亮停在上一章
  if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) {
    activeId.value = heads[heads.length - 1]?.id ?? ''
    return
  }

  const top = root.getBoundingClientRect().top
  let current = heads[0]?.id ?? ''
  for (const head of heads) {
    if (head.getBoundingClientRect().top - top <= 28) current = head.id
    else break
  }
  activeId.value = current
}

function jump(id: string): void {
  const root = articleRef.value
  const target = root?.querySelector<HTMLElement>(`[id="${id}"]`)
  if (!root || !target) return
  root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top - 10
  activeId.value = id
}

// 换文档等于换了一张纸:滚动位置和高亮都得归零,否则会停在上一篇的位置上
watch(mode, async () => {
  await nextTick()
  if (articleRef.value) articleRef.value.scrollTop = 0
  syncActive()
})

onMounted(async () => {
  await nextTick()
  syncActive()
})
</script>

<template>
  <div class="docs">
    <header class="docs__bar">
      <div class="docs__identity">
        <h1>项目文档</h1>
        <span class="tag" :class="mode === 'guide' ? 'tag--info' : ''">
          {{ mode === 'guide' ? '使用手册' : `${SPEC_CHAPTERS.length} 章规范` }}
        </span>
        <span class="hint">
          {{ mode === 'guide' ? '界面怎么用 · 与当前实现同步' : '仓库 README 全文 · 与代码同步解析' }}
        </span>
      </div>

      <nav class="docs__switch">
        <button
          :class="{ active: mode === 'guide' }"
          data-testid="docs-mode-guide"
          @click="mode = 'guide'"
        >
          使用手册
        </button>
        <button
          :class="{ active: mode === 'spec' }"
          data-testid="docs-mode-spec"
          @click="mode = 'spec'"
        >
          平台规范
        </button>
      </nav>

      <div class="docs__links">
        <RouterLink to="/flow">模块流程</RouterLink>
        <RouterLink to="/">返回沙盒</RouterLink>
      </div>
    </header>

    <div class="docs__body">
      <aside class="docs__nav">
        <input
          v-model="query"
          class="docs__search"
          type="search"
          placeholder="搜索章节标题…"
          data-testid="docs-search"
        />

        <div class="docs__groups" data-testid="docs-nav">
          <section v-for="group in filteredGroups" :key="group.title" class="docs__group">
            <div class="docs__group-head">
              <span class="docs__group-title">{{ group.title }}</span>
              <span class="docs__group-count mono">{{ group.items.length }}</span>
            </div>
            <p class="docs__group-note">{{ group.note }}</p>
            <button
              v-for="item in group.items"
              :key="item.id"
              class="docs__link"
              :class="{ 'docs__link--active': item.id === activeId }"
              :data-testid="`docs-link-${item.id}`"
              @click="jump(item.id)"
            >
              {{ item.label }}
            </button>
          </section>

          <p v-if="filteredGroups.length === 0" class="hint">没有匹配的章节。</p>
        </div>
      </aside>

      <article
        ref="articleRef"
        class="docs__article"
        data-testid="docs-article"
        @scroll="syncActive"
      >
        <!-- eslint-disable-next-line vue/no-v-html -- 内容来自本仓库的 markdown,渲染器已禁用原生 HTML -->
        <div class="doc-body" v-html="articleHtml" />
      </article>
    </div>
  </div>
</template>

<style scoped>
.docs {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 8px;
  height: 100%;
  padding: 8px;
}

.docs__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 12px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.docs__identity {
  display: flex;
  flex: 1;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.docs__identity h1 {
  font-size: 15px;
  letter-spacing: 0.02em;
}

.docs__switch {
  display: flex;
  flex: none;
  gap: 6px;
}

.docs__switch button {
  padding: 5px 12px;
  color: var(--text-dim);
}

.docs__switch button.active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--accent);
}

.docs__links {
  display: flex;
  flex: none;
  gap: 8px;
}

.docs__links a {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-dim);
  text-decoration: none;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.docs__links a:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.docs__body {
  display: grid;
  grid-template-columns: 274px minmax(0, 1fr);
  gap: 8px;
  min-height: 0;
}

.docs__nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 10px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.docs__search {
  width: 100%;
  padding: 6px 9px;
  font-family: inherit;
  font-size: 12px;
  color: var(--text);
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 7px;
}

.docs__search:focus {
  outline: none;
  border-color: var(--accent);
}

.docs__groups {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  overflow-y: auto;
}

.docs__group-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.docs__group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.docs__group-count {
  font-size: 10px;
  color: var(--text-faint);
}

.docs__group-note {
  margin: 2px 0 6px;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--text-faint);
}

.docs__link {
  display: block;
  width: 100%;
  padding: 4px 8px;
  font-size: 11.5px;
  text-align: left;
  color: var(--text-dim);
  background: transparent;
  border-color: transparent;
}

.docs__link:hover:not(:disabled) {
  color: var(--text);
  background: var(--panel-raised);
  border-color: transparent;
}

.docs__link--active {
  color: var(--accent);
  background: var(--accent-soft);
}

.docs__article {
  min-width: 0;
  min-height: 0;
  padding: 16px 22px 40px;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.doc-body {
  max-width: 920px;
  font-size: 12.5px;
  line-height: 1.72;
  color: var(--text-dim);
}

.doc-body :deep(h1) {
  margin: 0 0 14px;
  padding-bottom: 8px;
  font-size: 19px;
  color: var(--text);
  border-bottom: 1px solid var(--border-soft);
}

.doc-body :deep(h1:not(:first-child)) {
  margin-top: 34px;
}

.doc-body :deep(h2) {
  margin: 22px 0 10px;
  font-size: 14.5px;
  color: var(--accent);
}

.doc-body :deep(h3) {
  margin: 18px 0 8px;
  font-size: 13px;
  color: var(--info);
}

.doc-body :deep(h4) {
  margin: 14px 0 6px;
  font-size: 12.5px;
  color: var(--text);
}

.doc-body :deep(p) {
  margin: 0 0 10px;
}

.doc-body :deep(ul),
.doc-body :deep(ol) {
  margin: 0 0 10px;
  padding-left: 20px;
}

.doc-body :deep(li) {
  margin: 3px 0;
}

.doc-body :deep(a) {
  color: var(--info);
}

.doc-body :deep(strong) {
  color: var(--text);
}

.doc-body :deep(code) {
  padding: 1px 5px;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--accent);
  background: var(--panel-raised);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
}

.doc-body :deep(pre) {
  margin: 0 0 12px;
  padding: 10px 12px;
  overflow-x: auto;
  background: var(--panel-soft);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
}

.doc-body :deep(pre code) {
  padding: 0;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--text-dim);
  background: none;
  border: none;
}

.doc-body :deep(blockquote) {
  margin: 0 0 12px;
  padding: 6px 12px;
  color: var(--text-dim);
  border-left: 2px solid var(--border-strong);
}

.doc-body :deep(hr) {
  margin: 20px 0;
  border: none;
  border-top: 1px solid var(--border-soft);
}

/* 表格外面那层容器是 markdown.ts 加的:宽表在窄屏里横向滚动,而不是把页面撑破 */
.doc-body :deep(.doc-table) {
  margin: 0 0 14px;
  overflow-x: auto;
}

.doc-body :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
}

.doc-body :deep(th),
.doc-body :deep(td) {
  padding: 5px 10px;
  text-align: left;
  vertical-align: top;
  border: 1px solid var(--border-soft);
}

.doc-body :deep(th) {
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  background: var(--panel-raised);
}

@media (max-width: 1100px) {
  .docs__body {
    grid-template-columns: 220px minmax(0, 1fr);
  }

  .docs__identity .hint {
    display: none;
  }
}
</style>
