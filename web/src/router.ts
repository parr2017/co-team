/**
 * B3（2026-09-17）：web 路由化——hash 模式零服务端配置，四页 URL 直达、刷新不丢、
 * 前进后退可用；/approvals 为审批收件箱（B5，真组件走 router-view）。
 * 既有四页的布局仍由 App.vue 按路由名渲染（页面间共享状态重，本轮不做组件拆分），
 * 路由是页面切换的唯一事实源。
 */
import { createRouter, createWebHashHistory } from 'vue-router';

// 既有四页布局由 App.vue 按路由名渲染（不用 router-view），这里用空组件满足路由类型；
// router-view 仅在 /approvals 分支渲染真实组件
const PassThrough = { render: () => null };

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/workbench' },
    { path: '/workbench', name: 'workbench', component: PassThrough },
    { path: '/tasks', name: 'tasks', component: PassThrough },
    { path: '/project', name: 'project', component: PassThrough },
    { path: '/discuss', name: 'discuss', component: PassThrough },
    { path: '/convo', name: 'convo', component: PassThrough },
    { path: '/settings', name: 'settings', component: PassThrough },
    { path: '/approvals', name: 'approvals', component: () => import('./views/ApprovalInboxView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/workbench' },
  ],
});

export default router;
