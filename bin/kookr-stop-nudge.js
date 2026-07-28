#!/usr/bin/env node
// kookr-stop-nudge — advisory Stop-hook nudge (RFC: rfc-agent-signal-surface §7).
//
// Reminds an agent, at most once per task, that it can raise an explicit
// completion signal (`kookr signal completion-ready`) IF it believes the whole
// Kookr task is finished. It NEVER decides completion and NEVER raises a signal
// itself — a clean Stop is not a reliable proxy for task completion, so the
// agent judges in every case.
//
// HARD FAIL-OPEN: every code path exits 0, including on uncaught errors or any
// inability to verify state. A non-zero Stop-hook exit becomes a StopFailure,
// which Kookr maps to `blocked` — trapping the agent and suppressing Complete.
// The nudge must never be able to do that. The ONLY non-trivial output is a
// single `{"decision":"block","reason":...}` line on the fully-qualified path.
//
// Loop-safety: the Stop payload's `stop_hook_active` flag (true when the agent
// is already continuing because of a stop hook) plus a durable per-task marker
// guarantee at most one extra turn per task.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STDIN_TIMEOUT_MS = 2000;
const API_TIMEOUT_MS = 2500;
const DEFAULT_MIN_TASK_AGE_MS = 45_000;
const KILL_MARKER = '/dev/shm/.kookr-nudge-disabled';

const NUDGE_REASON =
  'If you consider this Kookr task fully complete and ready to be closed: first emit a '
  + 'post-task lesson decision in the Bash hook trail '
  + '(`kb remember --kb=agent-task-lessons …` OR '
  + '`printf \'No generic KB lesson: %s\\n\' \'<reason>\'`), then run '
  + '`kookr signal completion-ready` (optionally with --note "..."). '
  + 'Completion-ready is rejected without that decision (issue #1538). The user will then '
  + 'review and complete it. If there is more to do — or this is just a turn boundary, '
  + 'not the end of the task — simply continue or stop as you judge. '
  + 'This reminder fires at most once per task.';

/** Exit 0 always. Optionally emit a block decision first. */
function done(block) {
  if (block) {
    try {
      // Exit only after the pipe flushes — process.exit() before the async
      // write completes truncates the block decision on a pipe. A backstop
      // timer guarantees we still exit if the flush callback never fires.
      const backstop = setTimeout(() => process.exit(0), 1500);
      if (backstop.unref) backstop.unref();
      process.stdout.write(JSON.stringify({ decision: 'block', reason: NUDGE_REASON }), () => process.exit(0));
      return;
    } catch {
      // fall through to a plain exit — never escalate to a non-zero exit
    }
  }
  process.exit(0);
}

function markerDir() {
  return join(homedir(), '.kookr', 'stop-nudge');
}

function markerPath(taskId) {
  // Sanitize so a hostile/odd task id can't escape the marker dir.
  const safe = String(taskId).replace(/[^A-Za-z0-9_-]/g, '_');
  return join(markerDir(), safe);
}

function resolveBaseUrl(env) {
  const explicit = env.KOOKR_API_BASE_URL && env.KOOKR_API_BASE_URL.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const port = env.KOOKR_PORT && env.KOOKR_PORT.trim();
  if (port && /^\d+$/.test(port)) return `http://127.0.0.1:${port}`;
  return null;
}

async function readStdin() {
  return await new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(data), STDIN_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    try {
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', () => {
        clearTimeout(timer);
        finish(data);
      });
      process.stdin.on('error', () => {
        clearTimeout(timer);
        finish(data);
      });
    } catch {
      clearTimeout(timer);
      finish(data);
    }
  });
}

function isTerminalStatus(status) {
  return status === 'completed' || status === 'cancelled' || status === 'terminated';
}

async function fetchTask(baseUrl, taskId) {
  // No single-task GET endpoint exists; read the list and find ours.
  const res = await fetch(`${baseUrl}/api/tasks`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) return null;
  const list = await res.json();
  if (!Array.isArray(list)) return null;
  return list.find((t) => t && t.id === taskId) ?? null;
}

async function main(env = process.env) {
  // 1. Runtime kill switch (env: spawn-time; file marker: in-flight).
  if (env.KOOKR_NUDGE_DISABLED && env.KOOKR_NUDGE_DISABLED !== '0' && env.KOOKR_NUDGE_DISABLED !== 'false') {
    return done(false);
  }
  try {
    if (existsSync(KILL_MARKER)) return done(false);
  } catch {
    // ignore
  }

  // 2. Loop-safety: never re-block while already continuing from a stop hook.
  const raw = await readStdin();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return done(false);
  }
  if (payload && payload.stop_hook_active === true) return done(false);

  // 3. Must be a managed task.
  const taskId = env.KOOKR_TASK_ID && env.KOOKR_TASK_ID.trim();
  if (!taskId) return done(false);

  // 4. At most once per task (durable marker survives restart).
  const mark = markerPath(taskId);
  try {
    if (existsSync(mark)) return done(false);
  } catch {
    return done(false);
  }

  // 5. Verify state via the API. If we can't verify, never nudge blind.
  const baseUrl = resolveBaseUrl(env);
  if (!baseUrl) return done(false);
  let task;
  try {
    task = await fetchTask(baseUrl, taskId);
  } catch {
    return done(false);
  }
  if (!task) return done(false);
  if (isTerminalStatus(task.status)) return done(false);
  if (task.pendingSignal) return done(false); // already signaled — nothing to remind

  // 6. Minimal activity gate: don't spend the one nudge on a trivial first stop.
  const minAgeMs = parseMinAge(env.KOOKR_NUDGE_MIN_TASK_AGE_MS);
  const createdAt = task.createdAt ? new Date(task.createdAt).getTime() : NaN;
  if (Number.isFinite(createdAt) && Date.now() - createdAt < minAgeMs) {
    return done(false);
  }

  // 7. Commit the once-per-task marker BEFORE blocking. If we can't persist it,
  // don't block — re-nudging on every stop is worse than missing one nudge.
  try {
    mkdirSync(markerDir(), { recursive: true });
    writeFileSync(mark, new Date().toISOString(), { flag: 'wx' });
  } catch {
    return done(false);
  }

  return done(true);
}

function parseMinAge(raw) {
  if (raw === undefined || raw === '') return DEFAULT_MIN_TASK_AGE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_TASK_AGE_MS;
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
  // Backstop: any unanticipated error or rejection still exits 0 (no block).
  process.on('uncaughtException', () => done(false));
  process.on('unhandledRejection', () => done(false));
  main().catch(() => done(false));
}

export { resolveBaseUrl, markerPath, isTerminalStatus, parseMinAge, NUDGE_REASON, done, main };
