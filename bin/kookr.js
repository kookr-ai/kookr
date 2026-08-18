#!/usr/bin/env node
// npx kookr entry point. Loads the compiled server so users don't have to
// know about dist/server/start.js. See docs/roadmap.md Phase 2.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { importMaybeTs } from './import-maybe-ts.js';

const HELP_TEXT = `kookr - local AI agent supervisor.

Usage:
  kookr                         Start the built Kookr server.
  kookr spawn [OPTIONS] [PROMPT...]    Create a task from the current shell.
  kookr doctor [--json]         Run launch preflight checks (human table or JSON).
  kookr signal <kind> [OPTIONS]  Raise an agent → user signal for the current task.
  kookr issue <verb> [OPTIONS]   Claim/release/inspect issue ownership.
  kookr status [--json] [--fail-on <critical|warning|info|none>] Print a read-only server snapshot.
  kookr ops digest [--json] [--offline]  One-pager of top unattended failure signals (ready + health); --offline reads the last-good snapshot when HTTP is dark.
  kookr ops timers [--json]              List lifecycle-timer lastFiredAt and overdue flags (GET /api/diagnostics/timer-health).
  kookr github status [--json]   Print GitHub scanner liveness, backoff, and tracked-ref count.
  kookr logs <taskId> [OPTIONS]   Tail a task's recent hook-event activity.
  kookr command outcome [commandId] Inspect local/remote command outcomes as JSONL.
  kookr ralph <command> <taskId> [--json] Inspect or control a Ralph loop.
  kookr schedule <verb> [OPTIONS]  List/run/enable/disable schedules.
  kookr drain|resume [OPTIONS]  Control operator drain mode.
  kookr migrate --to <agent> [OPTIONS]  Continue interrupted tasks under a different agent.
  kookr maintenance prune [OPTIONS]   Prune aged completed-task data-dir artifacts.
  kookr maintenance backup [OPTIONS]  Create a crash-consistent data-dir backup tarball.
  kookr lesson status|drain|remember|yield  Durable lesson-write spool + yield metric.
  kookr effort-split [OPTIONS]  Lucy vs kookr output share vs the 80/20 target (daily report).
  kookr emission plan|dedupe|metrics|defer|version  Drain-coupled issue filing budget + dedupe.
  kookr value-density classify|admit|composition|decline  Refactor-class emission/spawn governor + composition (#1846).
  kookr queue-feeder plan|leaves [OPTIONS]  Auto-decompose product umbrellas into spawnable leaves when capacity idles (#1845).
  kookr reflect outcomes|ideas [OPTIONS]  Reflection Phase-1 telemetry: 24h outcome tally + ideasFiled resolver.
  kookr retro-verify status|drain|enqueue  CI-blind-merge debt + retro-verify drain.
  kookr pr-checklist verify|doctor [OPTIONS]  Verify PR checklist or report local gate fail-open rate.
  kookr context-pack --spec <f> --out <f>  Build a spawn-time context pack from a JSON spec.
  kookr signal-emit transition|liveness [OPTIONS]  Spool an operator signal for delivery.
  kookr push test <deviceId>    Send a relay push test.
  kookr completion bash|zsh     Print a shell completion script.

Options:
  -v, --version                 Print the installed Kookr version.
  -h, --help                    Show this help.

Use --json with spawn, doctor, status, ops digest, ops timers, signal, or ralph for one machine-readable output envelope.

Compatibility aliases:
  kookr-spawn, kookr-status, and kookr-ralph still work for now, but are deprecated.
`;

