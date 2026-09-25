import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The dashboard's build.
 *
 * `server.proxy` sends `/api` to a running `agent-usages serve` (7788), which is
 * the other half of `serve --dev`: the front end hot-reloads here while the data
 * keeps coming from the server that owns it.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7788', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // React and ECharts change on their own schedule; splitting them keeps the
        // app chunk small enough to reload instantly on a rebuild. (Vite 8 runs
        // rolldown, which takes the function form.)
        manualChunks(id: string) {
          if (id.includes('/node_modules/echarts/') || id.includes('/node_modules/zrender/')) return 'echarts';
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/react-router') ||
            id.includes('/node_modules/scheduler/')
          ) {
            return 'react';
          }
          return undefined;
        },
      },
    },
  },
});
