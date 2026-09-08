#!/usr/bin/env node
// Kookr CLI cross-agent task migration (RFC: docs/rfc/rfc-cross-agent-task-migration.md).
// Continues interrupted tasks under a DIFFERENT agent by driving the server's
// migration endpoints (see src/server/routes/task-routes.ts /
// src/server/use-cases/migrate-tasks.ts, already implemented — this CLI does
// not change server behavior):
//   kookr migrate --to <agent> --all [--from <agent>] [OPTIONS]
//   kookr migrate --to <agent> <taskId...> [OPTIONS]
//
// Contract:
//   GET  /api/tasks/migratable?targetAgent=&fromAgent=&includeCancelled=&onlyIsolated=
//        -> { targetAgent, candidates: [{taskId,name,cwd,fromAgent,status,eligible:true,worktreeShared}
//                                       |{taskId,eligible:false,reason,worktreeShared}] }
//   POST /api/tasks/migrate  { targetAgent, scope, effort?, setAsDefault?, onlyIsolated? }
//        -> { targetAgent, defaultUpdated, defaultUpdateReason?, results:[{taskId,outcome,reason?,newTaskId?,worktreeShared?}] }
//
// Loopback is trusted by the server for POST /api/tasks/migrate (same gate as
// POST /api/tasks — not supervisor-gated); if the server binds non-loopback
// and KOOKR_API_TOKEN is set it is forwarded as a bearer token.

import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolvePort } from './kookr-status.js';

const ACCEPTED_AGENTS = new Set(['claude-code', 'codex-cli', 'grok-build']);
// Migratable-preview reads can shell out to `git` per candidate task; migrate
// POST launches (possibly several) real agent sessions in sequence, so it
// gets a much longer budget than a plain status/snapshot read.
const GET_TIMEOUT_MS = 8000;
const POST_TIMEOUT_MS = 30000;

const EXIT_OK = 0;
const EXIT_CANCELLED = 1;
const EXIT_USER_ERROR = 2;
const EXIT_NO_SERVER = 3;
const EXIT_SERVER_ERROR = 4;
const EXIT_ALL_BLOCKED = 5;

