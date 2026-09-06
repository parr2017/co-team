import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true,
    port: 8856,
    proxy: {
      '/api': 'http://localhost:8855',
      '/ws': { target: 'ws://localhost:8855', ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
