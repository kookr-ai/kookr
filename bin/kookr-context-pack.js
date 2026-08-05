#!/usr/bin/env node
// kookr context-pack — build a spawn-time context pack from a JSON spec.
//
// Thin entry that loads the compiled CLI (dist/cli/kookr-context-pack.js),
// falling back to the TypeScript source via tsx when dist is missing (dev /
// clean-clone / IVL). Invoked by path from the parallel-issue-batch playbook,
// alongside bin/kookr-spawn.js.
//
// See src/cli/kookr-context-pack.ts for flags and the JSON spec shape, and
// src/core/context-pack.ts for the pack contract (a floor, not a ceiling).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { importMaybeTs } from './import-maybe-ts.js';

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-context-pack.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-context-pack.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    console.error('[kookr] context-pack module not found at ' + entry);
    console.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exit(1);
  }
  const mod = await importMaybeTs(entry);
  process.exitCode = await mod.runContextPackCli(process.argv.slice(2));
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`kookr-context-pack: ${msg}`);
  process.exit(1);
});