const HELP_TEXT = `kookr migrate — continue interrupted tasks under a different agent.

Usage:
  kookr migrate --to <agent> --all [--from <agent>] [OPTIONS]
  kookr migrate --to <agent> <taskId...> [OPTIONS]
  kookr-migrate --to <agent> ... [OPTIONS]        Same as \`kookr migrate ...\`.

Options:
      --to <agent>          Target agent: claude-code, codex-cli, or
                             grok-build. Required.
      --from <agent>        Source-agent filter, only meaningful with --all.
      --all                 Migrate every migratable task (optionally
                             filtered by --from). Mutually exclusive with
                             explicit task ids.
      --include-cancelled   Also consider cancelled tasks as migration
                             candidates.
      --set-default         On any successful migration, set <agent> as the
                             server's default agent.
      --only-isolated       Only migrate tasks whose checkout is a dedicated
                             worktree (skip shared checkouts).
      --effort <level>      Reasoning effort for the continuation task
                             (default: agent's own default).
      --dry-run             Print the migration plan (GET
                             /api/tasks/migratable) and exit without POSTing.
      --yes, -y              Skip the confirmation prompt.
      --json                 Emit a single machine-readable JSON envelope on
                             stdout instead of human text (see below). Requires
                             --yes for a real migration (or use --dry-run); no
                             confirmation prompt is shown under --json.
  -h, --help                 Show this help.

Without --dry-run and without --yes, prints the plan and asks for
confirmation on stdin before POSTing.

With --json, one JSON object is printed on stdout:
  dry-run   { ok:true, mode:"plan", targetAgent, candidates, notFound }
  real run  { ok:true, mode:"migrate", targetAgent, defaultUpdated, results }
  failure   { ok:false, code, message }   (exit code is non-zero)

ok:true means the command ran and returned a valid result; read the exit code
for the disposition (0 = migrated/queued or a plan found candidates, 5 =
nothing eligible / all blocked). ok:false is reserved for a command that could
not run at all (bad flags, no server reachable, server error).

Environment:
  KOOKR_PORT           Specific port on 127.0.0.1.
  KOOKR_API_TOKEN       Bearer token, forwarded when the server is non-loopback.

Exit codes:
  0  At least one task migrated or queued (or --dry-run found eligible tasks).
  1  User declined the confirmation prompt.
  2  User error (bad flags).
  3  No Kookr server reachable.
  4  Server request failed (network / HTTP error).
  5  Every candidate was blocked (or none were eligible).
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const out = {
    to: null,
    from: null,
    all: false,
    taskIds: [],
    includeCancelled: false,
    setDefault: false,
    onlyIsolated: false,
    dryRun: false,
    yes: false,
    json: false,
    effort: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const eat = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`option ${tok} requires a value`);
      return v;
    };
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '--to') {
      out.to = eat();
    } else if (tok.startsWith('--to=')) {
      out.to = tok.slice('--to='.length);
    } else if (tok === '--from') {
      out.from = eat();
    } else if (tok.startsWith('--from=')) {
      out.from = tok.slice('--from='.length);
    } else if (tok === '--all') {
      out.all = true;
    } else if (tok === '--include-cancelled') {
      out.includeCancelled = true;
    } else if (tok === '--set-default') {
      out.setDefault = true;
    } else if (tok === '--only-isolated') {
      out.onlyIsolated = true;
    } else if (tok === '--dry-run') {
      out.dryRun = true;
    } else if (tok === '--yes' || tok === '-y') {
      out.yes = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok === '--effort') {
      out.effort = eat();
    } else if (tok.startsWith('--effort=')) {
      out.effort = tok.slice('--effort='.length);
    } else if (tok === '--') {
      for (let j = i + 1; j < argv.length; j++) out.taskIds.push(argv[j]);
      break;
    } else if (tok.startsWith('-')) {
      throw new UsageError(`unknown option: ${tok}`);
    } else {
      out.taskIds.push(tok);
    }
  }

  if (out.help) return out;

  if (out.to === null) {
    throw new UsageError('--to is required');
  }
  if (!ACCEPTED_AGENTS.has(out.to)) {
    throw new UsageError(`--to must be "claude-code", "codex-cli", or "grok-build" (got: ${out.to})`);
  }
  if (out.from !== null && !ACCEPTED_AGENTS.has(out.from)) {
    throw new UsageError(`--from must be "claude-code", "codex-cli", or "grok-build" (got: ${out.from})`);
  }
  if (out.all && out.taskIds.length > 0) {
    throw new UsageError('--all and explicit task ids are mutually exclusive');
  }
  if (!out.all && out.taskIds.length === 0) {
    throw new UsageError('specify --all or one or more task ids to migrate');
  }
  if (out.from !== null && !out.all) {
    throw new UsageError('--from requires --all');
  }
  // A machine caller must never hit the interactive confirm prompt. Reuse the
  // existing non-interactive guard by requiring --yes for a real --json run;
  // --dry-run needs no confirmation, so it is exempt.
  if (out.json && !out.dryRun && !out.yes) {
    throw new UsageError('--json requires --yes for a real migration (or use --dry-run)');
  }
  return out;
}

// Issue #708 pattern (see kookr-spawn.js / kookr-status.js): a non-loopback
// server requires a bearer token on state-changing requests. Loopback servers
// ignore the header, so it is always safe to attach when present.
function apiAuthHeaders(env = process.env) {
  const token = env.KOOKR_API_TOKEN && env.KOOKR_API_TOKEN.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readJsonBody(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function fetchMigratable({
  baseUrl,
  targetAgent,
  fromAgent,
  includeCancelled,
  onlyIsolated,
  taskIds,
  env = process.env,
  fetchImpl = fetch,
}) {
  const params = new URLSearchParams({ targetAgent });
  // ids-scoped preview: naming ids is the opt-in (server treats them like the
  // POST `ids` scope), so fromAgent/includeCancelled don't apply.
  if (taskIds && taskIds.length > 0) {
    params.set('taskIds', taskIds.join(','));
  } else {
    if (fromAgent) params.set('fromAgent', fromAgent);
    if (includeCancelled) params.set('includeCancelled', 'true');
  }
  if (onlyIsolated) params.set('onlyIsolated', 'true');

  let res;
  try {
    res = await fetchImpl(`${baseUrl}/api/tasks/migratable?${params.toString()}`, {
      headers: apiAuthHeaders(env),
      signal: AbortSignal.timeout(GET_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: 'network_error', message: err instanceof Error ? err.message : String(err) };
  }
  const body = await readJsonBody(res);
  if (!res.ok) {
    return { kind: 'http_error', status: res.status, message: body?.error ?? `HTTP ${res.status}` };
  }
  if (!body || !Array.isArray(body.candidates)) {
    return { kind: 'http_error', status: res.status, message: 'unexpected /api/tasks/migratable response (missing candidates array)' };
  }
  return { kind: 'ok', targetAgent: body.targetAgent, candidates: body.candidates };
}

async function postMigrate({ baseUrl, body, env = process.env, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/api/tasks/migrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...apiAuthHeaders(env),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: 'network_error', message: err instanceof Error ? err.message : String(err) };
  }
  const json = await readJsonBody(res);
  if (!res.ok) {
    return { kind: 'http_error', status: res.status, message: json?.error ?? `HTTP ${res.status}` };
  }
  if (!json || !Array.isArray(json.results)) {
    return { kind: 'http_error', status: res.status, message: 'unexpected /api/tasks/migrate response (missing results array)' };
  }
  return { kind: 'ok', body: json };
}

function resolveScope(args) {
  if (args.all) {
    return {
      kind: 'all',
      ...(args.from ? { fromAgent: args.from } : {}),
      includeCancelled: args.includeCancelled,
    };
  }
  return { kind: 'ids', taskIds: args.taskIds };
}

/**
 * Reduce the full /api/tasks/migratable candidate set to the plan for this
 * invocation. For `--all`, every candidate is in scope. For explicit task
 * ids, filter down to the requested ids — ids absent from the response
 * (already-migrated / unknown / not tracked) are reported separately.
 */
function buildPlan({ candidates, scope, taskIds }) {
  if (scope.kind === 'ids') {
    const wanted = new Set(taskIds);
    const matched = candidates.filter((c) => wanted.has(c.taskId));
    const matchedIds = new Set(matched.map((c) => c.taskId));
    const notFound = taskIds.filter((id) => !matchedIds.has(id));
    return {
      eligible: matched.filter((c) => c.eligible),
      blocked: matched.filter((c) => !c.eligible),
      notFound,
    };
  }
  return {
    eligible: candidates.filter((c) => c.eligible),
    blocked: candidates.filter((c) => !c.eligible),
    notFound: [],
  };
}

function formatPlan(plan, targetAgent) {
  const lines = [`Migration plan -> ${targetAgent}`];
  if (plan.eligible.length === 0) {
    lines.push('  Eligible: none');
  } else {
    lines.push(`  Eligible (${plan.eligible.length}):`);
    for (const c of plan.eligible) {
      const shared = c.worktreeShared ? '  [worktree shared]' : '';
      lines.push(
        `    ${c.taskId}  ${c.name ?? '(unnamed)'}  from=${c.fromAgent ?? '?'}  ${c.cwd ?? '(no cwd)'}${shared}`,
      );
    }
  }
  if (plan.blocked.length > 0) {
    const byReason = new Map();
    for (const c of plan.blocked) {
      byReason.set(c.reason, (byReason.get(c.reason) ?? 0) + 1);
    }
    lines.push(`  Blocked (${plan.blocked.length}):`);
    for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${reason ?? 'unknown'}: ${count}`);
    }
  }
  if (plan.notFound.length > 0) {
    lines.push(`  Not found among migratable/blocked tasks (${plan.notFound.length}): ${plan.notFound.join(', ')}`);
  }
  return lines.join('\n');
}

