#!/usr/bin/env node
// kookr schedule — list / run / enable / disable schedules from the shell
// (issue #1399). Schedules were the one subsystem with no CLI: an operator on
// a headless/SSH box could not list, trigger, or disable a schedule without a
// browser. This is a thin HTTP client over the existing REST routes (see
// src/server/routes/schedule-routes.ts) — the server owns validation, cron
// evaluation, and capacity/drain gating; this CLI just resolves the server and
// renders the response.
//
// Usage:
//   kookr schedule list [--json]
//   kookr schedule run <id> [--json]
//   kookr schedule enable <id> [--json]
//   kookr schedule disable <id> [--json]
//
// Endpoints wrapped:
//   list           GET   /api/schedules
//   run <id>       POST  /api/schedules/:id/run
//   enable <id>    PATCH /api/schedules/:id   {"enabled": true}
//   disable <id>   PATCH /api/schedules/:id   {"enabled": false}
//
// Exit codes (distinct on purpose, so a wrong outcome is visible to a script
// rather than silently swallowed — same convention as kookr-issue):
//   0  Success.
//   2  User error (bad flags, missing/blank schedule id).
//   3  No Kookr server reachable (or KOOKR_PORT invalid).
//   4  Server rejected the request (unknown id, capacity/drain, validation,
//      scheduling not configured, or any other non-2xx).

import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import {
  apiAuthHeaders,
  resolveBaseUrl,
  EXIT_OK,
  EXIT_USER_ERROR,
  EXIT_NO_SERVER,
  EXIT_SERVER_ERROR,
  CLI_VERSION,
} from './kookr-spawn.js';

const REQUEST_TIMEOUT_MS = 10_000;
const API_PATH = '/api/schedules';
const VERBS = new Set(['list', 'run', 'enable', 'disable']);

const HELP_TEXT = `kookr schedule — list / run / enable / disable schedules.

Usage:
  kookr schedule list [OPTIONS]
  kookr schedule run <id> [OPTIONS]
  kookr schedule enable <id> [OPTIONS]
  kookr schedule enable --stop-reason consecutive_failures [--held-before <ISO>] [OPTIONS]
  kookr schedule disable <id> [OPTIONS]

Options:
      --stop-reason <reason>   Bulk-recover all schedules parked by this
                               fail-closed auto-pause (only consecutive_failures
                               today). Use instead of a schedule <id> with enable.
      --held-before <ISO>      With --stop-reason, only recover holds established
                               before this ISO-8601 instant (e.g. a fix-commit
                               time). Legacy holds without a timestamp are included.
      --json     Print one machine-readable output envelope.
  -h, --help     Show this help.

Environment:
  KOOKR_API_BASE_URL   Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT            Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_API_TOKEN       Bearer token for non-loopback servers.

Exit codes:
  0  Success.
  2  User error (bad flags, missing schedule id).
  3  No Kookr server reachable (fail closed).
  4  Server rejected the request (unknown id, capacity/drain, validation).`;

class UsageError extends Error {}

function parseArgs(argv) {
  const out = { verb: null, id: null, json: false, help: false, stopReason: null, heldBefore: null };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok === '--stop-reason') {
      // Bulk-recovery selector (issue #2520): `enable --stop-reason <reason>`.
      const value = argv[++i];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError('--stop-reason requires a value (e.g. consecutive_failures)');
      }
      out.stopReason = value;
    } else if (tok.startsWith('--stop-reason=')) {
      out.stopReason = tok.slice('--stop-reason='.length);
    } else if (tok === '--held-before') {
      // Optional watermark (issue #2520): only recover holds set before <ISO>.
      const value = argv[++i];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError('--held-before requires an ISO-8601 timestamp value');
      }
      out.heldBefore = value;
    } else if (tok.startsWith('--held-before=')) {
      out.heldBefore = tok.slice('--held-before='.length);
    } else if (tok.startsWith('-')) {
      throw new UsageError(`unknown option: ${tok}`);
    } else if (out.verb === null) {
      out.verb = tok;
    } else if (out.id === null) {
      out.id = tok;
    } else {
      throw new UsageError(`unexpected argument: ${tok}`);
    }
  }
  return out;
}

function wantsJson(argv) {
  return argv.includes('--json');
}

function emitJson(out, { ok, code, message, details = {} }) {
  out.log(JSON.stringify({ ok, code, message, details }));
}

