import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Default `host: true` binds dual-stack so both http://127.0.0.1:5173 and
// http://[::1]:5173 are reachable. Vite's bare default of 'localhost' binds
// only [::1] on IPv6-first resolvers, breaking IPv4 callers (containers, CI).
// KOOKR_DEV_HOST overrides — e.g. '0.0.0.0' for LAN access.
const devHost: string | boolean = process.env.KOOKR_DEV_HOST ?? true;

export default defineConfig({
  plugins: [react()],
  root: 'src/frontend',
  define: {
    __KOOKR_DISABLE_ONBOARDING__: JSON.stringify(process.env.KOOKR_DISABLE_ONBOARDING ?? ''),
  },
  build: {
    outDir: '../../dist/frontend',
    emptyOutDir: true,
    sourcemap: 'hidden',
  },
  server: {
    host: devHost,
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
