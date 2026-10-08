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
      path: '/car',
      name: 'vehicle',
      // 汽车场景与无人机场景共用同一套内核,但机体 / 领域装配 / HUD 完全不同,
      // 所以按需加载 —— 无人机首屏不必为汽车的模型与面板买单
      component: () => import('../views/VehicleView.vue'),
      meta: { title: '汽车沙盒' },
    },
    {
      path: '/grid',
      name: 'grid',
      // 电网巡检页:自带行业包(资产/航线/任务/检测/报告),沙盒首屏不该为它买单
      component: () => import('../views/GridView.vue'),
      meta: { title: '电网巡检' },
    },
    {
      path: '/replay',
      name: 'replay',
      // 回放页不跑仿真,只消费记录数据;按需加载,沙盒首屏不该为它买单
      component: () => import('../views/ReplayView.vue'),
      meta: { title: '飞行回放' },
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
