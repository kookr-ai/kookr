#!/usr/bin/env node
// kookr-restart-intent — durable planned-restart marker (issue #2410).
//
// A tiny cross-process signal that lets the `kookr` CLI distinguish a PLANNED
// redeploy (`prod:update` / `prod:restart`) from an UNEXPECTED outage (crash,
// OOM, event-loop saturation, port conflict) when the API at :4800 is
// unreachable.
//
// `scripts/prod-restart.sh` writes the marker BEFORE it kills the old server
// and clears it once the new server passes its health check. While the API is
// down the `kookr` CLI reads this marker straight off local disk (it is a local
// process) and enriches its connection-refused error — "kookr is restarting
// (prod:update started 12s ago)" instead of a bare "connection refused". A
// marker that lingers past RESTART_INTENT_STALE_MS without recovery is read as
// a FAILED deploy, not a routine restart.
//
// Plain ESM JavaScript, zero dependencies, no build step: the CLI and the
// deploy script must both work even when dist/ is mid-rebuild during a deploy.
// See bin/kookr-restart-intent.d.ts for the type sidecar and
// src/cli/kookr-restart-intent.test.ts for the contract.

import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const RESTART_INTENT_SCHEMA_VERSION = 'restart-intent.v1';
export const RESTART_INTENT_FILENAME = 'restart-intent.json';

/**
 * Fallback "in progress" window used ONLY when a marker carries no explicit
 * `staleAfterMs` deadline. Past this age with no recovery the marker most likely
 * belongs to a FAILED deploy, so consumers flip from "restarting" to "likely a
 * failed deploy". In production `prod-restart.sh` always stamps the deploy's own
 * `KOOKR_STARTUP_TIMEOUT_SECONDS` budget into the marker (see writeRestartIntent
 * `staleAfterMs`), so this default only covers hand-written / legacy markers.
 * Kept generous (10 min) because this repo has observed legitimately-slow
 * recoveries — a ~10.5 min startup on a 727-task instance drove
 * KOOKR_STARTUP_TIMEOUT_SECONDS up to 1800s (issue #1721); a 3-minute default
 * would have called that healthy deploy "failed".
 */
export const RESTART_INTENT_STALE_MS = 10 * 60_000;

/**
 * Absolute ceiling past which a marker is treated as `none` (ignored), not
 * `stale`. A marker orphaned by a killed deploy script, a reboot mid-deploy, or
 * a manual/systemd recovery that bypassed `prod-restart.sh`'s clear survives on
 * disk indefinitely; without this ceiling an ancient marker would attach
 * "failed deploy from 3 weeks ago" context to a fresh, unrelated outage and
 * muddy the diagnosis (issue #2410 operability review).
 */
export const RESTART_INTENT_EXPIRY_MS = 12 * 60 * 60_000;

function safeHostname() {
  try {
    return hostname();
  } catch {
    return null;
  }
}

/**
 * Mirror the KOOKR_DIR mapping in src/server/start.ts and
 * scripts/prod-restart.sh: port 4800 → ~/.kookr, any other port → ~/.kookr-<port>.
 * An explicit `dir` always wins so the deploy script can pass the exact path it
 * already computed.
 */
export function resolveKookrDir({ dir, port, env = process.env } = {}) {
  if (dir !== undefined && dir !== null && String(dir).trim() !== '') return String(dir);
  const raw = port ?? env.KOOKR_PORT ?? 4800;
  const parsed = Number(raw);
  const p = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 4800;
  return p === 4800 ? join(homedir(), '.kookr') : join(homedir(), `.kookr-${p}`);
}

export function restartIntentPath(kookrDir) {
  return join(kookrDir, RESTART_INTENT_FILENAME);
}

