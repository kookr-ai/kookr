#!/usr/bin/env node
// kookr issue — claim/release/inspect issue ownership (RFC:
// rfc-issue-ownership-lock.md §5, R15, R25, R26).
//
// Usage:
//   kookr issue claim <number> [--repo <r>] [--force] [--json]
//   kookr issue release <number> [--repo <r>] [--json]
//   kookr issue owner <number> [--repo <r>] [--json]
//   kookr issue list [--json]
//
// Thin HTTP client against `${base}/api/issue-claims` (same pattern as
// bin/kookr-signal.js). Server owns atomicity, repo resolution, and the
// decorated owner view (doing/lastActivityAt/ageMs); this CLI just renders it.
//
// Exit codes (distinct on purpose, so a wrong outcome is visible to the
// caller rather than silently swallowed — same convention as kookr-signal):
//   0  You own it (granted, re-entrant, post-force), or the server does not
//      support issue claims yet (R26: proceed as pre-lock, not an error).
//   2  User error (bad flags, missing issue number, missing task id, server
//      rejected the request as malformed).
//   3  No Kookr server reachable (R25: bounded fail-closed park).
//   4  Server rejected the request (e.g. release by a non-owner).
//   5  Reserved (prompt-hash dedupe, kookr-spawn).
//   6  Claim held by another live task (R15).

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

// 5 is reserved for spawn dedupe (EXIT_DUPLICATE_BLOCKED in kookr-spawn.js).
const EXIT_CLAIM_HELD = 6;

const REQUEST_TIMEOUT_MS = 10_000;
const API_PATH = '/api/issue-claims';
const VERBS = new Set(['claim', 'release', 'owner', 'list']);
// R25: bounded fail-closed — retry the resolve+request pipeline up to 3
// times (claim/release only) with this backoff, matching the RFC's "~3
// tries" language. list/owner are read-only and give up after one try.
const RETRY_DELAYS_MS = [1000, 3000, 9000];

