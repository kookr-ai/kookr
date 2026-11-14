/**
 * `kookr chain` — start or stop a playbook chain from the terminal (RFC:
 * docs/rfc/rfc-playbook-chains.md). A chain repeats one playbook as a series of
 * tasks; Kookr launches each next iteration itself.
 *
 *   kookr chain start <playbook> [--scope s] [--param k=v]... [--iterations N] [--hours H] [-C dir] [--json]
 *   kookr chain stop [<taskId>] [--reason TEXT] [--json]
 *
 * Thin HTTP client over `POST /api/playbook-chains` and
 * `POST /api/tasks/:id/chain/stop`.
 */

import { resolve } from 'node:path';

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 2;
export const EXIT_NO_SERVER = 3;
export const EXIT_SERVER_ERROR = 4;

const REQUEST_TIMEOUT_MS = 60_000;

export const CHAIN_HELP_TEXT = `kookr chain — repeat a playbook as a chain of tasks.

Kookr launches the next iteration itself when the current one completes, until
the iteration count or the time limit is reached. The agent does not need to
spawn anything.

Usage:
  kookr chain start <playbook> [--scope project|user|plugin] [--param NAME=VALUE]...
                    [--iterations N] [--hours H] [--minutes M] [-C DIR] [--json]
  kookr chain stop [<taskId>] [--reason TEXT] [--json]

start  Launch iteration 1. Give --iterations, --hours/--minutes, or both (the
       first limit reached ends the chain). <playbook> is the playbook file,
       e.g. agentic-capability-research.md. DIR (default: current directory)
       is both the playbook source checkout and the task's working directory.
stop   Stop the chain after its current iteration finishes. <taskId> may be any
       task of the chain; it defaults to $KOOKR_TASK_ID, so an agent inside a
       chain iteration can run plain \`kookr chain stop --reason "..."\`.

Environment:
  KOOKR_API_BASE_URL  Base URL of the Kookr server (default http://127.0.0.1:$KOOKR_PORT or :4800).
  KOOKR_PORT          Port on 127.0.0.1.
  KOOKR_API_TOKEN     Bearer token for a non-loopback server.
  KOOKR_TASK_ID       Default task for \`stop\`; also marks the stop as requested by the agent.

Exit codes:
  0  Success.   2  User error.   3  No server reachable.   4  Server/HTTP error.
`;

export interface ChainCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  cwd?: string;
  fetchImpl?: typeof fetch;
}

type Parsed =
  | { kind: 'help' }
  | { kind: 'error'; message: string; json: boolean }
  | {
      kind: 'start';
      json: boolean;
      playbook: string;
      scope?: string;
      params: Record<string, string>;
      maxIterations?: number;
      durationMinutes?: number;
      dir?: string;
    }
  | { kind: 'stop'; json: boolean; taskId?: string; reason?: string };

export function parseChainArgs(argv: string[]): Parsed {
  const json = argv.includes('--json');
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) return { kind: 'help' };
  const [verb, ...rest] = argv;
  const fail = (message: string): Parsed => ({ kind: 'error', message, json });
  const positional: string[] = [];
  const params: Record<string, string> = {};
  let scope: string | undefined;
  let iterations: string | undefined;
  let hours: string | undefined;
  let minutes: string | undefined;
  let dir: string | undefined;
  let reason: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    const value = (): string | undefined => {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) return undefined;
      i++;
      return next;
    };
    if (tok === '--json') continue;
    if (tok === '--scope') scope = value() ?? '';
    else if (tok === '--param') {
      const pair = value();
      const eq = pair?.indexOf('=') ?? -1;
      if (!pair || eq <= 0) return fail('--param needs NAME=VALUE');
      params[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (tok === '--iterations') iterations = value() ?? '';
    else if (tok === '--hours') hours = value() ?? '';
    else if (tok === '--minutes') minutes = value() ?? '';
    else if (tok === '-C' || tok === '--cwd') dir = value() ?? '';
    else if (tok === '--reason') reason = value() ?? '';
    else if (tok.startsWith('-')) return fail(`unknown option: ${tok}`);
    else positional.push(tok);
  }

  if (verb === 'stop') {
    if (positional.length > 1) return fail('stop takes at most one task id');
    if (reason === '') return fail('--reason needs a value');
    return { kind: 'stop', json, ...(positional[0] ? { taskId: positional[0] } : {}), ...(reason ? { reason } : {}) };
  }
  if (verb !== 'start') return fail(`unknown verb: ${verb} (expected start or stop)`);
  if (positional.length !== 1) return fail('start needs exactly one playbook, e.g. `kookr chain start my-playbook.md --iterations 5`');
  if (scope !== undefined && !['project', 'user', 'plugin'].includes(scope)) return fail('--scope must be project, user, or plugin');
  if (dir === '') return fail('-C needs a directory');

  let maxIterations: number | undefined;
  if (iterations !== undefined) {
    maxIterations = Number(iterations);
    if (!Number.isInteger(maxIterations) || maxIterations < 1) return fail('--iterations must be a positive integer');
  }
  let durationMinutes: number | undefined;
  if (hours !== undefined || minutes !== undefined) {
    const h = hours === undefined ? 0 : Number(hours);
    const m = minutes === undefined ? 0 : Number(minutes);
    if (!Number.isFinite(h) || h < 0 || !Number.isFinite(m) || m < 0) return fail('--hours and --minutes must be non-negative numbers');
    durationMinutes = Math.round(h * 60 + m);
    if (durationMinutes < 1) return fail('the time limit must be at least one minute');
  }
  if (maxIterations === undefined && durationMinutes === undefined) {
    return fail('give --iterations, --hours/--minutes, or both');
  }
  return {
    kind: 'start',
    json,
    playbook: positional[0],
    ...(scope ? { scope } : {}),
    params,
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    ...(dir ? { dir } : {}),
  };
}

function baseUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.KOOKR_API_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const port = env.KOOKR_PORT?.trim();
  return `http://127.0.0.1:${port && /^\d+$/.test(port) ? port : '4800'}`;
}

export async function runChainCli(argv: string[], io: ChainCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const fetchImpl = io.fetchImpl ?? fetch;
  const parsed = parseChainArgs(argv);

  if (parsed.kind === 'help') {
    out.log(CHAIN_HELP_TEXT);
    return EXIT_OK;
  }
  if (parsed.kind === 'error') {
    if (parsed.json) out.log(JSON.stringify({ ok: false, error: parsed.message }));
    else err.error(`kookr chain: ${parsed.message}\nRun \`kookr chain --help\` for usage.`);
    return EXIT_USER_ERROR;
  }

  let url: string;
  let body: Record<string, unknown>;
  if (parsed.kind === 'start') {
    url = `${baseUrl(env)}/api/playbook-chains`;
    body = {
      playbookPath: parsed.playbook,
      cwd: resolve(io.cwd ?? process.cwd(), parsed.dir ?? '.'),
      ...(parsed.scope ? { scope: parsed.scope } : {}),
      parameterValues: parsed.params,
      ...(parsed.maxIterations !== undefined ? { maxIterations: parsed.maxIterations } : {}),
      ...(parsed.durationMinutes !== undefined ? { durationMinutes: parsed.durationMinutes } : {}),
    };
  } else {
    const ownTaskId = env.KOOKR_TASK_ID?.trim() || undefined;
    const taskId = parsed.taskId ?? ownTaskId;
    if (!taskId) {
      const message = 'no task id given and $KOOKR_TASK_ID is not set';
      if (parsed.json) out.log(JSON.stringify({ ok: false, error: message }));
      else err.error(`kookr chain: ${message}`);
      return EXIT_USER_ERROR;
    }
    url = `${baseUrl(env)}/api/tasks/${encodeURIComponent(taskId)}/chain/stop`;
    body = {
      by: ownTaskId !== undefined && taskId === ownTaskId ? 'agent' : 'operator',
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    };
  }

  const token = env.KOOKR_API_TOKEN?.trim();
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Kookr-Launch-Source': 'cli',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const message = `could not reach Kookr at ${url}: ${e instanceof Error ? e.message : String(e)}`;
    if (parsed.json) out.log(JSON.stringify({ ok: false, error: message }));
    else err.error(`kookr chain: ${message}`);
    return EXIT_NO_SERVER;
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await res.json() as Record<string, unknown>;
  } catch {
    // non-JSON error page; status code carries the meaning
  }
  if (!res.ok) {
    const message = typeof payload.error === 'string' ? payload.error : `HTTP ${res.status}`;
    if (parsed.json) out.log(JSON.stringify({ ok: false, status: res.status, error: message }));
    else err.error(`kookr chain: ${message}`);
    return EXIT_SERVER_ERROR;
  }

  if (parsed.json) {
    out.log(JSON.stringify({ ok: true, ...payload }));
  } else if (parsed.kind === 'start') {
    const chain = payload.chain as { maxIterations?: number; deadlineAt?: string } | undefined;
    const bounds = [
      chain?.maxIterations !== undefined ? `${chain.maxIterations} iterations` : undefined,
      chain?.deadlineAt ? `until ${chain.deadlineAt}` : undefined,
    ].filter(Boolean).join(', ');
    out.log(`Started chain ${String(payload.id)} (${bounds})${payload.queued ? ' — iteration 1 is queued' : ''}`);
  } else {
    out.log(payload.alreadyRequested
      ? `Stop was already requested; the chain ends after iteration ${String(payload.iteration)}.`
      : `The chain will stop after iteration ${String(payload.iteration)} (task ${String(payload.tipTaskId)}).`);
  }
  return EXIT_OK;
}