export function writeRestartIntent({ kookrDir, reason, initiator, pid, staleAfterMs, token, now = Date.now(), host } = {}) {
  const record = {
    schemaVersion: RESTART_INTENT_SCHEMA_VERSION,
    reason: reason !== undefined && reason !== null && String(reason).trim() !== '' ? String(reason) : 'restart',
    startedAt: new Date(now).toISOString(),
    // Collision-proof ownership token so a clear only ever removes the marker it
    // wrote — startedAt alone is millisecond-granular and two same-ms writes
    // could otherwise let one deploy delete another's marker (issue #2410).
    token: typeof token === 'string' && token.trim() !== '' ? token : randomUUID(),
    initiator:
      initiator !== undefined && initiator !== null && String(initiator).trim() !== ''
        ? String(initiator)
        : 'unknown',
    pid: Number.isInteger(pid) ? pid : null,
    // The deploy's own give-up deadline (KOOKR_STARTUP_TIMEOUT_SECONDS), so the
    // reader flips to "failed deploy" when the restart outlives the budget the
    // deploy actually allowed itself — not an arbitrary constant.
    staleAfterMs: Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? Math.floor(staleAfterMs) : null,
    host: host !== undefined ? host : safeHostname(),
  };
  mkdirSync(kookrDir, { recursive: true });
  // Write to a per-process temp file then rename so a concurrent reader never
  // observes a half-written marker (rename is atomic within a directory on
  // POSIX). The pid suffix keeps two overlapping restart processes from
  // clobbering each other's temp file mid-write (each restart is its own
  // `node` process), so the final rename reflects exactly one writer's content.
  const target = restartIntentPath(kookrDir);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
  return record;
}

/**
 * Remove the marker. When `expectToken` is given, only remove it if the on-disk
 * marker's `token` still matches — so a restart that finishes first cannot
 * delete a *different*, still-in-flight restart's marker out from under it, even
 * if both started in the same millisecond (overlapping deploys, issue #2410).
 */
export function clearRestartIntent(kookrDir, { expectToken } = {}) {
  try {
    if (expectToken !== undefined && expectToken !== null && String(expectToken).trim() !== '') {
      const current = readRestartIntent(kookrDir);
      if (!current || current.token !== String(expectToken)) return;
    }
    rmSync(restartIntentPath(kookrDir), { force: true });
  } catch {
    // Best-effort: a leftover marker only ever produces a stale (failed-deploy)
    // reading, never a false "healthy" one.
  }
}

/**
 * Read and normalize the marker. Returns null when absent or unparseable (both
 * mean "no planned restart is recorded"), so a corrupt marker never masquerades
 * as an in-progress restart.
 */