const DOCTOR_HELP_TEXT = `kookr doctor — run launch preflight checks.

Usage:
  kookr doctor
  kookr doctor --json
  kookr doctor --strict

Options:
  --json       Print one JSON report to stdout (machine-readable).
  --strict     Exit non-zero when any advisory WARN is present (default: only
               required FAIL checks fail the process).
  -h, --help   Show this help.

Without --json, prints a human-readable table of each check (status, summary,
recommended action) covering runtime tools, gh auth, kb, agent binaries,
and agent.grok-auth (advisory WARN when grok is on PATH; required FAIL when
KOOKR_GROK_BIN is set and launch-scoped auth is missing, invalid, or expired).
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

  if (command === '-v' || command === '--version') {
    out.log(readPackageVersion());
    return exit(0);
  }

  if (command === 'spawn') {
    const { main: runSpawnCli } = await import('./kookr-spawn.js');
    return runSpawnCli({ argv: rest, env, out, err, exit });
  }

  if (command === 'doctor') {
    await runDoctorCommand(rest, { env, out, err });
    return exit(process.exitCode ?? 0);
  }

  if (command === 'signal') {
    const { main: runSignalCli } = await import('./kookr-signal.js');
    return runSignalCli({ argv: rest, env, out, err, exit });
  }

  if (command === 'issue') {
    const { main: runIssueCli } = await import('./kookr-issue.js');
    return runIssueCli({ argv: rest, env, out, err, exit });
  }

  if (command === 'status') {
    const { main: runStatusCli } = await import('./kookr-status.js');
    return runStatusCli({ argv: rest, env, out, exit });
  }

  // Ops digest one-pager (issue #2347). Thin HTTP client against
  // /api/ready + /api/health — dispatches here rather than booting a server.
  if (command === 'ops') {
    await runOpsCommand(rest, { env, out, err });
    return exit(process.exitCode ?? 0);
  }

  // GitHub scanner status (issue #1947). Thin HTTP client against
  // /api/github/status — dispatches here rather than booting a server.
  if (command === 'github') {
    await runGithubCommand(rest, { env, out, err });
    return exit(process.exitCode ?? 0);
  }

  if (command === 'ralph') {
    const { main: runRalphCli } = await import('./kookr-ralph.js');
    return runRalphCli({ argv: rest, env, out, err, exit });
  }

  // Schedule list/run/enable/disable (issue #1399). Thin HTTP client against
  // the running server's /api/schedules routes, so it dispatches here rather
  // than booting a server.
  if (command === 'schedule') {
    const { main: runScheduleCli } = await import('./kookr-schedule.js');
    return runScheduleCli({ argv: rest, env, out, err, exit });
  }

  if (command === 'logs') {
    await runLogsCommand(rest, { env, out, err });
    return exit(process.exitCode ?? 0);
  }

  if (command === 'push') {
    await runPushCommand(rest);
    return exit(0);
  }

  if (command === 'completion') {
    const { runCompletionCli } = await loadCompletionModule();
    return runCompletionCli({ argv: rest, out, err, exit });
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

  // Cross-agent task migration (RFC: docs/rfc/rfc-cross-agent-task-migration.md).
  // Thin HTTP client against the running server's /api/tasks/migratable +
  // /api/tasks/migrate routes, so it dispatches here rather than booting a server.
  if (command === 'migrate') {
    const { main: runMigrateCli } = await import('./kookr-migrate.js');
    return runMigrateCli({ argv: rest, env, out, err, exit });
  }

  // Data-directory retention/compaction sweep (issue #706). Operates directly
  // on the on-disk data dir rather than booting a server, so it dispatches here.
  if (command === 'maintenance') {
    await runMaintenanceCommand(rest);
    return exit(process.exitCode ?? 0);
  }

  // Durable lesson-write spool (issue #1519). Disk + local `kb` only.
  if (command === 'lesson') {
    await runLessonCommand(rest, { env, out, err });
    return exit(process.exitCode ?? 0);
  }

  // Effort split vs 80/20 for the daily report (issue #1718). gh-only; no ledger.
  if (command === 'effort-split') {
    await runEffortSplitCommand(rest, { env, out, err });
    return exit(process.exitCode ?? 0);
  }

  // Drain-coupled issue emission budget + mandatory dedupe (issue #1607).
  if (command === 'emission') {
    await runEmissionCommand(rest, { env, out, err });
    return exit(process.exitCode ?? 0);
  }

  // Value-density governor: refactor-class cap + composition metrics (#1846).
  if (command === 'value-density') {
    await runValueDensityCommand(rest, { env, out, err });
    return exit(process.exitCode ?? 0);
  }

  // Queue-feeder: auto-decompose product umbrellas into spawnable leaves when
  // idle capacity + empty queue is detected (issue #1845). Dry-run by default.
  if (command === 'queue-feeder') {
    await runQueueFeederCommand(rest, { env, out, err });
    return exit(process.exitCode ?? 0);
  }

  // CI-blind-merge debt + retro-verify queue drain (issues #1689 / #1703).
  if (command === 'retro-verify') {
    await runRetroVerifyCommand(rest, { env, out, err });
    return exit(process.exitCode ?? 0);
  }

  // Phase-1 instrumentation for the workflow-reflection loop (issue #1751):
  // 24h outcome tally + ideasFiled auto-resolver.
  if (command === 'reflect') {
    await runReflectCommand(rest, { env, out, err });
    return exit(process.exitCode ?? 0);
  }

  if (command === 'pr-checklist') {
    await runPrChecklistCommand(rest, { env, out, err });
    return exit(process.exitCode ?? 0);
  }

  // Spawn-time context pack builder (issue #1385). Loads the compiled CLI with a
  // dist→src fallback so it works from an npm install and a source checkout
  // alike; the by-path bin/kookr-context-pack.js form keeps working too.
  if (command === 'context-pack') {
    await runContextPackCommand(rest, { env, out, err });
    return exit(process.exitCode ?? 0);
  }

  // Operator-signal emitter (issue #1716). Spools transition / liveness signals
  // into the delivery outbox for the in-server bridge to push outbound. Loads
  // the compiled CLI with a dist→src fallback; the by-path
  // bin/kookr-signal-emit.js form keeps working too.
  if (command === 'signal-emit') {
    await runSignalEmitCommand(rest, { env, out, err });
    return exit(process.exitCode ?? 0);
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

function readPackageVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(here, '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
    throw new Error('package.json version is missing');
  }
  return packageJson.version;
}

async function runMaintenanceCommand(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, '..', 'dist', 'cli', 'kookr-maintenance.js');
  if (!existsSync(entry)) {
    console.error('[kookr] Build output not found at ' + entry);
    console.error('[kookr] Run `pnpm build:server` (or `npm run build`) first.');
    process.exit(1);
  }
  const mod = await import(entry);
  process.exitCode = await mod.runMaintenanceCli(argv);
}

async function runLessonCommand(argv, { env = process.env, out = console, err = console } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, '..', 'dist', 'cli', 'kookr-lesson.js');
  if (!existsSync(entry)) {
    err.error('[kookr] Build output not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build`) first.');
    process.exitCode = 1;
    return;
  }
  const mod = await import(pathToFileURL(entry).href);
  process.exitCode = await mod.runLessonCli(argv, { env, out, err });
}

