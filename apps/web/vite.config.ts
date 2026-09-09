import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    strictPort: true,
    proxy: Object.fromEntries(
      ['/v1', '/health'].map((path) => [
        path,
        { target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:3000', changeOrigin: false },
      ]),
    ),
  },
  build: { outDir: 'dist', sourcemap: true },
});