function exitJson({ out, exit, exitCode, ok, code, message, details }) {
  emitJson(out, { ok, code, message, details });
  return exit(exitCode);
}

// ---------- HTTP ----------

async function requestJson({ baseUrl, method, path, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const headers = {
    'X-Kookr-Launch-Source': 'cli',
    'User-Agent': `kookr-schedule/${CLI_VERSION} node/${process.versions.node}`,
    ...apiAuthHeaders(),
  };
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // fall through with json = null
  }
  return { status: res.status, json, text };
}

// One resolve+request cycle. Schedules are operator-invoked interactively, so
// (unlike kookr issue) there is no bounded retry loop — a single attempt keeps
// the tool responsive and its failure modes obvious.
async function attemptOnce({ env, invoke }) {
  const resolved = await resolveBaseUrl({ env });
  if (resolved.kind === 'invalid_port') {
    return { kind: 'invalid_port', raw: resolved.raw };
  }
  if (resolved.kind === 'ambiguous' || resolved.kind === 'none') {
    return { kind: 'unreachable' };
  }
  try {
    const result = await invoke(resolved.baseUrl);
    return { kind: 'ok', result, baseUrl: resolved.baseUrl };
  } catch (e) {
    return { kind: 'unreachable', error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- rendering ----------

function formatScheduleLine(schedule) {
  const id = schedule?.id ?? '?';
  const state = schedule?.enabled ? 'enabled ' : 'disabled';
  const name = schedule?.name ?? '(unnamed)';
  const cron = schedule?.cron ?? '?';
  const next = schedule?.nextRunAt ?? '-';
  let triggers = '';
  if (typeof schedule?.maxTriggers === 'number') {
    const remaining = typeof schedule.remainingTriggers === 'number' ? schedule.remainingTriggers : schedule.maxTriggers;
    triggers = `  triggers=${remaining}/${schedule.maxTriggers}`;
  }
  return `${id}  ${state}  ${name}  cron="${cron}"  next=${next}${triggers}`;
}

// ---------- shared error/edge-case shaping ----------

function userError({ args, out, err, exit, message }) {
  if (args.json) {
    return exitJson({
      out,
      exit,
      exitCode: EXIT_USER_ERROR,
      ok: false,
      code: 'USER_ERROR',
      message,
      details: { subcommand: 'schedule' },
    });
  }
  err.error(`kookr schedule: ${message}`);
  return exit(EXIT_USER_ERROR);
}

function invalidPort({ args, out, err, exit, raw }) {
  return userError({ args, out, err, exit, message: `KOOKR_PORT must be an integer in 1..65535 (got: ${raw})` });
}

const NO_SERVER_MESSAGE =
  'kookr schedule: no Kookr server reachable — start the server (or set KOOKR_PORT / KOOKR_API_BASE_URL).';

function noServer({ args, out, err, exit }) {
  if (args.json) {
    return exitJson({
      out,
      exit,
      exitCode: EXIT_NO_SERVER,
      ok: false,
      code: 'NO_SERVER',
      message: NO_SERVER_MESSAGE,
      details: { subcommand: 'schedule' },
    });
  }
  err.error(NO_SERVER_MESSAGE);
  return exit(EXIT_NO_SERVER);
}

function serverError({ args, out, err, exit, status, json, text }) {
  const detail = json?.error ?? (text || 'unknown error');
  const message = `server rejected the request (HTTP ${status}): ${detail}`;
  const details = { status };
  if (json?.code) details.code = json.code;
  if (args.json) {
    return exitJson({
      out,
      exit,
      exitCode: EXIT_SERVER_ERROR,
      ok: false,
      code: 'SERVER_ERROR',
      message,
      details,
    });
  }
  err.error(`kookr schedule: ${message}`);
  return exit(EXIT_SERVER_ERROR);
}

// ---------- verb handlers ----------

async function handleList({ args, env, out, err, exit }) {
  const outcome = await attemptOnce({ env, invoke: (baseUrl) => requestJson({ baseUrl, method: 'GET', path: API_PATH }) });
  if (outcome.kind === 'invalid_port') return invalidPort({ args, out, err, exit, raw: outcome.raw });
  if (outcome.kind === 'unreachable') return noServer({ args, out, err, exit });

  const { status, json, text } = outcome.result;
  if (status !== 200) return serverError({ args, out, err, exit, status, json, text });

  const schedules = Array.isArray(json?.schedules) ? json.schedules : [];
  const statusSnapshot = json?.status ?? {};
  if (args.json) {
    return exitJson({
      out,
      exit,
      exitCode: EXIT_OK,
      ok: true,
      code: 'OK',
      message: `${schedules.length} schedule(s).`,
      details: { schedules, status: statusSnapshot },
    });
  }
  // GET /api/schedules returns 200 with an empty list even when the schedule
  // subsystem is disabled (schedulerHealthy:false), so an empty result alone
  // can't distinguish "no schedules defined" from "scheduling not configured".
  // Surface the health signal on stderr so the empty state isn't misread.
  if (statusSnapshot.schedulerHealthy === false) {
    err.error('kookr schedule: warning — scheduler is not healthy or not configured; the list may be incomplete.');
  }
  if (schedules.length === 0) {
    out.log('No schedules.');
    return exit(EXIT_OK);
  }
  for (const schedule of schedules) out.log(formatScheduleLine(schedule));
  return exit(EXIT_OK);
}

async function handleRun({ args, env, out, err, exit }) {
  const id = resolveId(args.id);
  if (id === null) return userError({ args, out, err, exit, message: 'a schedule id is required (e.g. `kookr schedule run <id>`).' });

  const outcome = await attemptOnce({
    env,
    invoke: (baseUrl) => requestJson({ baseUrl, method: 'POST', path: `${API_PATH}/${encodeURIComponent(id)}/run` }),
  });
  if (outcome.kind === 'invalid_port') return invalidPort({ args, out, err, exit, raw: outcome.raw });
  if (outcome.kind === 'unreachable') return noServer({ args, out, err, exit });

  const { status, json, text } = outcome.result;
  if (status !== 200) return serverError({ args, out, err, exit, status, json, text });

  const taskId = json?.taskId ?? null;
  const queued = json?.queued === true;
  if (args.json) {
    return exitJson({
      out,
      exit,
      exitCode: EXIT_OK,
      ok: true,
      code: 'OK',
      message: 'Triggered.',
      details: { id, taskId, queued },
    });
  }
  let line = `✓ Triggered schedule ${id}`;
  if (taskId) line += ` — task ${taskId}`;
  if (queued) line += ' (queued)';
  out.log(line);
  return exit(EXIT_OK);
}

// Bulk-recover schedules parked by the fail-closed consecutive_failures
// auto-pause (issue #2520): `kookr schedule enable --stop-reason
// consecutive_failures [--held-before <ISO>]`. One operator action re-enables
// the whole set instead of one `enable <id>` per schedule.
async function handleBulkRecover({ args, env, out, err, exit }) {
  if (args.stopReason !== 'consecutive_failures') {
    return userError({
      args,
      out,
      err,
      exit,
      message: `--stop-reason must be "consecutive_failures" (got: ${args.stopReason}).`,
    });
  }
  const body = { stopReason: 'consecutive_failures' };
  if (args.heldBefore !== null) {
    if (Number.isNaN(Date.parse(args.heldBefore))) {
      return userError({ args, out, err, exit, message: `--held-before must be an ISO-8601 timestamp (got: ${args.heldBefore}).` });
    }
    body.heldBefore = args.heldBefore;
  }

  const outcome = await attemptOnce({
    env,
    invoke: (baseUrl) => requestJson({ baseUrl, method: 'POST', path: `${API_PATH}/recover`, body }),
  });
  if (outcome.kind === 'invalid_port') return invalidPort({ args, out, err, exit, raw: outcome.raw });
  if (outcome.kind === 'unreachable') return noServer({ args, out, err, exit });

  const { status, json, text } = outcome.result;
  if (status !== 200) return serverError({ args, out, err, exit, status, json, text });

  const recovered = Array.isArray(json?.recovered) ? json.recovered : [];
  const skipped = Array.isArray(json?.skipped) ? json.skipped : [];
  if (args.json) {
    return exitJson({
      out,
      exit,
      exitCode: EXIT_OK,
      ok: true,
      code: 'OK',
      message: `Recovered ${recovered.length} schedule(s).`,
      details: { recovered, skipped },
    });
  }
  if (recovered.length === 0) {
    out.log('No consecutive_failures holds to recover.');
  } else {
    out.log(`✓ Recovered ${recovered.length} consecutive_failures hold(s):`);
    for (const s of recovered) out.log(`  ${s.id}  ${s.name ?? '(unnamed)'}${s.heldAt ? `  heldAt=${s.heldAt}` : ''}`);
  }
  if (skipped.length > 0) {
    err.error(`kookr schedule: skipped ${skipped.length} schedule(s):`);
    for (const s of skipped) err.error(`  ${s.id}  ${s.name ?? '(unnamed)'}  (${s.reason})`);
  }
  return exit(EXIT_OK);
}

async function handleSetEnabled({ args, env, out, err, exit, enabled }) {
  const id = resolveId(args.id);
  const verb = enabled ? 'enable' : 'disable';
  if (id === null) return userError({ args, out, err, exit, message: `a schedule id is required (e.g. \`kookr schedule ${verb} <id>\`).` });

  const outcome = await attemptOnce({
    env,
    invoke: (baseUrl) => requestJson({ baseUrl, method: 'PATCH', path: `${API_PATH}/${encodeURIComponent(id)}`, body: { enabled } }),
  });
  if (outcome.kind === 'invalid_port') return invalidPort({ args, out, err, exit, raw: outcome.raw });
  if (outcome.kind === 'unreachable') return noServer({ args, out, err, exit });

  const { status, json, text } = outcome.result;
  if (status !== 200) return serverError({ args, out, err, exit, status, json, text });

  const name = json?.name ?? null;
  if (args.json) {
    return exitJson({
      out,
      exit,
      exitCode: EXIT_OK,
      ok: true,
      code: 'OK',
      message: enabled ? 'Enabled.' : 'Disabled.',
      details: { id, name, enabled: json?.enabled ?? enabled },
    });
  }
  const label = enabled ? 'Enabled' : 'Disabled';
  out.log(`✓ ${label} schedule ${id}${name ? ` (${name})` : ''}`);
  return exit(EXIT_OK);
}

function resolveId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

// ---------- entry point ----------

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  out = console,
  err = console,
  exit = process.exit,
} = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      if (wantsJson(argv)) {
        return exitJson({
          out,
          exit,
          exitCode: EXIT_USER_ERROR,
          ok: false,
          code: 'USER_ERROR',
          message: e.message,
          details: { subcommand: 'schedule' },
        });
      }
      err.error(`kookr schedule: ${e.message}`);
      err.error('Try --help.');
      return exit(EXIT_USER_ERROR);
    }
    throw e;
  }

  if (args.help) {
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_OK,
        ok: true,
        code: 'OK',
        message: 'Help',
        details: { help: HELP_TEXT },
      });
    }
    out.log(HELP_TEXT);
    return exit(EXIT_OK);
  }

  if (args.verb === null) {
    return userError({ args, out, err, exit, message: 'a verb is required (list, run, enable, disable).' });
  }
  if (!VERBS.has(args.verb)) {
    return userError({ args, out, err, exit, message: `unknown verb "${args.verb}". Known verbs: ${[...VERBS].join(', ')}.` });
  }

  if (args.verb === 'list') return handleList({ args, env, out, err, exit });
  if (args.verb === 'run') return handleRun({ args, env, out, err, exit });
  if (args.verb === 'enable') {
    // Bulk-recovery form (issue #2520): `enable --stop-reason <reason>` with no
    // id re-enables every matching hold. A `--stop-reason` with an explicit id
    // is contradictory — reject rather than silently ignore the selector.
    if (args.stopReason !== null) {
      if (resolveId(args.id) !== null) {
        return userError({ args, out, err, exit, message: 'give either a schedule <id> or --stop-reason, not both.' });
      }
      return handleBulkRecover({ args, env, out, err, exit });
    }
    return handleSetEnabled({ args, env, out, err, exit, enabled: true });
  }
  if (args.stopReason !== null || args.heldBefore !== null) {
    return userError({ args, out, err, exit, message: `--stop-reason / --held-before are only valid with "enable".` });
  }
  return handleSetEnabled({ args, env, out, err, exit, enabled: false });
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
    console.error(`kookr schedule: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

export {
  HELP_TEXT,
  UsageError,
  parseArgs,
  resolveId,
  requestJson,
  formatScheduleLine,
  main,
};
