import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory('/m/'),
  routes: [
    { path: '/', redirect: '/tasks' },
    { path: '/tasks', component: () => import('./views/TaskListView.vue'), meta: { tab: 'tasks' } },
    { path: '/agents', component: () => import('./views/AgentsView.vue'), meta: { tab: 'agents' } },
    { path: '/projects', component: () => import('./views/ProjectsView.vue'), meta: { tab: 'projects' } },
    { path: '/project/:id', component: () => import('./views/ProjectDetailView.vue'), props: true },
    { path: '/project/:id/report', component: () => import('./views/ProjectReportView.vue'), props: true },
    { path: '/task/new', component: () => import('./views/TaskCreateView.vue') },
    { path: '/task/:id', component: () => import('./views/TaskDetailView.vue'), props: true },
    { path: '/clarify/:id', component: () => import('./views/ClarifyView.vue'), props: true },
    { path: '/plan/:id', component: () => import('./views/PlanReviewView.vue'), props: true },
    { path: '/:pathMatch(.*)*', redirect: '/tasks' },
  ],
});
