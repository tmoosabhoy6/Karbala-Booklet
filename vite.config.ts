import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Hashed code and styles go to dist/app/, which the server caches for good;
  // public/assets/ (artwork, not hashed) keeps its own folder.
  build: { assetsDir: 'app' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3001', '/media': 'http://127.0.0.1:3001' },
  },
});