async function runEffortSplitCommand(argv, { env = process.env, out = console, err = console } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-effort-split.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-effort-split.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    err.error('[kookr] effort-split module not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exitCode = 1;
    return;
  }
  const mod = await importMaybeTs(entry);
  process.exitCode = await mod.runEffortSplitCli(argv, { env, out, err });
}

async function runReflectCommand(argv, { env = process.env, out = console, err = console } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-reflect.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-reflect.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    err.error('[kookr] reflect module not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exitCode = 1;
    return;
  }
  const mod = await importMaybeTs(entry);
  process.exitCode = await mod.runReflectCli(argv, { env, out, err });
}

async function runEmissionCommand(argv, { env = process.env, out = console, err = console } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, '..', 'dist', 'cli', 'kookr-emission.js');
  if (!existsSync(entry)) {
    err.error('[kookr] Build output not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build`) first.');
    process.exitCode = 1;
    return;
  }
  const mod = await import(pathToFileURL(entry).href);
  process.exitCode = await mod.runEmissionCli(argv, { env, out, err });
}

async function runValueDensityCommand(argv, { env = process.env, out = console, err = console } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-value-density.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-value-density.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    err.error('[kookr] value-density module not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exitCode = 1;
    return;
  }
  const mod = await importMaybeTs(entry);
  process.exitCode = await mod.runValueDensityCli(argv, { env, out, err });
}

