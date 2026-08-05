#!/usr/bin/env node
// Kookr CLI drain / resume control (issue #659). Cordons a running Kookr node so
// it refuses *new* task launches while already-running agents finish on their own
// schedule — useful before a maintenance restart. Resume re-opens launches.
//
// Talks to the running server's admin endpoints (see
// src/server/routes/admin-routes.ts):
//   kookr drain           POST /api/admin/drain   → stop accepting launches
//   kookr resume          POST /api/admin/resume  → accept launches again
//   kookr drain status    GET  /api/admin/drain   → print current state
//
// Pass --json to any of these to emit a single machine-readable envelope
// instead of human text: { ok:true, draining, since, runningTasks, changed } on
// success, or { ok:false, code, message } on failure (mirroring `kookr status
// --json`), so scripts can branch on `ok` and read the exit code.
//
// Loopback is trusted by the server, so no token is needed for local use; if
// KOOKR_ADMIN_TOKEN is set it is forwarded via the x-kookr-admin-token header.

import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolvePort } from './kookr-status.js';

const ADMIN_TOKEN_HEADER = 'x-kookr-admin-token';

function adminHeaders(env) {
  const token = env.KOOKR_ADMIN_TOKEN?.trim();
  return token ? { [ADMIN_TOKEN_HEADER]: token } : {};
}

function formatStatus(body) {
  const state = body.draining ? 'DRAINING (refusing new launches)' : 'ACCEPTING new launches';
  const lines = [`Kookr is ${state}.`];
  if (body.draining && body.since) lines.push(`Draining since: ${body.since}`);
  if (typeof body.runningTasks === 'number') lines.push(`Running tasks:  ${body.runningTasks}`);
  return lines.join('\n');
}

/**
 * Emit a failure and return its exit code. In --json mode this prints an
 * `{ ok: false, code, message }` envelope (mirroring `kookr status --json`) so
 * scripts can discriminate failure via `ok`; otherwise the human message goes to
 * stderr exactly as before — the non-JSON text path is byte-for-byte unchanged.
 */
function fail(out, json, { code, message, exitCode }) {
  if (json) {
    out.log(JSON.stringify({ ok: false, code, message }));
  } else {
    out.error(message);
  }
  return exitCode;
}

/**
 * @param {string[]} argv  CLI args after `kookr` (e.g. ['drain'], ['resume'], ['drain','status'])
 */
async function runDrainCli(argv, { env = process.env, out = console, fetchImpl = fetch } = {}) {
  // Strip `--json` before deriving the verb/action so `kookr drain status --json`
  // (or the flag in any position) still resolves the read-only status action.
  const json = argv.includes('--json');
  const positional = argv.filter((tok) => tok !== '--json');
  const verb = positional[0];
  if (verb !== 'drain' && verb !== 'resume') {
    return fail(out, json, {
      code: 'USER_ERROR',
      message: 'Usage: kookr <drain|resume|drain status> [--json]',
      exitCode: 2,
    });
  }
  // `kookr drain status` reads state without mutating; `kookr drain` / `kookr resume` mutate.
  const action = verb === 'drain' && positional[1] === 'status' ? 'status' : verb;

  const resolved = await resolvePort(env);
  if (resolved.kind === 'invalid') {
    return fail(out, json, {
      code: 'USER_ERROR',
      message: `KOOKR_PORT must be an integer between 1 and 65535 (got: ${JSON.stringify(resolved.raw)}).`,
      exitCode: 1,
    });
  }
  if (resolved.kind === 'none') {
    return fail(out, json, {
      code: 'NO_SERVER',
      message: 'Kookr is not running on the default ports. Set KOOKR_PORT if using a non-default port.',
      exitCode: 1,
    });
  }

  const base = `http://127.0.0.1:${resolved.port}`;
  const path = action === 'resume' ? '/api/admin/resume' : '/api/admin/drain';
  const method = action === 'status' ? 'GET' : 'POST';

  let res;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method,
      headers: adminHeaders(env),
      signal: AbortSignal.timeout(2000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(out, json, {
      code: 'UNREACHABLE',
      message: `Failed to reach Kookr on port ${resolved.port}: ${msg}`,
      exitCode: 1,
    });
  }

  const body = await res.json().catch(() => ({}));
  if (res.status === 403) {
    return fail(out, json, {
      code: 'FORBIDDEN',
      message: 'Forbidden: admin auth required. Run on the same host (loopback) or set KOOKR_ADMIN_TOKEN.',
      exitCode: 1,
    });
  }
  if (!res.ok) {
    return fail(out, json, {
      code: 'HTTP_ERROR',
      message: `Request failed: HTTP ${res.status} ${JSON.stringify(body)}`,
      exitCode: 1,
    });
  }

  if (json) {
    // Machine-readable envelope mirroring `kookr status --json`. Fields default
    // to null so consumers see a stable shape (e.g. GET status omits `changed`).
    out.log(
      JSON.stringify({
        ok: true,
        draining: body.draining ?? null,
        since: body.since ?? null,
        runningTasks: body.runningTasks ?? null,
        changed: body.changed ?? null,
      }),
    );
    return 0;
  }

  if (action === 'drain' && body.changed === false) {
    out.log('Already draining.');
  } else if (action === 'resume' && body.changed === false) {
    out.log('Already accepting (not draining).');
  }
  out.log(formatStatus(body));
  return 0;
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
  runDrainCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`kookr-drain: ${msg}`);
      process.exit(1);
    });
}

export { runDrainCli, formatStatus };
