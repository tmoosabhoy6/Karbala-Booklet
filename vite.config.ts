import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Hashed code and styles go to dist/app/, which the server caches for good;
  // public/assets/ (artwork, not hashed) keeps its own folder.
  // ES2022: MuPDF's module awaits its WebAssembly at the top level.
  build: { assetsDir: 'app', target: 'es2022' },
  // The kalam renderer (src/library/worker.ts) loads MuPDF's WebAssembly next
  // to its own module: module workers, and MuPDF left out of dev pre-bundling.
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['mupdf'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3001', '/media': 'http://127.0.0.1:3001' },
  },
});