function formatResults(body) {
  const lines = [`Migration results -> ${body.targetAgent}`];
  for (const r of body.results) {
    if (r.outcome === 'migrated' || r.outcome === 'queued') {
      lines.push(`  ${r.taskId}  ${r.outcome}${r.newTaskId ? `  -> ${r.newTaskId}` : ''}`);
    } else {
      lines.push(`  ${r.taskId}  blocked${r.reason ? `  (${r.reason})` : ''}`);
    }
  }
  const migrated = body.results.filter((r) => r.outcome === 'migrated').length;
  const queued = body.results.filter((r) => r.outcome === 'queued').length;
  const blocked = body.results.filter((r) => r.outcome === 'blocked').length;
  lines.push(`Summary: migrated=${migrated} queued=${queued} blocked=${blocked}`);
  if (body.defaultUpdated) {
    lines.push(`Default agent updated to ${body.targetAgent}.`);
  } else if (body.defaultUpdateReason) {
    lines.push(`Default agent not updated (${body.defaultUpdateReason}).`);
  }
  return lines.join('\n');
}

/**
 * Read a single line of input, modeled on kookr-spawn.js's createLineReader /
 * confirmDuplicateSpawn. Returns null on EOF with no data.
 */
function createLineReader(stdin) {
  const iterator = stdin[Symbol.asyncIterator]();
  let buffered = '';
  return async function readLine() {
    for (;;) {
      const newline = buffered.search(/\r?\n/);
      if (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(buffered[newline] === '\r' && buffered[newline + 1] === '\n' ? newline + 2 : newline + 1);
        return line;
      }
      const next = await iterator.next();
      if (next.done) {
        if (buffered.length === 0) return null;
        const line = buffered;
        buffered = '';
        return line;
      }
      buffered += Buffer.isBuffer(next.value) ? next.value.toString('utf-8') : String(next.value);
    }
  };
}

