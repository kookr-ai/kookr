#!/usr/bin/env node
// kookr-spawn — create a Kookr task for the current working directory.
//
// Usage:
//   kookr-spawn "prompt text"
//   kookr-spawn --prompt-file /tmp/prompt.md
//   cat prompt.md | kookr-spawn
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

// ---------- arg parsing ----------

const HELP_TEXT = `kookr-spawn — create a Kookr task from the current working directory.

Usage:
  kookr-spawn [OPTIONS] [PROMPT...]
  kookr-spawn --prompt-file <path> [OPTIONS]
  cat prompt.md | kookr-spawn [OPTIONS]

Options:
  -C, --cwd <path>         Working directory for the task (default: cwd).
  -a, --agent <type>       claude-code or codex-cli (default: server default).
      --criteria <text>    Acceptance criteria. Note: this is argv-exposed.
  -f, --prompt-file <path> Read prompt from a file (hook-safe).
  -h, --help               Show this help.

Environment:
  KOOKR_API_BASE_URL              Base URL of a running Kookr server
                                   (overrides auto-detect).
  KOOKR_PORT                      Specific port on 127.0.0.1 (overrides auto-detect).
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
  4  Server returned an error.`;

function parseArgs(argv) {
  const out = {
    prompt: null,
    positional: [],
    cwd: null,
    agent: null,
    criteria: null,
    promptFile: null,
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
    } else if (tok === '--criteria') {
      out.criteria = eat();
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
  return out;
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

// ---------- HTTP POST ----------

async function postTask({ baseUrl, prompt, cwd, agent, criteria }) {
  const body = { prompt, cwd };
  if (criteria) body.criteria = criteria;
  if (agent) body.agentType = agent;

  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Kookr-Launch-Source': 'cli',
      'User-Agent': `kookr-spawn/${CLI_VERSION} node/${process.versions.node}`,
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
  const status = queued ? '⌛ Task queued' : '✓ Task created';
  const lines = [
    `task_id=${id}`,
    status,
    `   agent:  ${agent}`,
    `   cwd:    ${cwd}`,
    `   server: ${baseUrl}`,
    `   open:   ${baseUrl}/#/tasks/${id}`,
  ];
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

  let result;
  try {
    result = await postTask({
      baseUrl,
      prompt,
      cwd: cwdAbs,
      agent: args.agent,
      criteria: args.criteria,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err.error(`kookr-spawn: request failed: ${msg}`);
    err.error(`Check the dashboard at ${baseUrl} before re-running to avoid duplicate launches.`);
    return exit(EXIT_SERVER_ERROR);
  }

  if (result.kind === 'server_error') {
    err.error(`kookr-spawn: server returned ${result.status}: ${result.message}`);
    return exit(EXIT_SERVER_ERROR);
  }

  if (result.kind === 'duplicate') {
    out.log(formatDedup({ task: result.task, baseUrl }));
    return exit(EXIT_OK);
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
  main().catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`kookr-spawn: ${msg}`);
    process.exit(1);
  });
}

export {
  CLI_VERSION,
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
  resolvePrompt,
};
