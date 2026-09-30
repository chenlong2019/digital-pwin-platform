import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

const appDir = fileURLToPath(new URL('.', import.meta.url))
// monorepo 根目录 —— 应用直接消费 packages 里各包的 src 源码,需要放开 fs 限制
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

/**
 * 应用层直接消费 `packages` 下各包的 TypeScript 源码(与 create-vue 的
 * `main: ./src/main.ts` 一脉相承):不引入额外的构建步骤,改包源码即时热更。
 * 别名写死在这里而不是依赖 npm link 的软链,保证与 node_modules 的实际状态无关。
 */
const packages = [
  'contracts',
  'simulation-core',
  'agent-core',
  'sandbox-core',
  'drone-agent',
  'task-core',
  'recorder',
  'domain-api',
  'three-adapter',
] as const

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), vueDevTools()],
  resolve: {
    alias: [
      ...packages.map((name) => ({
        find: `@simulation/${name}`,
        replacement: fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url)),
      })),
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
    // three 在多处被引用(应用 / three-adapter),去重避免打包出两份
    dedupe: ['three'],
  },
  server: {
    fs: { allow: [repoRoot, appDir] },
  },
  optimizeDeps: {
    // workspace 包是源码直连,交给 Vite 编译,不要预打包
    exclude: packages.map((name) => `@simulation/${name}`),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