const HELP_TEXT = `kookr issue — claim/release/inspect issue ownership.

Usage:
  kookr issue claim <number> [OPTIONS]
  kookr issue release <number> [OPTIONS]
  kookr issue owner <number> [OPTIONS]
  kookr issue list [OPTIONS]

Options:
      --repo <owner/repo>   Issue's home repo. Optional; the server resolves
                             it from cwd when omitted.
      --force                Operator override: take over a held claim
                             (claim only; not for autonomous use).
      --task-id <uuid>       Task id (default: KOOKR_TASK_ID). Required for
                             claim/release.
      --json                 Print one machine-readable output envelope.
  -h, --help                 Show this help.

Environment:
  KOOKR_TASK_ID         Current task id (auto-injected into managed tasks).
  KOOKR_AGENT_ID         Current session id, sent as sessionId on claim.
  KOOKR_API_BASE_URL     Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT             Specific port on 127.0.0.1 (overrides auto-detect).

Exit codes:
  0  You own it (granted, re-entrant, or post-force), or the server does not
     support issue claims yet (proceeding as pre-lock is safe).
  2  User error: bad flags, missing issue number/task id, or the server
     rejected the request as malformed.
  3  No Kookr server reachable — treat ownership as unverifiable, do not
     start work (fail closed).
  4  Server rejected the request (e.g. release by a non-owner).
  5  Reserved (prompt-hash dedupe, kookr-spawn).
  6  Claim held by another live task — pick a different issue, or
     --force to override as an operator.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const out = { verb: null, number: null, repo: null, force: false, taskId: null, json: false, help: false };
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
    } else if (tok === '--force') {
      out.force = true;
    } else if (tok === '--repo') {
      out.repo = eat();
    } else if (tok.startsWith('--repo=')) {
      out.repo = tok.slice('--repo='.length);
    } else if (tok === '--task-id') {
      out.taskId = eat();
    } else if (tok.startsWith('--task-id=')) {
      out.taskId = tok.slice('--task-id='.length);
    } else if (tok.startsWith('-')) {
      throw new UsageError(`unknown option: ${tok}`);
    } else if (out.verb === null) {
      out.verb = tok;
    } else if (out.number === null) {
      out.number = tok;
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

function resolveSessionId(env) {
  const raw = env.KOOKR_AGENT_ID;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function parseIssueNumber(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- HTTP ----------

async function requestJson({ baseUrl, method, query, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const qs = query ? `?${query}` : '';
  const headers = {
    'X-Kookr-Launch-Source': 'cli',
    'User-Agent': `kookr-issue/${CLI_VERSION} node/${process.versions.node}`,
    ...apiAuthHeaders(),
  };
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${API_PATH}${qs}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // fall through with json = null
  }
  return { status: res.status, json, text };
}

// One resolve+request cycle. Any resolveBaseUrl outcome other than
// explicit/auto, or a thrown fetch, counts as "unreachable" for retry
// purposes (R25). An invalid KOOKR_PORT is a user error, not retried.
async function attemptOnce({ env, sleep, invoke }) {
  const resolved = await resolveBaseUrl({ env, sleep });
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

async function withRetries({ env, sleep, invoke, maxRetries }) {
  let last;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
    last = await attemptOnce({ env, sleep, invoke });
    if (last.kind !== 'unreachable') return last;
  }
  return last;
}

// ---------- rendering ----------

function humanizeMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

function formatAge(owner) {
  if (typeof owner?.ageMs === 'number' && Number.isFinite(owner.ageMs)) {
    return humanizeMs(owner.ageMs);
  }
  if (owner?.lastActivityAt) {
    const ms = Date.now() - new Date(owner.lastActivityAt).getTime();
    if (Number.isFinite(ms) && ms >= 0) return humanizeMs(ms);
  }
  return null;
}

// R15: taskId, sessionId, ownerStatus, ownerName, worktreePath, doing,
// lastActivityAt — field names match the server's ClaimOwnerRecord
// (src/core/issue-claim-types.ts) as decorated by issue-claim-decorator.ts.
function formatOwnerBlock({ repo, number, owner }) {
  const repoLabel = repo ?? owner.repo ?? '(unknown repo)';
  const lines = [`✗ You do NOT own ${repoLabel}#${number}.`];
  const sessionPart = owner.sessionId ? ` (${owner.sessionId})` : '';
  const status = owner.ownerStatus ?? '?';
  const namePart = owner.ownerName ? ` · ${owner.ownerName}` : '';
  lines.push(`  Owner:   task ${owner.taskId ?? '?'}${sessionPart} · status ${status}${namePart}`);
  if (owner.worktreePath) lines.push(`  Worktree ${owner.worktreePath}`);
  const age = formatAge(owner);
  if (owner.doing || age) {
    const doingText = owner.doing ? `"${owner.doing}"` : '(no activity summary)';
    lines.push(`  Doing:   ${doingText}${age ? ` (last activity ${age} ago)` : ''}`);
  }
  lines.push(`  Action:  pick a different issue. Operator override: kookr issue claim ${number} --force`);
  return lines.join('\n');
}

function formatClaimLine(claim) {
  const repo = claim?.repo ?? '(unknown repo)';
  const number = claim?.number ?? '?';
  const taskId8 = typeof claim?.taskId === 'string' ? claim.taskId.slice(0, 8) : '?';
  const status = claim?.ownerStatus ?? '?';
  const age = formatAge(claim);
  const ageLabel = age ? `${age} ago` : '-';
  const doing = claim?.doing ? `  ${claim.doing}` : '';
  return `${repo}#${number}  task ${taskId8}  ${status}  ${ageLabel}${doing}`;
}

const NO_SERVER_MESSAGE_RETRIED =
  'kookr issue: no Kookr server reachable after 4 attempts — treating ownership as unverifiable; do NOT start work on this issue (fail closed).';
const NO_SERVER_MESSAGE_SINGLE_TRY =
  'kookr issue: no Kookr server reachable — treating ownership as unverifiable; do NOT start work on this issue (fail closed).';

const UNSUPPORTED_MESSAGE = 'kookr issue: server does not support issue claims (proceeding as pre-lock is safe)';

// ---------- verb handlers ----------