export function readRestartIntent(kookrDir) {
  let raw;
  try {
    raw = readFileSync(restartIntentPath(kookrDir), 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const startedAtMs = Date.parse(String(parsed.startedAt ?? ''));
  if (!Number.isFinite(startedAtMs)) return null;
  return {
    schemaVersion: typeof parsed.schemaVersion === 'string' ? parsed.schemaVersion : null,
    reason:
      typeof parsed.reason === 'string' && parsed.reason.trim() !== '' ? parsed.reason : 'restart',
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    token: typeof parsed.token === 'string' && parsed.token.trim() !== '' ? parsed.token : null,
    initiator: typeof parsed.initiator === 'string' ? parsed.initiator : null,
    pid: Number.isInteger(parsed.pid) ? parsed.pid : null,
    staleAfterMs:
      Number.isFinite(parsed.staleAfterMs) && parsed.staleAfterMs > 0 ? Math.floor(parsed.staleAfterMs) : null,
    host: typeof parsed.host === 'string' ? parsed.host : null,
  };
}

/**
 * @param {ReturnType<typeof readRestartIntent>} intent
 * @returns {{ state: 'none' | 'in-progress' | 'stale', ageMs: number }}
 */
export function classifyRestartIntent(intent, now = Date.now()) {
  if (!intent) return { state: 'none', ageMs: 0 };
  const ageMs = Math.max(0, now - intent.startedAtMs);
  // Past the absolute ceiling the marker is an orphan from some earlier deploy,
  // not context for the current outage — ignore it entirely.
  if (ageMs > RESTART_INTENT_EXPIRY_MS) return { state: 'none', ageMs };
  const staleAfterMs =
    Number.isFinite(intent.staleAfterMs) && intent.staleAfterMs > 0
      ? intent.staleAfterMs
      : RESTART_INTENT_STALE_MS;
  return { state: ageMs > staleAfterMs ? 'stale' : 'in-progress', ageMs };
}

export function formatAge(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

/**
 * Human-readable restart context, or null when no marker is present. Used where
 * a caller wants to say something ONLY when a planned restart is recorded.
 */
export function describeRestartIntent(intent, now = Date.now()) {
  const { state, ageMs } = classifyRestartIntent(intent, now);
  if (state === 'none') return null;
  const age = formatAge(ageMs);
  if (state === 'stale') {
    return `a kookr restart (${intent.reason}) started ${age} ago but the API has not come back — this looks like a failed deploy, not a routine restart.`;
  }
  return `kookr is restarting (${intent.reason} started ${age} ago); the API should return once the redeploy finishes.`;
}

/**
 * One machine-readable `restartIntent` shape shared by every `--json` CLI
 * surface (kookr status, kookr signal) so a programmatic consumer sees the same
 * fields regardless of which command it called.
 */
export function restartIntentJson(intent, now = Date.now()) {
  const { state, ageMs } = classifyRestartIntent(intent, now);
  return {
    state,
    ageMs,
    reason: state === 'none' ? null : intent.reason,
    startedAt: state === 'none' ? null : intent.startedAt,
  };
}

/**
 * Always-non-null cause for the CLI's connection-refused/timeout path: a
 * planned-restart description when a marker exists, otherwise the explicit
 * "unexpected outage" verdict so an agent can tell the two apart.
 */
export function describeUnreachableCause(intent, now = Date.now()) {
  return (
    describeRestartIntent(intent, now)
    ?? 'no planned restart is in progress — this looks like an unexpected outage (crash, OOM, or port conflict).'
  );
}

/**
 * Convenience for CLI callers: resolve the kookr dir, read the marker, and
 * return everything a connection-error message needs in one call.
 */
export function readUnreachableCause({ dir, port, env = process.env, now = Date.now() } = {}) {
  const kookrDir = resolveKookrDir({ dir, port, env });
  const intent = readRestartIntent(kookrDir);
  return {
    kookrDir,
    intent,
    classification: classifyRestartIntent(intent, now),
    message: describeUnreachableCause(intent, now),
  };
}

/**
 * Find the most relevant restart marker across a list of candidate ports (kookr
 * `status` auto-detects across 4800/4801). Prefers an `in-progress` marker over
 * a `stale` one, and skips `none`-classified markers entirely — an expired
 * orphan on one port must never mask a live restart on another (issue #2410
 * correctness review). Returns the marker plus its port, or null when no port
 * has a marker that still classifies as a restart.
 */
export function firstRestartIntentAcrossPorts(ports, { env = process.env, now = Date.now() } = {}) {
  let fallbackStale = null;
  for (const port of ports) {
    const kookrDir = resolveKookrDir({ port, env });
    const intent = readRestartIntent(kookrDir);
    if (!intent) continue;
    const { state } = classifyRestartIntent(intent, now);
    if (state === 'in-progress') return { port, kookrDir, intent };
    if (state === 'stale' && fallbackStale === null) fallbackStale = { port, kookrDir, intent };
  }
  return fallbackStale;
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--reason':
        flags.reason = argv[++i];
        break;
      case '--initiator':
        flags.initiator = argv[++i];
        break;
      case '--port':
        flags.port = argv[++i];
        break;
      case '--dir':
        flags.dir = argv[++i];
        break;
      case '--pid':
        flags.pid = Number(argv[++i]);
        break;
      case '--stale-after-ms':
        flags.staleAfterMs = Number(argv[++i]);
        break;
      case '--expect-token':
        flags.expectToken = argv[++i];
        break;
      default:
        break;
    }
  }
  return flags;
}

const USAGE =
  'usage: kookr-restart-intent <write|clear|show> [--reason R] [--initiator I] [--port P] [--dir D] [--pid N] [--stale-after-ms MS] [--expect-token TOKEN]';

export async function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr } = {}) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  const kookrDir = resolveKookrDir({ dir: flags.dir, port: flags.port });
  switch (command) {
    case 'write': {
      const record = writeRestartIntent({
        kookrDir,
        reason: flags.reason,
        initiator: flags.initiator,
        pid: flags.pid,
        staleAfterMs: flags.staleAfterMs,
      });
      // Emit the marker's unique token so the caller (prod-restart.sh) can pass
      // it back to `clear --expect-token` for a collision-proof ownership check.
      out.write(`${record.token}\n`);
      return 0;
    }
    case 'clear':
      clearRestartIntent(kookrDir, { expectToken: flags.expectToken });
      return 0;
    case 'show':
      out.write(`${JSON.stringify(readRestartIntent(kookrDir))}\n`);
      return 0;
    default:
      err.write(`${USAGE}\n`);
      return 2;
  }
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
  main().then(
    (code) => {
      process.exit(code);
    },
    (error) => {
      // Never let a marker failure block a deploy or a CLI command.
      process.stderr.write(`kookr-restart-intent: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
