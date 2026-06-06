#!/usr/bin/env node
// kookr spawn — create a Kookr task for the current working directory.
//
// Usage:
//   kookr spawn "prompt text"
//   kookr spawn --prompt-file /tmp/prompt.md
//   cat prompt.md | kookr spawn
//
// Contract with the server: POST {base}/api/tasks with JSON body and
// X-Kookr-Launch-Source: cli header. Server at /api/health must return
// JSON containing a `serverStartedAt` field — that is the shape-check
// that distinguishes a Kookr instance from an unrelated service.

import { pathToFileURL } from 'node:url';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const PORTS_TO_TRY = [4800, 4801];
const PROBE_TIMEOUT_MS = 1500;
const RETRY_DELAY_MS = 3000;
const DEFAULT_RETRIES = 3;
const MAX_RETRIES = 10;
const POST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PROMPT_BYTES = 1024 * 1024;
const CLI_VERSION = '1.0.0';

const EXIT_OK = 0;
const EXIT_USER_ERROR = 2;
const EXIT_NO_SERVER = 3;
const EXIT_SERVER_ERROR = 4;
const EXIT_DUPLICATE_BLOCKED = 5;
const DEDUPE_MODES = new Set(['warn', 'block', 'skip']);
// #681: union of every agent's accepted reasoning-effort levels — claude-code
// (low|medium|high|xhigh|max) ∪ codex-cli (none|minimal|low|medium|high|xhigh).
// This is a cross-agent fast-fail check only: the CLI cannot know which agent a
// `round-robin` launch resolves to, so the authoritative agent-specific check
// runs server-side and surfaces as a 400 (→ EXIT_SERVER_ERROR) if, e.g., `max`
// is requested for codex-cli. Keep in sync with ALL_EFFORT_LEVELS in
// src/shared/contracts/agent-types.ts.
const EFFORT_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// ---------- arg parsing ----------

const HELP_TEXT = `kookr spawn — create a Kookr task from the current working directory.

Usage:
  kookr spawn [OPTIONS] [PROMPT...]
  kookr spawn --prompt-file <path> [OPTIONS]
  cat prompt.md | kookr spawn [OPTIONS]
  kookr-spawn [OPTIONS] [PROMPT...]        Deprecated compatibility alias.

Options:
  -C, --cwd <path>         Working directory for the task (default: cwd).
  -a, --agent <type>       claude-code or codex-cli (default: server default).
      --effort <level>     Reasoning effort for this task (default: server's
                           per-agent-type setting, else the agent CLI default).
                           claude-code: low|medium|high|xhigh|max.
                           codex-cli:   none|minimal|low|medium|high|xhigh.
      --criteria <text>    Acceptance criteria. Note: this is argv-exposed.
      --dedupe <mode>      warn, block, or skip (default: warn).
      --parent-task-id <uuid>  Override the parent task linkage explicitly.
      --no-parent-task     Launch detached, ignoring KOOKR_TASK_ID.
  -f, --prompt-file <path> Read prompt from a file (hook-safe).
  -h, --help               Show this help.

Parent-task linking:
  When launched from inside a Kookr-managed task, kookr-spawn auto-forwards
  KOOKR_TASK_ID as parentTaskId so the new task shows up as a child in the
  dashboard. Pass --parent-task-id to override or --no-parent-task to opt out.
  Outside a managed task (no KOOKR_TASK_ID) the field is omitted entirely.

Environment:
  KOOKR_API_BASE_URL              Base URL of a running Kookr server
                                   (overrides auto-detect).
  KOOKR_PORT                      Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_TASK_ID                   Current Kookr task id; auto-forwarded as
                                   parentTaskId unless --no-parent-task is set
                                   or --parent-task-id overrides it.
  KOOKR_SPAWN_MAX_PROMPT_BYTES    Max bytes for piped stdin (default: 1048576).
  KOOKR_SPAWN_CONNECT_RETRIES     Connectivity sweep retries (default: 3, max: 10).

Hook-safety inside a Claude Code session:
  When invoked through a Claude Code Bash tool, positional argv and
  --criteria values appear on the bash command line and may be blocked
  by PreToolUse hooks that scan for strings like "gh pr create" or
  "git push --force". If your prompt might contain such text, pass it
  via --prompt-file (or piped stdin) instead — the flag's *value* is
  still a file path, and the hook does not see the file contents.

Exit codes:
  0  Task created (or idempotent dedup against an already-active task).
  2  User error (bad flags, empty prompt, missing cwd, etc.).
  3  No Kookr server reachable.
  4  Server returned an error.
  5  Duplicate active prompt blocked.`;