async function handleClaim({ args, env, out, err, exit, sleep }) {
  const number = parseIssueNumber(args.number);
  if (number === null) return userError({ args, out, err, exit, message: 'a positive integer issue number is required (e.g. `kookr issue claim 779`).' });

  const taskId = resolveTaskId({ args, env });
  if (!taskId) {
    return userError({
      args,
      out,
      err,
      exit,
      message: 'no task id. Set KOOKR_TASK_ID (auto-injected into managed tasks) or pass --task-id.',
    });
  }
  const sessionId = resolveSessionId(env);

  const body = { cwd: process.cwd(), number, taskId };
  if (args.repo) body.repo = args.repo;
  if (sessionId) body.sessionId = sessionId;
  if (args.force) body.force = true;

  const outcome = await withRetries({
    env,
    sleep,
    maxRetries: RETRY_DELAYS_MS.length,
    invoke: (baseUrl) => requestJson({ baseUrl, method: 'POST', body }),
  });

  if (outcome.kind === 'invalid_port') return invalidPort({ args, out, err, exit, raw: outcome.raw });
  if (outcome.kind === 'unreachable') return noServer({ args, out, err, exit, retried: true });

  const { status, json } = outcome.result;

  if (status === 404) return unsupported({ args, out, err, exit });

  if (status === 200) {
    const repo = args.repo ?? json?.repo ?? '(unknown repo)';
    const reentrant = json?.reentrant === true;
    // The route returns `tookOver` (a decorated ClaimOwnerRecord of the
    // displaced owner) on a --force takeover — see routes/issue-claim-routes.ts.
    const displaced = json?.tookOver ?? null;
    const tookOver = displaced !== null;
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_OK,
        ok: true,
        code: 'OK',
        message: 'Claimed.',
        details: { owned: true, repo, number, taskId, reentrant, tookOver, displaced },
      });
    }
    let line = `✓ Claimed ${repo}#${number} for task ${taskId}`;
    if (reentrant) line += ' (already owned by you — reentrant)';
    out.log(line);
    if (tookOver) {
      const displacedId = displaced?.taskId ?? displaced?.id ?? null;
      out.log(displacedId ? `  Took over from task ${displacedId} (--force).` : '  Took over from the prior (stale) owner (--force).');
    }
    return exit(EXIT_OK);
  }

  if (status === 409) {
    const repo = args.repo ?? json?.owner?.repo ?? null;
    const owner = json?.owner ?? {};
    const block = formatOwnerBlock({ repo, number, owner });
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_CLAIM_HELD,
        ok: false,
        code: 'CLAIM_HELD',
        message: block,
        details: { owned: false, repo, number, owner },
      });
    }
    err.error(block);
    return exit(EXIT_CLAIM_HELD);
  }

  if (status === 400) return serverBadRequest({ args, out, err, exit, json, text: outcome.result.text });

  return unexpectedStatus({ args, out, err, exit, status, json, text: outcome.result.text });
}

async function handleRelease({ args, env, out, err, exit, sleep }) {
  const number = parseIssueNumber(args.number);
  if (number === null) return userError({ args, out, err, exit, message: 'a positive integer issue number is required (e.g. `kookr issue release 779`).' });

  const taskId = resolveTaskId({ args, env });
  if (!taskId) {
    return userError({
      args,
      out,
      err,
      exit,
      message: 'no task id. Set KOOKR_TASK_ID (auto-injected into managed tasks) or pass --task-id.',
    });
  }

  const body = { cwd: process.cwd(), number, taskId };
  if (args.repo) body.repo = args.repo;

  const outcome = await withRetries({
    env,
    sleep,
    maxRetries: RETRY_DELAYS_MS.length,
    invoke: (baseUrl) => requestJson({ baseUrl, method: 'DELETE', body }),
  });

  if (outcome.kind === 'invalid_port') return invalidPort({ args, out, err, exit, raw: outcome.raw });
  if (outcome.kind === 'unreachable') return noServer({ args, out, err, exit, retried: true });

  const { status, json } = outcome.result;

  if (status === 404) return unsupported({ args, out, err, exit });

  if (status === 200) {
    const repo = args.repo ?? json?.repo ?? '(unknown repo)';
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_OK,
        ok: true,
        code: 'OK',
        message: 'Released.',
        details: { repo, number, taskId },
      });
    }
    out.log(`✓ Released ${repo}#${number} for task ${taskId}`);
    return exit(EXIT_OK);
  }

  if (status === 403) {
    const message = 'not the owner';
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_SERVER_ERROR,
        ok: false,
        code: 'SERVER_ERROR',
        message,
        details: { status },
      });
    }
    err.error(`kookr issue: ${message} (task ${taskId} does not hold this claim).`);
    return exit(EXIT_SERVER_ERROR);
  }

  if (status === 400) return serverBadRequest({ args, out, err, exit, json, text: outcome.result.text });

  return unexpectedStatus({ args, out, err, exit, status, json, text: outcome.result.text });
}

