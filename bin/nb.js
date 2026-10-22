#!/usr/bin/env node
// nb — the Agent Notebook CLI. A role's bounded, voted, plain-text memory.
//
// Thin entry that loads the compiled CLI (dist/cli/nb.js), falling back to the
// TypeScript source via tsx when dist is missing (dev / clean-clone / IVL).
// Mirrors bin/kookr-context-pack.js.
//
// See src/cli/nb.ts for the commands and src/core/notebook.ts for the storage
// contract (bounded one-line entries, lowest-score eviction, usage ring).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { importMaybeTs } from './import-maybe-ts.js';

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'nb.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'nb.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    console.error('[nb] notebook CLI module not found at ' + entry);
    console.error('[nb] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exit(1);
  }
  const mod = await importMaybeTs(entry);
  process.exitCode = await mod.runNbCli(process.argv.slice(2));
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`nb: ${msg}`);
  process.exit(1);
});
