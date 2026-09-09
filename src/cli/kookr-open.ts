/**
 * `kookr open [taskId]` — open the running dashboard in the operator's browser
 * on demand (issue #3102).
 *
 * The dashboard is auto-opened only once, at server start, and that auto-open is
 * deliberately skipped for CI / non-TTY / non-loopback / `--watch` starts
 * (issue #2486). After the tab is closed, or on a suppressed start, the only way
 * back was to copy the URL from the log by hand. This verb is the on-demand,
 * terminal-first counterpart to the launch/lifecycle commands (`kookr spawn` /
 * `kookr stop`), and reuses `kookr stop`'s instance discovery, error codes, and
 * `--json` envelope so the whole CLI surface behaves consistently.
 *
 *   kookr open            → open the base dashboard of the running instance
 *   kookr open <taskId>   → deep-link to that task's detail view
 *
 * Opening is best-effort: unlike a mutating verb, a remote (non-loopback)
 * instance or a host with no platform opener prints the URL and still exits 0
 * (never fail just because we cannot spawn a browser).
 */

import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, join } from 'node:path';

import { dashboardTaskUrl } from '../shared/dashboard-task-url.js';
import {
  EXIT_AMBIGUOUS,
  EXIT_NO_SERVER,
  EXIT_OK,
  EXIT_USER_ERROR,
  resolveStopBaseUrl,
} from './kookr-stop.js';

const PORTS_TO_TRY = [4800, 4801] as const;

export const HELP_TEXT = `kookr open — open the running dashboard in your browser.

Usage:
  kookr open [taskId] [--json]

Opens the dashboard served by the running Kookr instance in your default
browser. With a taskId, deep-links to that task's detail view; an unknown id
still opens the base dashboard.

Options:
  --json       Print one machine-readable JSON envelope instead of human text.
  -h, --help   Show this help.

Environment:
  KOOKR_API_BASE_URL   Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT           Specific port on 127.0.0.1 (overrides auto-detect).

Instance discovery mirrors \`kookr stop\`: KOOKR_API_BASE_URL wins, else
KOOKR_PORT, else the default ports ${PORTS_TO_TRY.join(' / ')} are probed.

Exit codes:
  0  Success (browser launched, or URL printed for a remote/headless host).
  2  User error.       3  No server reachable.       5  Ambiguous port.
`;

// Inlined from src/server/bootstrap/open-dashboard-browser.ts and
// src/server/auth.ts to keep this thin CLI free of the hono/server dependency
// graph those modules pull in transitively — the same self-contained shape as
// kookr-stop / kookr-drain. Kept in sync by intent.

/** The platform's default browser-opener command, or undefined if none. */
export function dashboardBrowserCommand(platform: NodeJS.Platform): string | undefined {
  if (platform === 'darwin') return 'open';
  if (platform === 'linux') return 'xdg-open';
  return undefined;
}

/** Whether `host` names the local loopback interface. */
export function isLoopbackHost(host: string | undefined | null): boolean {
  if (host === undefined || host === null) return false;
  let normalized = host.trim().toLowerCase();
  if (normalized === '') return false;
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized === '127.0.0.1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
  );
}

/** Test seam: spawn the platform opener on `url`. Defaults to `execFile`. */
export type OpenUrl = (command: string, url: string) => void;

export interface OpenCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  fetchImpl?: typeof fetch;
  /** Test seam for the browser launch. Defaults to `execFile` with no shell. */
  openUrl?: OpenUrl;
  platform?: NodeJS.Platform;
  /** Test seam: whether the opener command resolves. Defaults to a PATH scan. */
  commandExists?: (command: string) => boolean;
}

export interface ParsedOpenArgs {
  taskId?: string;
  json: boolean;
  help: boolean;
  error?: string;
}

/** Parse `kookr open` argv. The first positional token is the task id. */
export function parseOpenArgs(argv: string[]): ParsedOpenArgs {
  const out: ParsedOpenArgs = { json: false, help: false };
  for (const tok of argv) {
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok.startsWith('-') && tok !== '-') {
      if (out.error === undefined) out.error = `unknown option: ${tok}`;
    } else if (out.taskId === undefined) {
      out.taskId = tok;
    } else {
      if (out.error === undefined) out.error = `unexpected extra argument: ${tok}`;
    }
  }
  return out;
}