async function handleOwner({ args, env, out, err, exit, sleep }) {
  const number = parseIssueNumber(args.number);
  if (number === null) return userError({ args, out, err, exit, message: 'a positive integer issue number is required (e.g. `kookr issue owner 779`).' });

  const query = args.repo
    ? `number=${encodeURIComponent(number)}&repo=${encodeURIComponent(args.repo)}`
    : `number=${encodeURIComponent(number)}`;

  const outcome = await withRetries({
    env,
    sleep,
    maxRetries: 0,
    invoke: (baseUrl) => requestJson({ baseUrl, method: 'GET', query }),
  });

  if (outcome.kind === 'invalid_port') return invalidPort({ args, out, err, exit, raw: outcome.raw });
  if (outcome.kind === 'unreachable') return noServer({ args, out, err, exit, retried: false });

  const { status, json } = outcome.result;

  if (status === 404) return unsupported({ args, out, err, exit });

  if (status === 200) {
    const claims = Array.isArray(json) ? json : [];
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_OK,
        ok: true,
        code: 'OK',
        message: claims.length ? 'Found.' : 'No active claim.',
        details: { claims },
      });
    }
    if (claims.length === 0) {
      out.log('no active claim');
    } else {
      for (const claim of claims) out.log(formatClaimLine(claim));
    }
    return exit(EXIT_OK);
  }

  return unexpectedStatus({ args, out, err, exit, status, json, text: outcome.result.text });
}

async function handleList({ args, env, out, err, exit, sleep }) {
  const outcome = await withRetries({
    env,
    sleep,
    maxRetries: 0,
    invoke: (baseUrl) => requestJson({ baseUrl, method: 'GET' }),
  });

  if (outcome.kind === 'invalid_port') return invalidPort({ args, out, err, exit, raw: outcome.raw });
  if (outcome.kind === 'unreachable') return noServer({ args, out, err, exit, retried: false });

  const { status, json } = outcome.result;

  if (status === 404) return unsupported({ args, out, err, exit });

  if (status === 200) {
    const claims = Array.isArray(json) ? json : [];
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_OK,
        ok: true,
        code: 'OK',
        message: `${claims.length} active claim(s).`,
        details: { claims },
      });
    }
    for (const claim of claims) out.log(formatClaimLine(claim));
    return exit(EXIT_OK);
  }

  return unexpectedStatus({ args, out, err, exit, status, json, text: outcome.result.text });
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
      details: { subcommand: 'issue' },
    });
  }
  err.error(`kookr issue: ${message}`);
  return exit(EXIT_USER_ERROR);
}

function invalidPort({ args, out, err, exit, raw }) {
  return userError({ args, out, err, exit, message: `KOOKR_PORT must be an integer in 1..65535 (got: ${raw})` });
}

function noServer({ args, out, err, exit, retried }) {
  const message = retried ? NO_SERVER_MESSAGE_RETRIED : NO_SERVER_MESSAGE_SINGLE_TRY;
  if (args.json) {
    return exitJson({
      out,
      exit,
      exitCode: EXIT_NO_SERVER,
      ok: false,
      code: 'NO_SERVER',
      message,
      details: { subcommand: 'issue' },
    });
  }
  err.error(message);
  return exit(EXIT_NO_SERVER);
}