function parseArgs(argv) {
  const out = {
    prompt: null,
    positional: [],
    cwd: null,
    agent: null,
    effort: null,
    criteria: null,
    dedupe: 'warn',
    promptFile: null,
    parentTaskId: null,
    noParentTask: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const eat = () => {
      const v = argv[++i];
      if (v === undefined) {
        throw new UsageError(`option ${tok} requires a value`);
      }
      return v;
    };
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '-C' || tok === '--cwd') {
      out.cwd = eat();
    } else if (tok === '-a' || tok === '--agent') {
      out.agent = eat();
    } else if (tok === '--effort') {
      out.effort = eat();
    } else if (tok.startsWith('--effort=')) {
      out.effort = tok.slice('--effort='.length);
    } else if (tok === '--criteria') {
      out.criteria = eat();
    } else if (tok === '--dedupe') {
      out.dedupe = eat();
    } else if (tok.startsWith('--dedupe=')) {
      out.dedupe = tok.slice('--dedupe='.length);
    } else if (tok === '--parent-task-id') {
      out.parentTaskId = eat();
    } else if (tok.startsWith('--parent-task-id=')) {
      out.parentTaskId = tok.slice('--parent-task-id='.length);
    } else if (tok === '--no-parent-task') {
      out.noParentTask = true;
    } else if (tok === '-f' || tok === '--prompt-file') {
      out.promptFile = eat();
    } else if (tok === '--') {
      // Everything after -- is positional
      for (let j = i + 1; j < argv.length; j++) out.positional.push(argv[j]);
      break;
    } else if (tok.startsWith('-')) {
      throw new UsageError(`unknown option: ${tok}`);
    } else {
      out.positional.push(tok);
    }
  }
  if (out.agent !== null && out.agent !== 'claude-code' && out.agent !== 'codex-cli') {
    throw new UsageError(`--agent must be "claude-code" or "codex-cli" (got: ${out.agent})`);
  }
  if (!DEDUPE_MODES.has(out.dedupe)) {
    throw new UsageError(`--dedupe must be "warn", "block", or "skip" (got: ${out.dedupe})`);
  }
  if (out.effort !== null && !EFFORT_LEVELS.has(out.effort)) {
    throw new UsageError(
      `--effort must be one of: ${[...EFFORT_LEVELS].join(', ')} (got: ${out.effort})`,
    );
  }
  if (out.parentTaskId !== null) {
    const trimmed = out.parentTaskId.trim();
    if (trimmed === '') {
      throw new UsageError('--parent-task-id requires a non-empty value');
    }
    out.parentTaskId = trimmed;
  }
  if (out.parentTaskId !== null && out.noParentTask) {
    throw new UsageError('--parent-task-id and --no-parent-task are mutually exclusive');
  }
  return out;
}

/**
 * Resolve the parent task id to send to POST /api/tasks.
 *
 * Precedence:
 *   1. --no-parent-task         → null (intentionally detached)
 *   2. --parent-task-id <uuid>  → that value
 *   3. KOOKR_TASK_ID env var    → that value (the "auto-link" path)
 *   4. otherwise                → null
 *
 * Server-side validation (404 when the parent no longer exists) is preserved:
 * postTask will surface that error rather than the CLI silently dropping it.
 */