/**
 * Build the dashboard URL for `baseUrl`, deep-linking to the given task when a
 * task id is provided. Uses the canonical `/?task=<id>` contract from
 * `dashboard-task-url.ts` — the form the SPA actually consumes on first paint
 * (there is no `/#/tasks/<id>` hash route) — so `kookr open <id>` selects the
 * task rather than only opening the base dashboard.
 */
export function buildOpenUrl(baseUrl: string, taskId: string | undefined): string {
  return taskId ? dashboardTaskUrl(baseUrl, taskId) : baseUrl;
}

/**
 * Authorization for the loopback health probe, mirroring `kookr stop`'s
 * discovery: forward the supervisor token when set, else the API token, else
 * nothing (the loopback-open default).
 */
function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const supervisor = env.KOOKR_SUPERVISOR_TOKEN?.trim();
  if (supervisor) return { Authorization: `Bearer ${supervisor}` };
  const apiToken = env.KOOKR_API_TOKEN?.trim();
  if (apiToken) return { Authorization: `Bearer ${apiToken}` };
  return {};
}

/**
 * Confirm a loopback target is actually serving before we open a browser at it.
 * Unlike a mutating verb, `kookr open` issues no follow-up request, so an
 * explicit `KOOKR_PORT` / `KOOKR_API_BASE_URL` pointing at a dead loopback port
 * would otherwise silently open a dead URL — probe `/api/health` so that case
 * reports NO_SERVER like the auto-detect path.
 */
