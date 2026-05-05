#!/usr/bin/env node
// `kookr ralph` subcommands for inspecting and controlling task-scoped Ralph
// loops. Kept dependency-free so the package bin works before TypeScript build.

import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const PORTS_TO_TRY = [4800, 4801];
const PROBE_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 5000;

const EXIT_OK = 0;
const EXIT_USER_ERROR = 2;
const EXIT_NO_SERVER = 3;
const EXIT_SERVER_ERROR = 4;

const HELP_TEXT = `kookr ralph — inspect or control a Ralph loop.

Usage:
  kookr ralph status <taskId>
  kookr ralph pause <taskId>
  kookr ralph resume <taskId>
  kookr ralph cancel <taskId>

Environment:
  KOOKR_API_BASE_URL   Base URL of a running Kookr server.
  KOOKR_PORT           Specific port on 127.0.0.1.
`;

class UsageError extends Error {}

function parseRalphArgs(argv) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    return { help: true };
  }
  const [command, taskId, ...rest] = argv;
  if (!['status', 'pause', 'resume', 'cancel'].includes(command)) {
    throw new UsageError(`unknown Ralph command: ${command}`);
  }
  if (!taskId || taskId.startsWith('-')) {
    throw new UsageError(`kookr ralph ${command} requires <taskId>`);
  }
  if (rest.length > 0) {
    throw new UsageError(`unexpected argument: ${rest[0]}`);
  }
  return { help: false, command, taskId };
}

function parsePortEnv(raw) {
  if (raw === undefined || raw === '') return { kind: 'unset' };
  const trimmed = String(raw).trim();
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { kind: 'invalid', raw: trimmed };
  }
  return { kind: 'valid', port };
}

async function fetchJson(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Keep null; callers use text for the error fallback.
  }
  return { res, json, text };
}

async function probeHealth(baseUrl) {
  try {
    const { res, json } = await fetchJson(`${baseUrl}/api/health`, {}, PROBE_TIMEOUT_MS);
    return res.ok && typeof json?.serverStartedAt === 'string';
  } catch {
    return false;
  }
}

async function resolveBaseUrl(env = process.env) {
  if (env.KOOKR_API_BASE_URL && env.KOOKR_API_BASE_URL.trim() !== '') {
    return { kind: 'explicit', baseUrl: env.KOOKR_API_BASE_URL.trim().replace(/\/+$/, '') };
  }
  const parsed = parsePortEnv(env.KOOKR_PORT);
  if (parsed.kind === 'invalid') return { kind: 'invalid_port', raw: parsed.raw };
  if (parsed.kind === 'valid') return { kind: 'explicit', baseUrl: `http://127.0.0.1:${parsed.port}` };

  const probes = await Promise.all(
    PORTS_TO_TRY.map((port) => probeHealth(`http://127.0.0.1:${port}`)),
  );
  const up = PORTS_TO_TRY.filter((_, i) => probes[i]);
  if (up.length > 1) return { kind: 'ambiguous', ports: up };
  if (up.length === 1) return { kind: 'auto', baseUrl: `http://127.0.0.1:${up[0]}`, port: up[0] };
  return { kind: 'none', ports: PORTS_TO_TRY };
}

async function requestRalphStatus({ baseUrl, taskId }) {
  const { res, json, text } = await fetchJson(`${baseUrl}/api/tasks`);
  if (!res.ok) {
    return { kind: 'server_error', status: res.status, message: json?.error ?? text ?? `HTTP ${res.status}` };
  }
  if (!Array.isArray(json)) {
    return { kind: 'server_error', status: res.status, message: 'unexpected /api/tasks response' };
  }
  const task = json.find((item) => item?.id === taskId);
  if (!task) return { kind: 'not_found', taskId };
  if (!task.ralphLoop) return { kind: 'no_loop', taskId, task };
  return { kind: 'status', taskId, task, ralphLoop: task.ralphLoop };
}

