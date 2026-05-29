#!/usr/bin/env node
// npx kookr entry point. Loads the compiled server so users don't have to
// know about dist/server/start.js. See docs/roadmap.md Phase 2.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

const HELP_TEXT = `kookr - local AI agent supervisor.

Usage:
  kookr                         Start the built Kookr server.
  kookr spawn [OPTIONS] [PROMPT...]    Create a task from the current shell.
  kookr status                  Print a read-only server snapshot.
  kookr ralph <command> <taskId> Inspect or control a Ralph loop.
  kookr drain|resume [OPTIONS]  Control operator drain mode.
  kookr push test <deviceId>    Send a relay push test.

Compatibility aliases:
  kookr-spawn, kookr-status, and kookr-ralph still work for now, but are deprecated.
`;

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  out = console,
  err = console,
  exit = process.exit,
} = {}) {
  const [command, ...rest] = argv;

  if (command === '-h' || command === '--help' || command === 'help') {
    out.log(HELP_TEXT);
    return exit(0);
  }

  if (command === 'spawn') {
    const { main: runSpawnCli } = await import('./kookr-spawn.js');
    return runSpawnCli({ argv: rest, env, out, err, exit });
  }

  if (command === 'status') {
    const { main: runStatusCli } = await import('./kookr-status.js');
    return runStatusCli({ argv: rest, env, out, exit });
  }

  if (command === 'ralph') {
    const { main: runRalphCli } = await import('./kookr-ralph.js');
    return runRalphCli({ argv: rest, env, out, err, exit });
  }

  if (command === 'push') {
    await runPushCommand(rest);
    return exit(0);
  }

  if (command === 'command' && rest[0] === 'outcome') {
    await runCommandOutcomeCommand(rest.slice(1));
    return exit(process.exitCode ?? 0);
  }

  // Operator drain / resume control (issue #659). Runs as a thin HTTP client
  // against the running server rather than booting one, so it dispatches here.
  if (command === 'drain' || command === 'resume') {
    const { runDrainCli } = await import('./kookr-drain.js');
    return exit(await runDrainCli(argv));
  }

  if (command !== undefined) {
    err.error(`[kookr] Unknown command: ${command}`);
    err.error('Run `kookr --help` for usage.');
    return exit(2);
  }

  return startServer({ err, exit });
}

async function startServer({ err = console, exit = process.exit } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, '..', 'dist', 'server', 'start.js');

  if (!existsSync(entry)) {
    err.error('[kookr] Build output not found at ' + entry);
    err.error('[kookr] Run `pnpm build` (or `npm run build`) first.');
    return exit(1);
  }

  await import(entry);
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
  main().catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[kookr] ${msg}`);
    process.exit(1);
  });
}

export { HELP_TEXT, main };
