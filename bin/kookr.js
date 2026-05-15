#!/usr/bin/env node
// npx kookr entry point. Loads the compiled server so users don't have to
// know about dist/server/start.js. See docs/roadmap.md Phase 2.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

if (process.argv[2] === 'push') {
  await runPushCommand(process.argv.slice(3));
  process.exit(0);
}

if (process.argv[2] === 'command' && process.argv[3] === 'outcome') {
  await runCommandOutcomeCommand(process.argv.slice(4));
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'server', 'start.js');

if (!existsSync(entry)) {
  console.error('[kookr] Build output not found at ' + entry);
  console.error('[kookr] Run `pnpm build` (or `npm run build`) first.');
  process.exit(1);
}

async function runCommandOutcomeCommand(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, '..', 'dist', 'cli', 'kookr-command-outcome.js');
  if (!existsSync(entry)) {
    console.error('[kookr] Build output not found at ' + entry);
    console.error('[kookr] Run `pnpm build:server` (or `npm run build`) first.');
    process.exit(1);
  }
  const mod = await import(entry);
  process.exitCode = await mod.runCommandOutcomeCli(argv);
}

await import(entry);

async function runPushCommand(argv) {
  if (argv[0] !== 'test' || !argv[1] || argv.length > 2) {
    console.error('Usage: kookr push test <deviceId>');
    process.exit(2);
  }
  const relayUrl = process.env.KOOKR_RELAY_URL;
  if (!relayUrl) {
    console.error('KOOKR_RELAY_URL is required for `kookr push test <deviceId>`.');
    process.exit(2);
  }
  const url = new URL('/relay/admin/push/test', relayUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.KOOKR_RELAY_ADMIN_TOKEN ? { authorization: `Bearer ${process.env.KOOKR_RELAY_ADMIN_TOKEN}` } : {}),
    },
    body: JSON.stringify({ deviceId: argv[1] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Push test failed: HTTP ${res.status} ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log(`Push test ${body.result ?? 'unknown'} for ${argv[1]}`);
  if (body.statusCode) console.log(`statusCode=${body.statusCode}`);
  if (body.error) console.log(`error=${body.error}`);
}