async function confirmMigration({ count, targetAgent, stdin, out }) {
  if (!stdin || stdin.isTTY !== true) {
    out.log('kookr-migrate: confirmation required in non-interactive mode. Re-run with --yes to proceed.');
    return false;
  }
  const readLine = createLineReader(stdin);
  out.log(`Migrate ${count} task(s) to ${targetAgent}? [y/N]`);
  const answer = (await readLine())?.trim().toLowerCase() ?? '';
  return answer === 'y' || answer === 'yes';
}

/**
 * Emit an `{ ok:false, code, message }` envelope on stdout (mirroring
 * `kookr status`/`drain --json`) so machine callers branch on `ok` rather than
 * scraping stderr. Returns the exit code so callers can `return failJson(...)`.
 */
function failJson(out, exit, { code, message, exitCode }) {
  out.log(JSON.stringify({ ok: false, code, message }));
  return exit(exitCode);
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  out = console,
  err = console,
  exit = process.exit,
} = {}) {
  // Detect --json from the raw argv too, so a parse failure can still answer in
  // JSON (args isn't available yet when parseArgs throws).
  const wantsJson = argv.includes('--json');
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      if (wantsJson) {
        return failJson(out, exit, { code: 'USER_ERROR', message: e.message, exitCode: EXIT_USER_ERROR });
      }
      err.error(`kookr-migrate: ${e.message}`);
      err.error('Try `kookr migrate --help`.');
      return exit(EXIT_USER_ERROR);
    }
    throw e;
  }
  if (args.help) {
    out.log(HELP_TEXT);
    return exit(EXIT_OK);
  }

  const resolved = await resolvePort(env);
  if (resolved.kind === 'invalid') {
    const message = `KOOKR_PORT must be an integer between 1 and 65535 (got: ${JSON.stringify(resolved.raw)}).`;
    if (args.json) return failJson(out, exit, { code: 'USER_ERROR', message, exitCode: EXIT_USER_ERROR });
    err.error(message);
    return exit(EXIT_USER_ERROR);
  }
  if (resolved.kind === 'none') {
    const message = 'Kookr is not running on the default ports. Set KOOKR_PORT if using a non-default port.';
    if (args.json) return failJson(out, exit, { code: 'NO_SERVER', message, exitCode: EXIT_NO_SERVER });
    err.error(message);
    return exit(EXIT_NO_SERVER);
  }
  const baseUrl = `http://127.0.0.1:${resolved.port}`;

  const scope = resolveScope(args);

  const migratable = await fetchMigratable({
    baseUrl,
    targetAgent: args.to,
    fromAgent: scope.kind === 'all' ? scope.fromAgent : undefined,
    includeCancelled: args.includeCancelled,
    onlyIsolated: args.onlyIsolated,
    taskIds: scope.kind === 'ids' ? scope.taskIds : undefined,
    env,
  });
  if (migratable.kind !== 'ok') {
    if (args.json) {
      return failJson(out, exit, {
        code: 'SERVER_ERROR',
        message: `failed to reach Kookr on port ${resolved.port}: ${migratable.message}`,
        exitCode: EXIT_SERVER_ERROR,
      });
    }
    err.error(`kookr-migrate: failed to reach Kookr on port ${resolved.port}: ${migratable.message}`);
    return exit(EXIT_SERVER_ERROR);
  }

  const plan = buildPlan({ candidates: migratable.candidates, scope, taskIds: args.taskIds });

  if (args.dryRun) {
    if (args.json) {
      out.log(JSON.stringify({
        ok: true,
        mode: 'plan',
        targetAgent: migratable.targetAgent ?? args.to,
        candidates: migratable.candidates,
        // Ids named on the command line that the server returned no candidate
        // for (already-migrated / unknown / untracked). Always [] for --all.
        notFound: plan.notFound,
      }));
      return exit(plan.eligible.length > 0 ? EXIT_OK : EXIT_ALL_BLOCKED);
    }
    out.log(formatPlan(plan, args.to));
    return exit(plan.eligible.length > 0 ? EXIT_OK : EXIT_ALL_BLOCKED);
  }

  if (plan.eligible.length === 0) {
    // "Nothing eligible" is a valid outcome of a run that completed, not a
    // failure to run — so under --json it stays ok:true (an empty migrate
    // result) and only the exit code carries the all-blocked disposition. This
    // keeps ok:false reserved for "the command could not run" (bad flags, no
    // server, server error), consistent across every --json path.
    if (args.json) {
      out.log(JSON.stringify({
        ok: true,
        mode: 'migrate',
        targetAgent: migratable.targetAgent ?? args.to,
        defaultUpdated: false,
        results: [],
      }));
      return exit(EXIT_ALL_BLOCKED);
    }
    out.log(formatPlan(plan, args.to));
    err.error('kookr-migrate: no eligible tasks to migrate.');
    return exit(EXIT_ALL_BLOCKED);
  }

  // Under --json the parser guarantees --yes, so this prompt path is skipped and
  // no interactive confirmation ever blocks a machine caller.
  if (!args.yes) {
    out.log(formatPlan(plan, args.to));
    const confirmed = await confirmMigration({ count: plan.eligible.length, targetAgent: args.to, stdin, out });
    if (!confirmed) {
      out.log('Aborted.');
      return exit(EXIT_CANCELLED);
    }
  }

  const body = {
    targetAgent: args.to,
    scope,
    ...(args.effort ? { effort: args.effort } : {}),
    ...(args.setDefault ? { setAsDefault: true } : {}),
    ...(args.onlyIsolated ? { onlyIsolated: true } : {}),
  };

  const posted = await postMigrate({ baseUrl, body, env });
  if (posted.kind !== 'ok') {
    if (args.json) {
      return failJson(out, exit, {
        code: 'SERVER_ERROR',
        message: `migrate request failed: ${posted.message}`,
        exitCode: EXIT_SERVER_ERROR,
      });
    }
    err.error(`kookr-migrate: migrate request failed: ${posted.message}`);
    return exit(EXIT_SERVER_ERROR);
  }

  if (args.json) {
    out.log(JSON.stringify({
      ok: true,
      mode: 'migrate',
      targetAgent: posted.body.targetAgent ?? args.to,
      defaultUpdated: posted.body.defaultUpdated ?? false,
      results: posted.body.results,
    }));
  } else {
    out.log(formatResults(posted.body));
  }
  const anySuccess = posted.body.results.some((r) => r.outcome === 'migrated' || r.outcome === 'queued');
  return exit(anySuccess ? EXIT_OK : EXIT_ALL_BLOCKED);
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
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`kookr-migrate: ${msg}`);
    process.exit(1);
  });
}

export {
  HELP_TEXT,
  UsageError,
  EXIT_OK,
  EXIT_CANCELLED,
  EXIT_USER_ERROR,
  EXIT_NO_SERVER,
  EXIT_SERVER_ERROR,
  EXIT_ALL_BLOCKED,
  parseArgs,
  apiAuthHeaders,
  fetchMigratable,
  postMigrate,
  resolveScope,
  buildPlan,
  formatPlan,
  formatResults,
  confirmMigration,
  main,
};
