import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = path.resolve(__dirname);
const repo = path.resolve(__dirname, '..');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.join(root, 'src'),
      // The wire contract lives outside the frontend on purpose: one definition
      // of every message shape, imported by both sides, so a protocol change
      // that only lands in one of them is a type error rather than a bug you
      // find in production at 10 Hz.
      '@shared': path.join(repo, 'shared/src'),
    },
  },
  server: {
    port: 5173,
    // Vite refuses to serve files above the project root unless told otherwise.
    fs: { allow: [root, path.join(repo, 'shared')] },
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
});
