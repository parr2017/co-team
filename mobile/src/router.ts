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

// stale-shell self-heal: when a lazy route chunk fails to load (rebuild happened
// under a cached index.html), do ONE full page reload to fetch fresh assets.
// The per-path guard prevents reload loops; each successful navigation clears it.
const RELOAD_FLAG = 'ct-route-reload';
router.onError((error, to) => {
  const msg = String((error as any)?.message || error);
  if (!/import|module|chunk|fetch|load/i.test(msg)) return;
  const to_ = to.fullPath || '/';
  if (sessionStorage.getItem(RELOAD_FLAG) === to_) return;
  sessionStorage.setItem(RELOAD_FLAG, to_);
  window.location.replace(router.resolve(to).href);
});
router.afterEach(() => sessionStorage.removeItem(RELOAD_FLAG));
