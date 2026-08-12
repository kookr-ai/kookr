#!/usr/bin/env node
// kookr signal — raise a non-blocking agent → user signal for the current task
// (RFC: rfc-agent-signal-surface). Durable outbox: issue #1541.
//
// Usage:
//   kookr signal completion-ready
//   kookr signal completion-ready --json
//   kookr signal completion-ready --note "tests green, PR #812 opened"
//   kookr signal completion-ready --task-id <uuid>
//
// The agent proposes; the user disposes. This NEVER completes the task — it
// raises a hint that Kookr surfaces (e.g. highlighting the Complete button).
// Addressed to the agent's own task via KOOKR_TASK_ID (auto-injected into every
// managed task) unless --task-id overrides it.
//
// Contract: POST {base}/api/tasks/:id/signal with JSON { kind, note?, signalId }.
//
// Durability (issue #1541): every signal is write-behined to a local outbox
// BEFORE the HTTP attempt. On connection/timeout failure the CLI exits 0
// (signal is durably queued) so agents never burn their final turn reporting a
// transient daemon outage. A background server drain + opportunistic CLI drain
// flushes the spool when the daemon is reachable again; the server dedups by
// signalId.
//
// Exit codes (distinct on purpose, so a wrong KOOKR_TASK_ID is visible to the
// agent rather than silently swallowed):
//   0  Signal raised OR durably spooled for later delivery.
//   2  User error (bad flags, unknown kind, missing task id).
//   3  Reserved (legacy NO_SERVER). No longer returned for unreachable
//      daemons once the outbox is available — see exit 0 + spooled.
//   4  Server rejected the signal (unknown/terminal task, bad request).

import { pathToFileURL } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  apiAuthHeaders,
  resolveBaseUrl,
  EXIT_OK,
  EXIT_USER_ERROR,
  EXIT_NO_SERVER,
  EXIT_SERVER_ERROR,
  CLI_VERSION,
} from './kookr-spawn.js';
import {
  readRestartIntent,
  resolveKookrDir,
  firstRestartIntentAcrossPorts,
  describeUnreachableCause,
  restartIntentJson,
} from './kookr-restart-intent.js';

// Ports `kookr-status` and `resolveBaseUrl` sweep when no explicit port is set.
const RESTART_INTENT_PORTS = [4800, 4801];

/** Best-effort port from a resolved base URL (e.g. http://127.0.0.1:4801). */
function portFromBaseUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.port) return Number(parsed.port);
  } catch {
    // fall through
  }
  return undefined;
}

const POST_TIMEOUT_MS = 10_000;
const here = dirname(fileURLToPath(import.meta.url));

// Accept the hook-safe hyphenated form on the CLI and normalize to the wire
// enum. Bare arguments (no shell metacharacters) sidestep PreToolUse command
// scanning the way `kookr spawn --prompt-file` does.
const KIND_ALIASES = new Map([
  ['completion-ready', 'completion_ready'],
  ['completion_ready', 'completion_ready'],
]);

const HELP_TEXT = `kookr signal — raise a non-blocking agent → user signal for the current task.

Usage:
  kookr signal <kind> [OPTIONS]

Kinds:
  completion-ready   Tell the user you believe this task is ready to complete.

Options:
      --note <text>      Optional note. The server best-effort secret-scrubs it
                         and visibly truncates over-limit notes.
      --task-id <uuid>   Target task (default: KOOKR_TASK_ID).
      --json             Print one machine-readable output envelope.
  -h, --help             Show this help.

Environment:
  KOOKR_TASK_ID              Current task id (auto-injected into managed tasks).
  KOOKR_API_BASE_URL         Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT                 Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_SIGNAL_OUTBOX_DIR    Override the durable outbox directory
                             (default: ~/.kookr/playbook-state/signal-outbox).

Exit codes:
  0  Signal raised, or durably spooled because the daemon was unreachable.
  2  User error (bad flags, unknown kind, missing task id).
  4  Server rejected the signal (unknown/terminal task).

When the daemon is down the signal is written to the local outbox and this
command still exits 0 so agents do not burn a turn on a connection error. A
background drain delivers it after the daemon restarts (issue #1541).`;

class UsageError extends Error {}