async function isServerAlive(baseUrl: string, fetchImpl: typeof fetch, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/health`, {
      headers: authHeaders(env),
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Whether `command` resolves to an executable — an absolute/relative path that
 * is executable, or a bare name found on `PATH`. Lets a headless host with no
 * `xdg-open` installed take the print-the-URL fallback instead of spawning a
 * missing binary and wrongly reporting the browser as opened.
 */
export function commandExistsOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const canExec = (file: string): boolean => {
    try {
      accessSync(file, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (command.includes('/')) return canExec(command);
  const pathDirs = (env.PATH ?? '').split(delimiter).filter((d) => d.length > 0);
  return pathDirs.some((dir) => canExec(join(dir, command)));
}

function hostnameOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

function defaultOpenUrl(command: string, url: string, logWarn: (message: string) => void): void {
  // No timeout and unref(): a just-launched browser must outlive this CLI
  // process, and a hanging opener must not keep it alive. A failed spawn (no
  // opener installed, no $DISPLAY) surfaces asynchronously through this
  // callback — log it like the server-start opener in open-dashboard-browser.ts
  // rather than swallow it, so the failure is at least visible on stderr.
  const child = execFile(command, [url], (err) => {
    if (err) logWarn(`Failed to open dashboard in browser (${command}): ${err.message}`);
  });
  child.unref();
}

function emitJson(
  out: { log: (...args: unknown[]) => void },
  payload: { ok: boolean; code: string; message: string; details?: unknown },
): void {
  out.log(JSON.stringify(payload));
}

export async function runOpenCli(argv: string[], io: OpenCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const fetchImpl = io.fetchImpl ?? fetch;
  const platform = io.platform ?? process.platform;

  const args = parseOpenArgs(argv);
  if (args.help) {
    out.log(HELP_TEXT);
    return EXIT_OK;
  }

  if (args.error) {
    const message = args.error;
    if (args.json) {
      emitJson(out, { ok: false, code: 'USER_ERROR', message, details: { subcommand: 'open' } });
    } else {
      err.error(`kookr open: ${message}`);
      err.error('Run `kookr open --help` for usage.');
    }
    return EXIT_USER_ERROR;
  }

  const resolvedBase = await resolveStopBaseUrl({ env, fetchImpl });
  if (resolvedBase.kind === 'invalid_port') {
    const message = `KOOKR_PORT must be an integer in 1..65535 (got: ${resolvedBase.raw})`;
    if (args.json) {
      emitJson(out, { ok: false, code: 'USER_ERROR', message, details: { subcommand: 'open' } });
    } else {
      err.error(`kookr open: ${message}`);
    }
    return EXIT_USER_ERROR;
  }
  if (resolvedBase.kind === 'ambiguous') {
    const [a, b] = resolvedBase.ports;
    const message = `two Kookr instances are reachable on :${a} and :${b}. Set KOOKR_PORT to choose one.`;
    if (args.json) {
      emitJson(out, { ok: false, code: 'AMBIGUOUS_PORT', message, details: { ports: resolvedBase.ports } });
    } else {
      err.error(`kookr open: ${message}`);
    }
    return EXIT_AMBIGUOUS;
  }
  if (resolvedBase.kind === 'none') {
    const message = `no Kookr server reachable (checked ports ${PORTS_TO_TRY.join(', ')}). Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.`;
    if (args.json) {
      emitJson(out, { ok: false, code: 'NO_SERVER', message, details: { subcommand: 'open' } });
    } else {
      err.error(`kookr open: ${message}`);
    }
    return EXIT_NO_SERVER;
  }

  const url = buildOpenUrl(resolvedBase.baseUrl, args.taskId);
  const taskId = args.taskId ?? null;
  const hostname = hostnameOf(resolvedBase.baseUrl);

  // Mirror the server-start loopback guard: only launch a browser for a local
  // instance. A remote URL is printed for the operator to open themselves (and
  // is not liveness-probed — a remote instance may be firewalled to browsers).
  if (!isLoopbackHost(hostname)) {
    return printUrl(out, args.json, { url, taskId, reason: 'non-loopback' });
  }

  // Confirm the loopback target is actually serving before opening. This turns
  // an explicit KOOKR_PORT / KOOKR_API_BASE_URL that points at a dead port into
  // NO_SERVER instead of silently opening a dead URL (the auto-detect path
  // already probed, so this only bites the explicit-override case).
  if (!(await isServerAlive(resolvedBase.baseUrl, fetchImpl, env))) {
    const message = `no Kookr server reachable at ${resolvedBase.baseUrl}. Start the server or point KOOKR_PORT / KOOKR_API_BASE_URL at a running instance.`;
    if (args.json) {
      emitJson(out, { ok: false, code: 'NO_SERVER', message, details: { subcommand: 'open', baseUrl: resolvedBase.baseUrl } });
    } else {
      err.error(`kookr open: ${message}`);
    }
    return EXIT_NO_SERVER;
  }

  const command = dashboardBrowserCommand(platform);
  // No opener for this platform, or the opener binary is not installed (a
  // headless host without `xdg-open`) → print the URL rather than spawn a
  // missing binary and wrongly report the browser as opened.
  const commandExists = io.commandExists ?? ((cmd: string) => commandExistsOnPath(cmd, env));
  if (!command || !commandExists(command)) {
    return printUrl(out, args.json, { url, taskId, reason: 'no-opener' });
  }

  const launch = io.openUrl ?? ((cmd, target) => defaultOpenUrl(cmd, target, (m) => err.error(m)));
  try {
    launch(command, url);
  } catch {
    // A synchronous spawn failure is still not a hard error for a best-effort
    // open — fall back to printing the URL. (A failure that surfaces only
    // asynchronously is logged by defaultOpenUrl; the browser cannot be
    // confirmed open synchronously, so `opened` means "opener spawned".)
    return printUrl(out, args.json, { url, taskId, reason: 'no-opener' });
  }

  if (args.json) {
    emitJson(out, {
      ok: true,
      code: 'OK',
      message: `Opening dashboard: ${url}`,
      details: { url, taskId, opened: true, command },
    });
  } else {
    out.log(`Opening dashboard: ${url}`);
  }
  return EXIT_OK;
}

function printUrl(
  out: { log: (...args: unknown[]) => void },
  json: boolean,
  { url, taskId, reason }: { url: string; taskId: string | null; reason: 'non-loopback' | 'no-opener' },
): number {
  if (json) {
    emitJson(out, {
      ok: true,
      code: 'OK',
      message: url,
      details: { url, taskId, opened: false, reason },
    });
  } else {
    const why =
      reason === 'non-loopback'
        ? 'Remote instance — open this URL yourself:'
        : 'No browser opener on this host — open this URL yourself:';
    out.log(`${why} ${url}`);
  }
  return EXIT_OK;
}
