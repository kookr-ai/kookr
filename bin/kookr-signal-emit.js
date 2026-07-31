#!/usr/bin/env node
// kookr signal-emit — spool an operator signal into the delivery outbox
// (issue #1716). Called by monitors / cloud routines; the in-server
// SignalDeliveryService then pushes new signals to Discord / Telegram.
//
// Thin entry that loads the compiled CLI (dist/cli/kookr-signal-emit.js),
// falling back to the TypeScript source when running under tsx in dev.
//
// See src/cli/kookr-signal-emit.ts for subcommands and flags.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-signal-emit.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-signal-emit.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    console.error('[kookr] signal-emit module not found at ' + entry);
    console.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exit(1);
  }
  const mod = await import(pathToFileURL(entry).href);
  process.exitCode = await mod.runSignalEmitCli(process.argv.slice(2));
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`kookr-signal-emit: ${msg}`);
  process.exit(1);
});