async function requestRalphControl({ baseUrl, command, taskId }) {
  const method = command === 'cancel' ? 'DELETE' : 'POST';
  const suffix = command === 'cancel' ? '' : `/${command}`;
  const { res, json, text } = await fetchJson(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/ralph-loop${suffix}`, {
    method,
    headers: { 'User-Agent': `kookr-ralph node/${process.versions.node}` },
  });
  if (!res.ok) {
    return { kind: 'server_error', status: res.status, message: json?.error ?? text ?? `HTTP ${res.status}` };
  }
  return { kind: 'controlled', command, taskId, body: json };
}

function renderRalphStatus(result) {
  if (result.kind === 'not_found') return `Task not found: ${result.taskId}`;
  if (result.kind === 'no_loop') return [`task_id=${result.taskId}`, 'No Ralph loop attached.'].join('\n');
  const loop = result.ralphLoop;
  const lines = [
    `task_id=${result.taskId}`,
    `status=${loop.status}`,
    `iteration=${loop.currentIteration}/${loop.iterationCap}`,
    `cumulative_iterations=${loop.cumulativeIterations}`,
  ];
  if (loop.stopPredicate) lines.push(`stop_predicate=${loop.stopPredicate}`);
  return lines.join('\n');
}

function renderRalphControl(result) {
  const status = result.body?.status ?? result.body?.ralphLoop?.status ?? 'unknown';
  return `Ralph loop ${result.command} OK for task ${result.taskId} (status=${status}).`;
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  out = console,
  err = console,
  exit = process.exit,
} = {}) {
  let args;
  try {
    args = parseRalphArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      err.error(`kookr ralph: ${e.message}`);
      err.error('Try `kookr ralph --help`.');
      return exit(EXIT_USER_ERROR);
    }
    throw e;
  }

  if (args.help) {
    out.log(HELP_TEXT);
    return exit(EXIT_OK);
  }

  const resolved = await resolveBaseUrl(env);
  if (resolved.kind === 'invalid_port') {
    err.error(`kookr ralph: KOOKR_PORT must be an integer in 1..65535 (got: ${resolved.raw})`);
    return exit(EXIT_USER_ERROR);
  }
  if (resolved.kind === 'ambiguous') {
    err.error(`kookr ralph: multiple Kookr instances are running (${resolved.ports.map((p) => `:${p}`).join(', ')}). Set KOOKR_PORT.`);
    return exit(EXIT_NO_SERVER);
  }
  if (resolved.kind === 'none') {
    err.error(`kookr ralph: no Kookr server reachable on :${resolved.ports.join(' or :')}.`);
    return exit(EXIT_NO_SERVER);
  }

  let result;
  try {
    result = args.command === 'status'
      ? await requestRalphStatus({ baseUrl: resolved.baseUrl, taskId: args.taskId })
      : await requestRalphControl({ baseUrl: resolved.baseUrl, command: args.command, taskId: args.taskId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err.error(`kookr ralph: request failed: ${msg}`);
    return exit(EXIT_SERVER_ERROR);
  }

  if (result.kind === 'server_error') {
    err.error(`kookr ralph: server returned ${result.status}: ${result.message}`);
    return exit(EXIT_SERVER_ERROR);
  }
  if (result.kind === 'not_found') {
    err.error(renderRalphStatus(result));
    return exit(EXIT_SERVER_ERROR);
  }

  out.log(result.kind === 'controlled' ? renderRalphControl(result) : renderRalphStatus(result));
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
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`kookr ralph: ${msg}`);
    process.exit(1);
  });
}

export {
  EXIT_NO_SERVER,
  EXIT_OK,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  HELP_TEXT,
  UsageError,
  main,
  parsePortEnv,
  parseRalphArgs,
  renderRalphControl,
  renderRalphStatus,
  requestRalphControl,
  requestRalphStatus,
  resolveBaseUrl,
};