// R26: HTTP 404 on the claim routes (old server, or the feature flag off)
// means "proceed as pre-lock" — a distinct, successful-shaped outcome, not
// an error. Failing closed here would turn a plugin/server deploy-ordering
// mismatch into a fleet launch outage.
function unsupported({ args, out, err, exit }) {
  err.error(UNSUPPORTED_MESSAGE);
  if (args.json) {
    emitJson(out, {
      ok: true,
      code: 'UNSUPPORTED',
      message: UNSUPPORTED_MESSAGE,
      details: { owned: null, unsupported: true },
    });
  }
  return exit(EXIT_OK);
}

function serverBadRequest({ args, out, err, exit, json, text }) {
  const message = json?.error ?? (text || 'bad request');
  const details = { status: 400 };
  if (Array.isArray(json?.candidates)) details.candidates = json.candidates;
  // Unknown/terminal claimant task is a server-side rejection (RFC §5 exit 4),
  // matching kookr-signal's distinct-code convention: a wrong KOOKR_TASK_ID
  // must be visible to the agent, not folded into generic flag errors.
  if (json?.code === 'unknown_task' || json?.code === 'terminal_task') {
    if (args.json) {
      return exitJson({
        out,
        exit,
        exitCode: EXIT_SERVER_ERROR,
        ok: false,
        code: 'SERVER_REJECTED',
        message,
        details: { ...details, code: json.code },
      });
    }
    err.error(`kookr issue: server rejected the claim: ${message}`);
    err.error('Your KOOKR_TASK_ID may be wrong or the task may already be finished.');
    return exit(EXIT_SERVER_ERROR);
  }
  if (args.json) {
    return exitJson({
      out,
      exit,
      exitCode: EXIT_USER_ERROR,
      ok: false,
      code: 'USER_ERROR',
      message,
      details,
    });
  }
  err.error(`kookr issue: ${message}`);
  if (details.candidates) err.error(`Candidates: ${details.candidates.join(', ')}`);
  return exit(EXIT_USER_ERROR);
}

function unexpectedStatus({ args, out, err, exit, status, json, text }) {
  const message = `server rejected the request (HTTP ${status}): ${json?.error ?? (text || 'unknown error')}`;
  if (args.json) {
    return exitJson({
      out,
      exit,
      exitCode: EXIT_SERVER_ERROR,
      ok: false,
      code: 'SERVER_ERROR',
      message,
      details: { status },
    });
  }
  err.error(`kookr issue: ${message}`);
  return exit(EXIT_SERVER_ERROR);
}

// ---------- entry point ----------

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  out = console,
  err = console,
  exit = process.exit,
  sleep = defaultSleep,
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
          details: { subcommand: 'issue' },
        });
      }
      err.error(`kookr issue: ${e.message}`);
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
    return userError({ args, out, err, exit, message: 'a verb is required (claim, release, owner, list).' });
  }
  if (!VERBS.has(args.verb)) {
    return userError({ args, out, err, exit, message: `unknown verb "${args.verb}". Known verbs: ${[...VERBS].join(', ')}.` });
  }
  if (args.verb !== 'list' && args.number === null) {
    return userError({ args, out, err, exit, message: `an issue number is required (e.g. \`kookr issue ${args.verb} 779\`).` });
  }

  if (args.verb === 'claim') return handleClaim({ args, env, out, err, exit, sleep });
  if (args.verb === 'release') return handleRelease({ args, env, out, err, exit, sleep });
  if (args.verb === 'owner') return handleOwner({ args, env, out, err, exit, sleep });
  return handleList({ args, env, out, err, exit, sleep });
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
    console.error(`kookr issue: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

export {
  HELP_TEXT,
  UsageError,
  EXIT_CLAIM_HELD,
  parseArgs,
  resolveTaskId,
  resolveSessionId,
  parseIssueNumber,
  requestJson,
  withRetries,
  formatOwnerBlock,
  formatClaimLine,
  humanizeMs,
  main,
};
