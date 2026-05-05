#!/usr/bin/env node
// npx kookr entry point. Loads the compiled server so users don't have to
// know about dist/server/start.js. See docs/roadmap.md Phase 2.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'server', 'start.js');

if (!existsSync(entry)) {
  console.error('[kookr] Build output not found at ' + entry);
  console.error('[kookr] Run `pnpm build` (or `npm run build`) first.');
  process.exit(1);
}

await import(entry);
