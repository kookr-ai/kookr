#!/usr/bin/env node
// Executable shim + dispatch wrapper for `kookr stop` / `kookr abort` (issue
// #3069). The implementation lives in src/cli/kookr-stop.ts (compiled to
// dist/cli/kookr-stop.js); this file resolves whichever is present and runs it,
// mirroring how bin/kookr.js dispatches the other src/cli TypeScript verbs.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { importMaybeTs } from './import-maybe-ts.js';

function resolveEntry() {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-stop.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-stop.ts');
  return existsSync(distEntry) ? distEntry : sourceEntry;
}

/**
 * Dispatch entry used by bin/kookr.js. Sets process.exitCode and returns it so
 * the caller can `exit()` on it.
 * @returns {Promise<number>}
 */
export async function runStopCommand(argv, { env = process.env, out = console, err = console } = {}) {
  const entry = resolveEntry();
  if (!existsSync(entry)) {
    err.error('[kookr] stop module not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exitCode = 1;
    return 1;
  }
  const mod = await importMaybeTs(entry);
  const code = await mod.runStopCli(argv, { env, out, err });
  process.exitCode = code;
  return code;
}

// npm/pnpm install the bin as a symlink, so resolve argv[1] through its realpath
// before comparing to import.meta.url (which is always realpath-resolved).
function isInvokedDirectly() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  runStopCommand(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`kookr-stop: ${msg}`);
      process.exit(1);
    },
  );
}
