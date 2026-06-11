#!/usr/bin/env node
// kookr signal — raise a non-blocking agent → user signal for the current task
// (RFC: rfc-agent-signal-surface).
//
// Usage:
//   kookr signal completion-ready
//   kookr signal completion-ready --note "tests green, PR #812 opened"
//   kookr signal completion-ready --task-id <uuid>
//
// The agent proposes; the user disposes. This NEVER completes the task — it
// raises a hint that Kookr surfaces (e.g. highlighting the Complete button).
// Addressed to the agent's own task via KOOKR_TASK_ID (auto-injected into every
// managed task) unless --task-id overrides it.
//
// Contract: POST {base}/api/tasks/:id/signal with JSON { kind, note? }.
//
// Exit codes (distinct on purpose, so a wrong KOOKR_TASK_ID is visible to the
// agent rather than silently swallowed):
//   0  Signal raised.
//   2  User error (bad flags, unknown kind, missing task id).
//   3  No Kookr server reachable (advisory — the caller may ignore and continue).
//   4  Server rejected the signal (unknown/terminal task, bad request).

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

const POST_TIMEOUT_MS = 10_000;

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
  -h, --help             Show this help.

Environment:
  KOOKR_TASK_ID        Current task id (auto-injected into managed tasks).
  KOOKR_API_BASE_URL   Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT           Specific port on 127.0.0.1 (overrides auto-detect).

Exit codes:
  0  Signal raised.
  2  User error (bad flags, unknown kind, missing task id).
  3  No Kookr server reachable.
  4  Server rejected the signal (unknown/terminal task).`;

class UsageError extends Error {}

function parseArgs(argv) {
  const out = { kind: null, note: null, taskId: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const eat = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`option ${tok} requires a value`);
      return v;
    };
    if (tok === '-h' || tok === '--help') {
      out.help = true;
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

function resolveTaskId({ args, env }) {
  const raw = args.taskId ?? env.KOOKR_TASK_ID;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

async function postSignal({ baseUrl, taskId, kind, note }) {
  const body = { kind };
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
    return { kind: 'rejected', status: res.status, message: json?.error ?? (text || `HTTP ${res.status}`) };
  }
  return { kind: 'ok', truncated: json?.truncated === true };
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  out = console,
  err = console,
  exit = process.exit,
  sleep,
} = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      err.error(`kookr signal: ${e.message}`);
      err.error('Try --help.');
      return exit(EXIT_USER_ERROR);
    }
    throw e;
  }
  if (args.help) {
    out.log(HELP_TEXT);
    return exit(EXIT_OK);
  }

  if (args.kind === null) {
    err.error('kookr signal: a kind is required (e.g. `kookr signal completion-ready`).');
    return exit(EXIT_USER_ERROR);
  }
  const kind = KIND_ALIASES.get(args.kind);
  if (!kind) {
    err.error(`kookr signal: unknown kind "${args.kind}". Known kinds: ${[...KIND_ALIASES.keys()].join(', ')}.`);
    return exit(EXIT_USER_ERROR);
  }

  const taskId = resolveTaskId({ args, env });
  if (!taskId) {
    err.error('kookr signal: no task id. Set KOOKR_TASK_ID (auto-injected into managed tasks) or pass --task-id.');
    return exit(EXIT_USER_ERROR);
  }

  let note = null;
  if (args.note !== null) {
    const trimmed = args.note.trim();
    if (trimmed) note = trimmed;
  }

  let resolved;
  try {
    resolved = await resolveBaseUrl({ env, ...(sleep ? { sleep } : {}) });
  } catch (e) {
    err.error(`kookr signal: ${e instanceof Error ? e.message : String(e)}`);
    return exit(EXIT_USER_ERROR);
  }
  if (resolved.kind === 'invalid_port') {
    err.error(`kookr signal: KOOKR_PORT must be an integer in 1..65535 (got: ${resolved.raw})`);
    return exit(EXIT_USER_ERROR);
  }
  if (resolved.kind === 'ambiguous' || resolved.kind === 'none') {
    // Advisory: signaling is best-effort. The agent should NOT fail its task
    // because the dashboard server happens to be unreachable.
    err.error('kookr signal: no Kookr server reachable; skipping (advisory, not a task failure).');
    return exit(EXIT_NO_SERVER);
  }

  const baseUrl = resolved.baseUrl;
  let result;
  try {
    result = await postSignal({ baseUrl, taskId, kind, note });
  } catch (e) {
    err.error(`kookr signal: request failed: ${e instanceof Error ? e.message : String(e)} (advisory)`);
    return exit(EXIT_NO_SERVER);
  }

  if (result.kind === 'rejected') {
    err.error(`kookr signal: server rejected the signal (HTTP ${result.status}): ${result.message}`);
    err.error('Your KOOKR_TASK_ID may be wrong or the task may already be finished.');
    return exit(EXIT_SERVER_ERROR);
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

export { HELP_TEXT, UsageError, parseArgs, resolveTaskId, postSignal, main };
