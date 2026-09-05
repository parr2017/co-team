import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// served under /m/ by the backend static middleware (same origin as the API)
export default defineConfig({
  base: '/m/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 8857,
    proxy: {
      '/api': { target: 'http://localhost:8855', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8855', ws: true },
    },
  },
});