function resolveParentTaskId({ args, env }) {
  if (args.noParentTask) return null;
  if (args.parentTaskId !== null) return args.parentTaskId;
  const raw = env.KOOKR_TASK_ID;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

class UsageError extends Error {}

// ---------- prompt resolution ----------

function readPromptFile(path, maxBytes) {
  try {
    const buf = readFileSync(path);
    if (buf.length > maxBytes) {
      throw new UsageError(
        `prompt file too large: ${buf.length} bytes > ${maxBytes} (raise KOOKR_SPAWN_MAX_PROMPT_BYTES to override)`,
      );
    }
    return buf.toString('utf-8');
  } catch (err) {
    if (err instanceof UsageError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(`could not read --prompt-file ${path}: ${msg}`);
  }
}

async function readStdin(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      throw new UsageError(
        `stdin prompt exceeds ${maxBytes} bytes (raise KOOKR_SPAWN_MAX_PROMPT_BYTES to override)`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Resolve the prompt from one of: --prompt-file, positional argv, piped stdin.
 * Exactly one source wins. Rejects empty prompts and prompts containing NULs.
 */
async function resolvePrompt({ args, stdin, env }) {
  const maxBytes = parseMaxBytes(env.KOOKR_SPAWN_MAX_PROMPT_BYTES);
  let raw;
  if (args.promptFile !== null) {
    raw = readPromptFile(args.promptFile, maxBytes);
  } else if (args.positional.length > 0) {
    raw = args.positional.join(' ');
  } else if (stdin && stdin.isTTY === false) {
    raw = await readStdin(stdin, maxBytes);
  } else {
    throw new UsageError(
      'no prompt provided. Pass a positional argument, pipe stdin, or use --prompt-file.',
    );
  }
  const trimmed = raw.replace(/\s+$/, '');
  if (trimmed.trim().length === 0) {
    throw new UsageError('prompt is empty, aborting');
  }
  if (trimmed.indexOf('\0') !== -1) {
    throw new UsageError('prompt contains NUL byte, aborting');
  }
  return trimmed;
}

function parseMaxBytes(raw) {
  if (raw === undefined || raw === '') return DEFAULT_MAX_PROMPT_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`KOOKR_SPAWN_MAX_PROMPT_BYTES must be a positive integer (got: ${raw})`);
  }
  return n;
}

// ---------- cwd resolution + validation ----------

function resolveCwd(explicit, pwd) {
  const raw = explicit ?? pwd;
  const abs = pathResolve(pwd, raw);
  let stat;
  try {
    stat = statSync(abs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(`cwd does not exist: ${abs} (${msg})`);
  }
  if (!stat.isDirectory()) {
    throw new UsageError(`cwd is not a directory: ${abs}`);
  }
  return abs;
}

// ---------- port / base-URL resolution ----------

function parsePortEnv(raw) {
  if (raw === undefined || raw === '') return { kind: 'unset' };
  const trimmed = String(raw).trim();
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { kind: 'invalid', raw: trimmed };
  }
  return { kind: 'valid', port };
}

function parseRetries(raw) {
  if (raw === undefined || raw === '') return DEFAULT_RETRIES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RETRIES) {
    throw new UsageError(
      `KOOKR_SPAWN_CONNECT_RETRIES must be an integer in 1..${MAX_RETRIES} (got: ${raw})`,
    );
  }
  return n;
}

async function probeHealth(baseUrl, timeoutMs) {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = await res.json();
    // Shape discriminator: the field must exist and be a non-empty string.
    // `serverStartedAt` has been on /api/health long enough to survive
    // mixed-version rollout windows — unlike `build.version`, which is newer.
    return typeof body?.serverStartedAt === 'string' && body.serverStartedAt.length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the base URL of a running Kookr server, or return an
 * error-shaped result describing why not.
 *
 * Priority:
 *   1. KOOKR_API_BASE_URL — verbatim.
 *   2. KOOKR_PORT — http://127.0.0.1:<port>
 *   3. Concurrent sweep of PORTS_TO_TRY. After BOTH probes resolve:
 *        - both responded → ambiguous, exit 3 with a message
 *        - exactly one responded → use it
 *        - neither → retry the sweep up to N times with delay, then exit 3
 */
async function resolveBaseUrl({ env, sleep = defaultSleep } = {}) {
  if (env.KOOKR_API_BASE_URL && env.KOOKR_API_BASE_URL.trim() !== '') {
    const base = env.KOOKR_API_BASE_URL.trim().replace(/\/+$/, '');
    return { kind: 'explicit', baseUrl: base };
  }
  const portEnv = parsePortEnv(env.KOOKR_PORT);
  if (portEnv.kind === 'invalid') {
    return { kind: 'invalid_port', raw: portEnv.raw };
  }
  if (portEnv.kind === 'valid') {
    return { kind: 'explicit', baseUrl: `http://127.0.0.1:${portEnv.port}` };
  }
  const retries = parseRetries(env.KOOKR_SPAWN_CONNECT_RETRIES);
  for (let attempt = 0; attempt < retries; attempt++) {
    const probes = await Promise.all(
      PORTS_TO_TRY.map((port) => probeHealth(`http://127.0.0.1:${port}`, PROBE_TIMEOUT_MS)),
    );
    const up = PORTS_TO_TRY.filter((_, i) => probes[i]);
    if (up.length === 2) {
      return { kind: 'ambiguous', ports: PORTS_TO_TRY };
    }
    if (up.length === 1) {
      return { kind: 'auto', baseUrl: `http://127.0.0.1:${up[0]}`, port: up[0] };
    }
    if (attempt < retries - 1) {
      await sleep(RETRY_DELAY_MS);
    }
  }
  return { kind: 'none', ports: PORTS_TO_TRY, attempts: retries };
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- auth ----------

// Issue #708: when the server binds to a non-loopback host it requires a bearer
// token on state-changing requests (POST /api/tasks). Read it from
// KOOKR_API_TOKEN and send it as `Authorization: Bearer <token>`. Loopback
// servers ignore the header, so it is always safe to attach when present.
function apiAuthHeaders(env = process.env) {
  const token = env.KOOKR_API_TOKEN && env.KOOKR_API_TOKEN.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ---------- HTTP POST ----------

async function postTask({ baseUrl, prompt, cwd, agent, effort = null, criteria, disableDedup = false, metadataIntent = null, parentTaskId = null }) {
  const body = { prompt, cwd };
  if (criteria) body.criteria = criteria;
  if (agent) body.agentType = agent;
  if (effort) body.effort = effort;
  if (disableDedup) body.disableDedup = true;
  if (metadataIntent) body.metadata = { intent: metadataIntent };
  if (parentTaskId) body.parentTaskId = parentTaskId;

  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Kookr-Launch-Source': 'cli',
      'User-Agent': `kookr-spawn/${CLI_VERSION} node/${process.versions.node}`,
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
    // leave as null, fall through to error path below
  }

  if (!res.ok && res.status !== 200) {
    const msg = json?.error ?? (text || `HTTP ${res.status}`);
    return { kind: 'server_error', status: res.status, message: msg };
  }

  if (json?.duplicate === true) {
    const task = json.task ?? {};
    return { kind: 'duplicate', task };
  }

  // Success path — server returns the task object at 201, or the wrapped
  // { task, duplicate: true } at 200 (handled above).
  return { kind: 'created', task: json, queued: Boolean(json?.queued) };
}

// ---------- output rendering ----------

function formatSuccess({ task, baseUrl, queued }) {
  const id = task?.id ?? '';
  const agent = task?.agentType ?? '';
  const cwd = task?.cwd ?? '';
  const parent = typeof task?.parentTaskId === 'string' && task.parentTaskId.length > 0
    ? task.parentTaskId
    : null;
  const status = queued ? '⌛ Task queued' : '✓ Task created';
  const lines = [`task_id=${id}`];
  if (parent) lines.push(`parent_task_id=${parent}`);
  lines.push(
    status,
    `   agent:  ${agent}`,
    `   cwd:    ${cwd}`,
    `   server: ${baseUrl}`,
    `   open:   ${baseUrl}/#/tasks/${id}`,
  );
  if (parent) {
    lines.push(`   parent: ${baseUrl}/#/tasks/${parent}`);
  }
  return lines.join('\n');
}

function formatDedup({ task, baseUrl }) {
  const id = task?.id ?? '';
  return [
    `task_id=${id}`,
    'ℹ active task already exists for this prompt + cwd',
    `   open: ${baseUrl}/#/tasks/${id}`,
  ].join('\n');
}

function formatDuplicateWarning({ task }) {
  const id = task?.id ?? 'unknown';
  const status = task?.status ?? 'active';
  const cwd = task?.cwd ?? 'unknown cwd';
  const age = formatTaskAge(task?.createdAt);
  return `WARN: prompt matches active task ${id}${age ? ` (${status}, ${age}, repo: ${cwd})` : ` (${status}, repo: ${cwd})`}`;
}

function formatTaskAge(createdAt) {
  if (typeof createdAt !== 'string' && typeof createdAt !== 'number') return '';
  const then = new Date(createdAt).getTime();
  if (!Number.isFinite(then)) return '';
  const ageMs = Math.max(0, Date.now() - then);
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'running <1 min';
  if (minutes < 60) return `running ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `running ${hours}h` : `running ${hours}h ${rem}m`;
}

/**
 * Print the server-error message. If the server returned 404 and we sent a
 * parentTaskId, surface a targeted hint about --no-parent-task / --parent-task-id
 * instead of the generic "server returned 404: ..." form. Shared between the
 * initial-POST and dedupe-retry call sites so the wording stays in sync.
 */
function reportServerError({ result, baseUrl, parentTaskId, err }) {
  if (result.status === 404 && parentTaskId) {
    err.error(
      `kookr-spawn: parent task ${parentTaskId} not found on server (${baseUrl}).\n` +
      `Re-run with --no-parent-task to launch detached, or --parent-task-id <uuid> to override.`,
    );
    return;
  }
  err.error(`kookr-spawn: server returned ${result.status}: ${result.message}`);
}

function formatPromptDiff(existingPrompt, newPrompt) {
  const existingLines = String(existingPrompt ?? '').split('\n');
  const newLines = String(newPrompt ?? '').split('\n');
  const max = Math.max(existingLines.length, newLines.length);
  const lines = ['--- existing active task prompt', '+++ requested prompt'];
  for (let i = 0; i < max; i++) {
    const oldLine = existingLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) {
      if (oldLine !== undefined) lines.push(` ${oldLine}`);
      continue;
    }
    if (oldLine !== undefined) lines.push(`-${oldLine}`);
    if (newLine !== undefined) lines.push(`+${newLine}`);
  }
  return lines.join('\n');
}

function createLineReader(stdin) {
  const iterator = stdin[Symbol.asyncIterator]();
  let buffered = '';
  return async function readPromptLine() {
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

async function confirmDuplicateSpawn({ task, prompt, stdin, out, err }) {
  err.error(formatDuplicateWarning({ task }));
  if (!stdin || stdin.isTTY !== true) {
    err.error('kookr-spawn: duplicate active prompt blocked in non-interactive mode. Re-run with --dedupe=skip to keep it as an intentional duplicate.');
    return false;
  }

  const readPromptLine = createLineReader(stdin);
  for (;;) {
    out.log('Continue spawning a duplicate? [y/N/show diff]');
    const answer = (await readPromptLine())?.trim().toLowerCase() ?? '';
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'show diff' || answer === 'diff' || answer === 'd') {
      out.log(formatPromptDiff(task?.prompt, prompt));
      continue;
    }
    return false;
  }
}

// ---------- main ----------

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  cwd = process.cwd(),
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
      err.error(`kookr-spawn: ${e.message}`);
      err.error('Try --help.');
      return exit(EXIT_USER_ERROR);
    }
    throw e;
  }
  if (args.help) {
    out.log(HELP_TEXT);
    return exit(EXIT_OK);
  }

  let prompt;
  let cwdAbs;
  try {
    prompt = await resolvePrompt({ args, stdin, env });
    cwdAbs = resolveCwd(args.cwd, cwd);
  } catch (e) {
    if (e instanceof UsageError) {
      err.error(`kookr-spawn: ${e.message}`);
      return exit(EXIT_USER_ERROR);
    }
    throw e;
  }

  let resolved;
  try {
    resolved = await resolveBaseUrl({ env, sleep });
  } catch (e) {
    if (e instanceof UsageError) {
      err.error(`kookr-spawn: ${e.message}`);
      return exit(EXIT_USER_ERROR);
    }
    throw e;
  }

  if (resolved.kind === 'invalid_port') {
    err.error(`kookr-spawn: KOOKR_PORT must be an integer in 1..65535 (got: ${resolved.raw})`);
    return exit(EXIT_USER_ERROR);
  }
  if (resolved.kind === 'ambiguous') {
    err.error(
      `kookr-spawn: both Kookr instances are running on :${resolved.ports[0]} and :${resolved.ports[1]}.\n` +
      `Set KOOKR_PORT=${resolved.ports[0]} or KOOKR_PORT=${resolved.ports[1]} to choose.`,
    );
    return exit(EXIT_NO_SERVER);
  }
  if (resolved.kind === 'none') {
    err.error(
      `kookr-spawn: no Kookr server reachable on :${resolved.ports.join(' or :')} after ${resolved.attempts} attempts.\n` +
      `If Kookr is restarting (pnpm prod:update is running), wait a few seconds and retry.\n` +
      `To start one:\n` +
      `  pnpm --dir <your-kookr-checkout> start       (production, port 4800)\n` +
      `  pnpm --dir <your-kookr-checkout> dev          (development, port 4801)`,
    );
    return exit(EXIT_NO_SERVER);
  }

  const baseUrl = resolved.baseUrl;
  const parentTaskId = resolveParentTaskId({ args, env });

  let result;
  try {
    result = await postTask({
      baseUrl,
      prompt,
      cwd: cwdAbs,
      agent: args.agent,
      effort: args.effort,
      criteria: args.criteria,
      disableDedup: args.dedupe === 'skip',
      metadataIntent: args.dedupe === 'skip' ? 'keep_as_duplicate' : null,
      parentTaskId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err.error(`kookr-spawn: request failed: ${msg}`);
    err.error(`Check the dashboard at ${baseUrl} before re-running to avoid duplicate launches.`);
    return exit(EXIT_SERVER_ERROR);
  }

  if (result.kind === 'server_error') {
    reportServerError({ result, baseUrl, parentTaskId, err });
    return exit(EXIT_SERVER_ERROR);
  }

  if (result.kind === 'duplicate') {
    if (args.dedupe === 'skip') {
      out.log(formatDedup({ task: result.task, baseUrl }));
      return exit(EXIT_OK);
    }
    if (args.dedupe === 'block') {
      err.error(formatDuplicateWarning({ task: result.task }));
      err.error('kookr-spawn: duplicate active prompt blocked by --dedupe=block.');
      return exit(EXIT_DUPLICATE_BLOCKED);
    }
    const confirmed = await confirmDuplicateSpawn({
      task: result.task,
      prompt,
      stdin,
      out,
      err,
    });
    if (!confirmed) return exit(EXIT_DUPLICATE_BLOCKED);

    try {
      result = await postTask({
        baseUrl,
        prompt,
        cwd: cwdAbs,
        agent: args.agent,
        effort: args.effort,
        criteria: args.criteria,
        disableDedup: true,
        metadataIntent: 'keep_as_duplicate',
        parentTaskId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      err.error(`kookr-spawn: request failed: ${msg}`);
      err.error(`Check the dashboard at ${baseUrl} before re-running to avoid duplicate launches.`);
      return exit(EXIT_SERVER_ERROR);
    }
    if (result.kind === 'server_error') {
      reportServerError({ result, baseUrl, parentTaskId, err });
      return exit(EXIT_SERVER_ERROR);
    }
    if (result.kind === 'duplicate') {
      err.error('kookr-spawn: server still reported a duplicate after confirmation.');
      return exit(EXIT_SERVER_ERROR);
    }
  }

  out.log(formatSuccess({ task: result.task, baseUrl, queued: result.queued }));
  return exit(EXIT_OK);
}

// ---------- entry guard (so tests can import without running) ----------

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
  console.error('[kookr] WARNING: `kookr-spawn` is deprecated; use `kookr spawn`.');
  main().catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`kookr-spawn: ${msg}`);
    process.exit(1);
  });
}

export {
  CLI_VERSION,
  apiAuthHeaders,
  EXIT_DUPLICATE_BLOCKED,
  EXIT_NO_SERVER,
  EXIT_OK,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  HELP_TEXT,
  UsageError,
  formatDedup,
  formatSuccess,
  main,
  parseArgs,
  parseMaxBytes,
  parsePortEnv,
  parseRetries,
  postTask,
  probeHealth,
  resolveBaseUrl,
  resolveCwd,
  resolveParentTaskId,
  resolvePrompt,
};
