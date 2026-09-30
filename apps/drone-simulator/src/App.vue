<script setup lang="ts">
/**
 * App —— 只负责挂路由。
 * 沙盒页面的所有装配都在 views/SandboxView.vue 里,应用外壳保持干净,
 * 以后加「回放 / 数据看板 / 多人协同」页时不需要动这里。
 */
import { RouterView } from 'vue-router'
</script>

<template>
  <RouterView />
</template>
