import { createRouter, createWebHistory } from 'vue-router'

import SandboxView from '../views/SandboxView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'sandbox',
      component: SandboxView,
      meta: { title: '无人机沙盒' },
    },
    {
      path: '/flow',
      name: 'flow',
      // 架构图是文档页,跟仿真无关,所以按需加载 —— 沙盒首屏不该为它买单
      component: () => import('../views/FlowView.vue'),
      meta: { title: '模块流程' },
    },
    {
      path: '/docs',
      name: 'docs',
      // 同上,而且它还要解析整份 README,更不该进首屏
      component: () => import('../views/DocsView.vue'),
      meta: { title: '项目文档' },
    },
  ],
})

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '沙盒'
  document.title = `${title} · 智能体仿真平台`
})

export default router
