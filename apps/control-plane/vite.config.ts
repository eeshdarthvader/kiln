import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const backendPort = process.env.FACTORY_PORT ?? '3775';
const backend = `http://127.0.0.1:${backendPort}`;

export default defineConfig({
  root: 'ui',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/v1': backend,
      '/healthz': backend,
      '/readyz': backend,
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
