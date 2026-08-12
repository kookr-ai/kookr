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

export const RESTART_INTENT_SCHEMA_VERSION = 'restart-intent.v1';
export const RESTART_INTENT_FILENAME = 'restart-intent.json';

/**
 * A planned restart is only "in progress" for a short window. Past this age
 * with no recovery the marker most likely belongs to a FAILED deploy — the new
 * server never came back to clear it — so consumers flip their copy from
 * "restarting, back shortly" to "restart has not come back — likely a failed
 * deploy". Kept generous so a slow `prod:update` still reads as planned.
 */
export const RESTART_INTENT_STALE_MS = 3 * 60_000;

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

export function writeRestartIntent({ kookrDir, reason, initiator, pid, now = Date.now(), host } = {}) {
  const record = {
    schemaVersion: RESTART_INTENT_SCHEMA_VERSION,
    reason: reason !== undefined && reason !== null && String(reason).trim() !== '' ? String(reason) : 'restart',
    startedAt: new Date(now).toISOString(),
    initiator:
      initiator !== undefined && initiator !== null && String(initiator).trim() !== ''
        ? String(initiator)
        : 'unknown',
    pid: Number.isInteger(pid) ? pid : null,
    host: host !== undefined ? host : safeHostname(),
  };
  mkdirSync(kookrDir, { recursive: true });
  // Write to a temp file then rename so a concurrent reader never observes a
  // half-written marker (rename is atomic within a directory on POSIX).
  const target = restartIntentPath(kookrDir);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
  return record;
}

export function clearRestartIntent(kookrDir) {
  try {
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
    initiator: typeof parsed.initiator === 'string' ? parsed.initiator : null,
    pid: Number.isInteger(parsed.pid) ? parsed.pid : null,
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
  return { state: ageMs > RESTART_INTENT_STALE_MS ? 'stale' : 'in-progress', ageMs };
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
  return `kookr is restarting (${intent.reason} started ${age} ago); the API should return within a few seconds.`;
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
 * Read the first present marker across a list of candidate ports (kookr `status`
 * auto-detects across 4800/4801). Returns the marker plus the port it belongs
 * to, or null when none of the ports has one.
 */
export function firstRestartIntentAcrossPorts(ports, { env = process.env } = {}) {
  for (const port of ports) {
    const kookrDir = resolveKookrDir({ port, env });
    const intent = readRestartIntent(kookrDir);
    if (intent) return { port, kookrDir, intent };
  }
  return null;
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
      default:
        break;
    }
  }
  return flags;
}

const USAGE =
  'usage: kookr-restart-intent <write|clear|show> [--reason R] [--initiator I] [--port P] [--dir D] [--pid N]';

export async function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr } = {}) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  const kookrDir = resolveKookrDir({ dir: flags.dir, port: flags.port });
  switch (command) {
    case 'write':
      writeRestartIntent({
        kookrDir,
        reason: flags.reason,
        initiator: flags.initiator,
        pid: flags.pid,
      });
      out.write(`${restartIntentPath(kookrDir)}\n`);
      return 0;
    case 'clear':
      clearRestartIntent(kookrDir);
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