async function runQueueFeederCommand(argv, { env = process.env, out = console, err = console } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-queue-feeder.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-queue-feeder.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    err.error('[kookr] queue-feeder module not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exitCode = 1;
    return;
  }
  const mod = await importMaybeTs(entry);
  process.exitCode = await mod.runQueueFeederCli(argv, { env, out, err });
}

async function runRetroVerifyCommand(argv, { env = process.env, out = console, err = console } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, '..', 'dist', 'cli', 'kookr-retro-verify.js');
  if (!existsSync(entry)) {
    err.error('[kookr] Build output not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build`) first.');
    process.exitCode = 1;
    return;
  }
  const mod = await import(pathToFileURL(entry).href);
  process.exitCode = await mod.runRetroVerifyCli(argv, { env, out, err });
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

async function runLogsCommand(argv, { env = process.env, out = console, err = console } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-logs.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-logs.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    err.error('[kookr] Logs module not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exit(1);
  }
  const mod = await importMaybeTs(entry);
  process.exitCode = await mod.runLogsCli(argv, { env, out, err });
}

async function runOpsCommand(argv, { env = process.env, out = console, err = console } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-ops-digest.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-ops-digest.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    err.error('[kookr] ops module not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exitCode = 1;
    return;
  }
  const mod = await importMaybeTs(entry);
  process.exitCode = await mod.runOpsDigestCli(argv, { env, out, err });
}

async function runGithubCommand(argv, { env = process.env, out = console, err = console } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-github.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-github.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    err.error('[kookr] github module not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exitCode = 1;
    return;
  }
  const mod = await importMaybeTs(entry);
  process.exitCode = await mod.runGithubCli(argv, { env, out, err });
}

async function runContextPackCommand(argv, { env = process.env, out = console, err = console } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-context-pack.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-context-pack.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    err.error('[kookr] context-pack module not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exit(1);
  }
  const mod = await importMaybeTs(entry);
  process.exitCode = await mod.runContextPackCli(argv, { env, out });
}

async function runSignalEmitCommand(argv, { env = process.env, out = console, err = console } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-signal-emit.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-signal-emit.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    err.error('[kookr] signal-emit module not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exit(1);
  }
  const mod = await importMaybeTs(entry);
  process.exitCode = await mod.runSignalEmitCli(argv);
}

async function runDoctorCommand(argv, { env = process.env, out = console, err = console } = {}) {
  if (argv.includes('-h') || argv.includes('--help')) {
    out.log(DOCTOR_HELP_TEXT);
    process.exitCode = 0;
    return;
  }
  if (env === process.env) {
    try {
      process.loadEnvFile();
    } catch {}
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-doctor.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-doctor.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    err.error('[kookr] Doctor module not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exit(1);
  }
  const mod = await importMaybeTs(entry);
  process.exitCode = await mod.runDoctorCli(argv, { env, out, cwd: process.cwd() });
}

async function runPrChecklistCommand(argv, { env = process.env, out = console, err = console } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-pr-checklist.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-pr-checklist.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    err.error('[kookr] PR checklist module not found at ' + entry);
    err.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exit(1);
  }
  const mod = await importMaybeTs(entry);
  process.exitCode = await mod.runPrChecklistCli(argv, { env, out, err, cwd: process.cwd() });
}

async function loadCompletionModule() {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', 'dist', 'cli', 'kookr-completion.js');
  const sourceEntry = join(here, '..', 'src', 'cli', 'kookr-completion.ts');
  const entry = existsSync(distEntry) ? distEntry : sourceEntry;
  if (!existsSync(entry)) {
    console.error('[kookr] Completion module not found at ' + entry);
    console.error('[kookr] Run `pnpm build:server` (or `npm run build:server`) first.');
    process.exit(1);
  }
  return importMaybeTs(entry);
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
