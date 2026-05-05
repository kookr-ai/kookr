import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/frontend',
  build: {
    outDir: '../../dist/frontend',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4801',
      '/ws': {
        target: 'http://127.0.0.1:4801',
        ws: true,
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    root: '.',
  },
});