function parseArgs(argv) {
  const out = { kind: null, note: null, taskId: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const eat = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`option ${tok} requires a value`);
      return v;
    };
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok === '--note') {
      out.note = eat();
    } else if (tok.startsWith('--note=')) {
      out.note = tok.slice('--note='.length);
    } else if (tok === '--task-id') {
      out.taskId = eat();
    } else if (tok.startsWith('--task-id=')) {
      out.taskId = tok.slice('--task-id='.length);
    } else if (tok.startsWith('-')) {
      throw new UsageError(`unknown option: ${tok}`);
    } else if (out.kind === null) {
      out.kind = tok;
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

function resolveTaskId({ args, env }) {
  const raw = args.taskId ?? env.KOOKR_TASK_ID;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** Load the TypeScript/compiled signal-outbox module (dist preferred). */
async function loadOutboxModule() {
  const dist = join(here, '..', 'dist', 'core', 'signal-outbox.js');
  if (existsSync(dist)) {
    return import(pathToFileURL(dist).href);
  }
  const src = join(here, '..', 'src', 'core', 'signal-outbox.ts');
  if (existsSync(src)) {
    return import(pathToFileURL(src).href);
  }
  throw new Error(
    'signal outbox module not found. Run `pnpm build:server` first.',
  );
}

async function postSignal({ baseUrl, taskId, kind, note, signalId }) {
  const body = { kind, signalId };
  if (note) body.note = note;
  const res = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/signal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Kookr-Launch-Source': 'cli',
      'User-Agent': `kookr-signal/${CLI_VERSION} node/${process.versions.node}`,
      ...apiAuthHeaders(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // fall through
  }
  if (!res.ok) {
    return {
      kind: 'rejected',
      status: res.status,
      message: json?.error ?? (text || `HTTP ${res.status}`),
      code: typeof json?.code === 'string' ? json.code : undefined,
      hint: typeof json?.hint === 'string' ? json.hint : undefined,
      decision: typeof json?.decision === 'string' ? json.decision : undefined,
    };
  }
  return {
    kind: 'ok',
    truncated: json?.truncated === true,
    idempotentReplay: json?.idempotentReplay === true,
  };
}

/**
 * Classify a server rejection as permanent (drop from outbox) vs unexpected.
 * 404 / 409 are permanent for this signalId; 4xx validation is permanent too.
 * 5xx is treated as transient so a later drain retries.
 */
function isPermanentRejection(status) {
  return status >= 400 && status < 500;
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  out = console,
  err = console,
  exit = process.exit,
  sleep,
  /** Test seam: inject a pre-loaded outbox module. */
  outboxModule,
  /** Test seam: override spool dir without env. */
  spoolDir: spoolDirOverride,
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
          details: { subcommand: 'signal' },
        });
      }
      err.error(`kookr signal: ${e.message}`);
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

  if (args.kind === null) {
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_USER_ERROR,
        ok: false,
        code: 'USER_ERROR',
        message: 'a kind is required (e.g. `kookr signal completion-ready`).',
        details: { subcommand: 'signal' },
      });
    }
    err.error('kookr signal: a kind is required (e.g. `kookr signal completion-ready`).');
    return exit(EXIT_USER_ERROR);
  }
  const kind = KIND_ALIASES.get(args.kind);
  if (!kind) {
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_USER_ERROR,
        ok: false,
        code: 'USER_ERROR',
        message: `unknown kind "${args.kind}". Known kinds: ${[...KIND_ALIASES.keys()].join(', ')}.`,
        details: { subcommand: 'signal' },
      });
    }
    err.error(`kookr signal: unknown kind "${args.kind}". Known kinds: ${[...KIND_ALIASES.keys()].join(', ')}.`);
    return exit(EXIT_USER_ERROR);
  }

  const taskId = resolveTaskId({ args, env });
  if (!taskId) {
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_USER_ERROR,
        ok: false,
        code: 'USER_ERROR',
        message: 'no task id. Set KOOKR_TASK_ID (auto-injected into managed tasks) or pass --task-id.',
        details: { subcommand: 'signal' },
      });
    }
    err.error('kookr signal: no task id. Set KOOKR_TASK_ID (auto-injected into managed tasks) or pass --task-id.');
    return exit(EXIT_USER_ERROR);
  }

  let note = null;
  if (args.note !== null) {
    const trimmed = args.note.trim();
    if (trimmed) note = trimmed;
  }

  // --- Durable outbox: enqueue BEFORE any network attempt (issue #1541). ---
  let outbox;
  try {
    outbox = outboxModule ?? await loadOutboxModule();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_USER_ERROR,
        ok: false,
        code: 'USER_ERROR',
        message: `signal outbox unavailable: ${message}`,
        details: { subcommand: 'signal' },
      });
    }
    err.error(`kookr signal: signal outbox unavailable: ${message}`);
    return exit(EXIT_USER_ERROR);
  }

  const spoolDir = spoolDirOverride
    ?? outbox.defaultSignalOutboxDir(env);
  const signalId = randomUUID();
  const entry = outbox.buildSignalOutboxEntry({
    signalId,
    taskId,
    kind,
    ...(note ? { note } : {}),
  });
  try {
    await outbox.appendSignalOutbox(spoolDir, entry);
  } catch (e) {
    // Spool write failure is rare (disk full / permissions). Fall through to
    // best-effort live delivery so a healthy daemon still receives the signal,
    // but report the spool problem when delivery also fails.
    err.error?.(
      `kookr signal: warning: could not write outbox (${e instanceof Error ? e.message : e}); attempting live delivery only`,
    );
  }

  let resolved;
  try {
    resolved = await resolveBaseUrl({ env, ...(sleep ? { sleep } : {}) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_USER_ERROR,
        ok: false,
        code: 'USER_ERROR',
        message,
        details: { subcommand: 'signal' },
      });
    }
    err.error(`kookr signal: ${message}`);
    return exit(EXIT_USER_ERROR);
  }
  if (resolved.kind === 'invalid_port') {
    const message = `KOOKR_PORT must be an integer in 1..65535 (got: ${resolved.raw})`;
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_USER_ERROR,
        ok: false,
        code: 'USER_ERROR',
        message,
        details: { subcommand: 'signal' },
      });
    }
    err.error(`kookr signal: ${message}`);
    return exit(EXIT_USER_ERROR);
  }

  // No server / ambiguous: signal is already spooled → exit 0 (not 3).
  if (resolved.kind === 'ambiguous' || resolved.kind === 'none') {
    // Issue #2410: tell the agent WHY the daemon is unreachable — a planned
    // redeploy (marker present) vs an unexpected outage (no marker). No explicit
    // port was resolved here, so scan the same ports the base-URL sweep would
    // (mirrors `kookr status`) rather than assuming 4800.
    const found = firstRestartIntentAcrossPorts(RESTART_INTENT_PORTS, { env });
    const intent = found?.intent ?? null;
    const cause = describeUnreachableCause(intent);
    const message =
      `no Kookr server reachable; signal durably spooled for delivery on reconnect. ${cause}`;
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_OK,
        ok: true,
        code: 'SPOOLED',
        message,
        details: {
          subcommand: 'signal',
          signalId,
          spooled: true,
          spoolDir,
          restartIntent: restartIntentJson(intent),
        },
      });
    }
    out.log(
      `✓ Signal spooled (${kind}) for task ${taskId} — daemon unreachable; will deliver on reconnect.\n  ${cause}`,
    );
    return exit(EXIT_OK);
  }

  const baseUrl = resolved.baseUrl;

  let result;
  try {
    result = await postSignal({ baseUrl, taskId, kind, note, signalId });
  } catch (e) {
    // Transient network/timeout: leave in spool, exit 0. Issue #2410: enrich
    // with the planned-restart-vs-unexpected-outage verdict, reading the marker
    // for the port we actually targeted (from resolved.baseUrl), not a guess.
    const intent = readRestartIntent(resolveKookrDir({ port: portFromBaseUrl(baseUrl), env }));
    const cause = describeUnreachableCause(intent);
    const message =
      `daemon unreachable (${e instanceof Error ? e.message : String(e)}); `
      + `signal durably spooled for delivery on reconnect. ${cause}`;
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_OK,
        ok: true,
        code: 'SPOOLED',
        message,
        details: {
          subcommand: 'signal',
          signalId,
          spooled: true,
          spoolDir,
          restartIntent: restartIntentJson(intent),
        },
      });
    }
    out.log(`✓ Signal spooled (${kind}) for task ${taskId} — ${message}`);
    return exit(EXIT_OK);
  }

  if (result.kind === 'rejected') {
    if (isPermanentRejection(result.status)) {
      // Drop from outbox so we don't retry a doomed signal forever.
      // Includes lesson_decision_required (409) — agent must emit a decision
      // then re-signal; retrying the same outbox entry would loop forever.
      try {
        await outbox.removeSignalOutboxEntry(spoolDir, signalId);
      } catch {
        // ignore
      }
      const message = `server rejected the signal (HTTP ${result.status}): ${result.message}`;
      // lesson_decision_required = logs present, no decision; hooks_missing =
      // every session log gone (prune/rotation) — both block completion-ready.
      const isLessonGate =
        result.code === 'lesson_decision_required'
        || result.code === 'lesson_decision_hooks_missing';
      const isHooksMissing = result.code === 'lesson_decision_hooks_missing';
      if (args.json) {
        return exitJson({
          out,
          exit,
          exitCode: EXIT_SERVER_ERROR,
          ok: false,
          code: isHooksMissing
            ? 'LESSON_DECISION_HOOKS_MISSING'
            : isLessonGate
              ? 'LESSON_DECISION_REQUIRED'
              : 'SERVER_ERROR',
          message,
          details: {
            status: result.status,
            signalId,
            ...(result.code ? { serverCode: result.code } : {}),
            ...(result.hint ? { hint: result.hint } : {}),
            ...(result.decision ? { decision: result.decision } : {}),
          },
        });
      }
      err.error(`kookr signal: server rejected the signal (HTTP ${result.status}): ${result.message}`);
      if (isLessonGate) {
        if (result.hint) err.error(result.hint);
        if (isHooksMissing) {
          err.error(
            'All session hook logs are missing (issue #1868) — check prune/rotation under '
              + '~/.kookr/hooks, re-emit a lesson decision into a live shell trail, then re-run.',
          );
        } else {
          err.error(
            'Post-task lesson decision is required before completion-ready (issue #1538). '
              + 'Write a lesson with `kb remember` or print '
              + '`No generic KB lesson: <reason>`, then re-run this command.',
          );
        }
      } else {
        err.error('Your KOOKR_TASK_ID may be wrong or the task may already be finished.');
      }
      return exit(EXIT_SERVER_ERROR);
    }
    // 5xx: keep in spool, exit 0.
    const message =
      `server error (HTTP ${result.status}); signal kept in outbox for retry.`;
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_OK,
        ok: true,
        code: 'SPOOLED',
        message,
        details: { subcommand: 'signal', signalId, spooled: true, status: result.status },
      });
    }
    out.log(`✓ Signal spooled (${kind}) for task ${taskId} — ${message}`);
    return exit(EXIT_OK);
  }

  // Delivered — remove this entry, then opportunistically drain siblings.
  try {
    await outbox.removeSignalOutboxEntry(spoolDir, signalId);
  } catch {
    // ignore; server already has the signal (idempotent by signalId)
  }
  try {
    await outbox.drainSignalOutbox({
      spoolDir,
      deliver: async (pending) => {
        try {
          const r = await postSignal({
            baseUrl: pending.baseUrl ?? baseUrl,
            taskId: pending.taskId,
            kind: pending.kind,
            note: pending.note,
            signalId: pending.signalId,
          });
          if (r.kind === 'ok') return { outcome: 'delivered' };
          if (isPermanentRejection(r.status)) {
            return { outcome: 'permanent_fail', error: r.message };
          }
          return { outcome: 'transient_fail', error: r.message };
        } catch (e) {
          return {
            outcome: 'transient_fail',
            error: e instanceof Error ? e.message : String(e),
          };
        }
      },
    });
  } catch {
    // Opportunistic drain failure must not fail the primary signal.
  }

  if (args.json) {
    return exitJson({
      out,
      exit,
      exitCode: EXIT_OK,
      ok: true,
      code: 'OK',
      message: result.idempotentReplay ? 'Signal already recorded (idempotent replay).' : 'Signal raised.',
      details: {
        truncated: result.truncated,
        signalId,
        ...(result.idempotentReplay ? { idempotentReplay: true } : {}),
      },
    });
  }
  out.log(`✓ Signal raised: ${kind}${note ? ` (note attached)` : ''} for task ${taskId}`);
  if (result.truncated) {
    out.log('Note was truncated by the server; shorten and re-signal if important detail was omitted.');
  }
  return exit(EXIT_OK);
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
    console.error(`kookr signal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

export {
  HELP_TEXT,
  UsageError,
  parseArgs,
  resolveTaskId,
  postSignal,
  main,
  // Re-export so tests can still reference the legacy constant if needed.
  EXIT_NO_SERVER,
};
