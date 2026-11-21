// web/src/router.js
import { createRouter, createWebHistory } from 'vue-router';

import ChatView from './views/ChatView.vue';
import { useAuth } from './composables/useAuth';

const routes = [
  // The chat is for signed-in students
  { path: '/', component: ChatView, name: 'chat', meta: { requiresStudent: true, bare: true } },
  { path: '/login', component: () => import('./views/AuthView.vue'), name: 'login', meta: { bare: true } },
  // Most visitors never open the admin screen: load it on demand. It has its own sign-in.
  { path: '/admin', component: () => import('./views/AdminView.vue'), name: 'admin' },
  // catch-all -> redirect to chat
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  const { isSignedIn } = useAuth();
  if (to.meta.requiresStudent && !isSignedIn.value) {
    return { name: 'login', query: to.fullPath === '/' ? {} : { next: to.fullPath } };
  }
  if (to.name === 'login' && isSignedIn.value) return { name: 'chat' };
  return true;
});

export default router;
