/**
 * `kookr reflect` — Phase-1 instrumentation for the daily workflow-reflection
 * loop (#1751).
 *
 *   kookr reflect outcomes [--json] [--window 24h|7d|30d|all]
 *   kookr reflect ideas    [--json] [--log PATH] [--runs N]
 *
 * `outcomes` returns a compact 24h task-outcome tally in a single call by
 * projecting the running server's `/api/outcome-ledger` scoreboard — so the
 * reflection no longer falls back to the ~18h-stale daily-report markdown.
 *
 * `ideas` reads the reflection `log.jsonl`, resolves each prior `ideasFiled`
 * URL to its current GitHub state (open / closed / shipped-by-PR#) via
 * `gh api graphql`, and prints a compact filed→shipped table — replacing the
 * per-run manual `gh` queries.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  collectIdeasFiled,
  formatIdeasTable,
  parseGhIssueResponse,
  parseReflectionLog,
  resolveIdeas,
  summarizeIdeas,
  type IssueProbe,
  type IssueRef,
  type RawIssueState,
} from '../core/reflection-ideas.js';

const execFileAsync = promisify(execFile);

const USAGE = `kookr reflect — Phase-1 instrumentation for the workflow-reflection loop (#1751).

Usage:
  kookr reflect outcomes [--json] [--window 24h|7d|30d|all]
  kookr reflect ideas    [--json] [--log PATH] [--runs N]

outcomes  24h task-outcome tally (ran/completed/terminated/cancelled/active +
          PR count) from the running server's /api/outcome-ledger scoreboard —
          one call, no daily-report markdown.
ideas     Resolve prior \`ideasFiled\` URLs from the reflection log to their
          current state and print a filed→shipped table.

Options:
  --window W   outcomes window: 24h (default) | 7d | 30d | all.
  --log PATH   ideas log.jsonl (default:
               ~/.kookr/playbook-state/lucy/workflow-reflection/log.jsonl).
  --runs N     ideas: resolve URLs from the last N reflection runs (default: 1).
  --json       Machine-readable output.
  -h, --help   Show this help.
`;

const WINDOWS = new Set(['24h', '7d', '30d', 'all']);
const PORTS_TO_TRY = [4800, 4801];

export interface ReflectCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  /** Override the GitHub probe (tests). Defaults to a `gh api graphql` probe. */
  probe?: IssueProbe;
  /** Override HTTP fetch (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface ResolvedIo {
  env: NodeJS.ProcessEnv;
  out: { log: (...args: unknown[]) => void };
  err: { error: (...args: unknown[]) => void };
  probe: IssueProbe;
  fetchImpl: typeof fetch;
  now: () => Date;
}

export async function runReflectCli(argv: string[], io: ReflectCliIo = {}): Promise<number> {
  const resolved: ResolvedIo = {
    env: io.env ?? process.env,
    out: io.out ?? console,
    err: io.err ?? console,
    probe: io.probe ?? defaultGhProbe,
    fetchImpl: io.fetchImpl ?? fetch,
    now: io.now ?? (() => new Date()),
  };

  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    resolved.out.log(USAGE);
    return 0;
  }

  const verb = argv[0];
  const rest = argv.slice(1);

  if (verb === 'outcomes') return runOutcomes(rest, resolved);
  if (verb === 'ideas') return runIdeas(rest, resolved);

  resolved.err.error(`[kookr reflect] Unknown verb: ${verb}`);
  resolved.err.error(USAGE);
  return 2;
}

// ---------------------------------------------------------------------------
// outcomes
// ---------------------------------------------------------------------------

async function runOutcomes(argv: string[], io: ResolvedIo): Promise<number> {
  let window = '24h';
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      io.out.log(USAGE);
      return 0;
    } else if (arg === '--window') {
      const raw = argv[++i];
      if (!raw || !WINDOWS.has(raw)) {
        io.err.error('[kookr reflect] --window must be one of 24h, 7d, 30d, all');
        return 2;
      }
      window = raw;
    } else if (arg.startsWith('--window=')) {
      const raw = arg.slice('--window='.length);
      if (!WINDOWS.has(raw)) {
        io.err.error('[kookr reflect] --window must be one of 24h, 7d, 30d, all');
        return 2;
      }
      window = raw;
    } else {
      io.err.error(`[kookr reflect] Unknown arg: ${arg}`);
      return 2;
    }
  }

  const base = await resolveBaseUrl(io);
  if (!base) {
    const msg = `Kookr is not running (checked ${describeTarget(io.env)}).`;
    if (json) {
      io.out.log(JSON.stringify({ ok: false, code: 'no-server', message: msg }));
    } else {
      io.err.error(`[kookr reflect] ${msg}`);
    }
    return 1;
  }

  let ledger: OutcomeLedgerLike;
  try {
    ledger = await fetchLedger(io, base, window);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (json) {
      io.out.log(JSON.stringify({ ok: false, code: 'fetch-error', message: msg }));
    } else {
      io.err.error(`[kookr reflect] Failed to read /api/outcome-ledger: ${msg}`);
    }
    return 1;
  }

  const tally = projectTally(ledger);
  if (json) {
    io.out.log(
      JSON.stringify({
        ok: true,
        source: ledger.schemaVersion ?? 'outcome-ledger',
        generatedAt: io.now().toISOString(),
        window: ledger.window?.value ?? window,
        readiness: ledger.readiness ?? null,
        tally,
      }),
    );
  } else {
    io.out.log(formatTally(window, ledger.readiness ?? null, tally));
  }
  return 0;
}

interface OutcomeTally {
  ran: number;
  terminal: number;
  completed: number;
  terminated: number;
  cancelled: number;
  active: number;
  completionRate: number | null;
  tasksWithPr: number;
  verified: number;
  thumbsUp: number;
  thumbsDown: number;
  totalKnownCostUsd: number;
}

interface OutcomeLedgerLike {
  schemaVersion?: string;
  readiness?: string | null;
  window?: { value?: string };
  summary?: Record<string, unknown>;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function projectTally(ledger: OutcomeLedgerLike): OutcomeTally {
  const s = ledger.summary ?? {};
  const completionRate = s.completionRate;
  return {
    ran: num(s.taskCount),
    terminal: num(s.terminalTaskCount),
    completed: num(s.completedTaskCount),
    terminated: num(s.terminatedTaskCount),
    cancelled: num(s.cancelledTaskCount),
    active: num(s.activeTaskCount),
    completionRate: typeof completionRate === 'number' ? completionRate : null,
    tasksWithPr: num(s.prTaskCount),
    verified: num(s.verifiedTaskCount),
    thumbsUp: num(s.thumbsUp),
    thumbsDown: num(s.thumbsDown),
    totalKnownCostUsd: num(s.totalKnownCostUsd),
  };
}

function formatTally(window: string, readiness: string | null, t: OutcomeTally): string {
  const pct = t.completionRate == null ? 'n/a' : `${Math.round(t.completionRate * 100)}%`;
  const cost = `$${t.totalKnownCostUsd.toFixed(2)}`;
  const head = `Outcomes — window ${window}${readiness ? ` · readiness ${readiness}` : ''}`;
  const lines = [
    head,
    '',
    `  ran         ${t.ran}`,
    `  completed   ${t.completed}`,
    `  terminated  ${t.terminated}   (failed)`,
    `  cancelled   ${t.cancelled}`,
    `  active      ${t.active}`,
    `  completion  ${pct}`,
    `  tasks w/PR  ${t.tasksWithPr}`,
    `  verified    ${t.verified}`,
    `  feedback    +${t.thumbsUp}/-${t.thumbsDown}`,
    `  cost        ${cost}`,
  ];
  return lines.join('\n');
}

async function resolveBaseUrl(io: ResolvedIo): Promise<string | null> {
  const explicit = io.env.KOOKR_API_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }
  const portRaw = io.env.KOOKR_PORT?.trim();
  if (portRaw) {
    const port = Number(portRaw);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return `http://127.0.0.1:${port}`;
    }
  }
  for (const port of PORTS_TO_TRY) {
    const base = `http://127.0.0.1:${port}`;
    try {
      const res = await io.fetchImpl(`${base}/api/health`, {
        headers: authHeaders(io.env),
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return base;
    } catch {
      // try next port
    }
  }
  return null;
}

function describeTarget(env: NodeJS.ProcessEnv): string {
  if (env.KOOKR_API_BASE_URL?.trim()) return env.KOOKR_API_BASE_URL.trim();
  if (env.KOOKR_PORT?.trim()) return `port ${env.KOOKR_PORT.trim()}`;
  return `ports ${PORTS_TO_TRY.join(', ')}`;
}

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.KOOKR_API_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchLedger(
  io: ResolvedIo,
  base: string,
  window: string,
): Promise<OutcomeLedgerLike> {
  const url = `${base}/api/outcome-ledger?window=${encodeURIComponent(window)}`;
  const res = await io.fetchImpl(url, {
    headers: authHeaders(io.env),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return (await res.json()) as OutcomeLedgerLike;
}

// ---------------------------------------------------------------------------
// ideas
// ---------------------------------------------------------------------------

function defaultLogPath(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || homedir();
  return join(home, '.kookr', 'playbook-state', 'lucy', 'workflow-reflection', 'log.jsonl');
}

async function runIdeas(argv: string[], io: ResolvedIo): Promise<number> {
  let json = false;
  let logPath: string | undefined;
  let runs = 1;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      io.out.log(USAGE);
      return 0;
    } else if (arg === '--log') {
      logPath = argv[++i];
      if (!logPath) {
        io.err.error('[kookr reflect] --log requires a path');
        return 2;
      }
    } else if (arg.startsWith('--log=')) {
      logPath = arg.slice('--log='.length);
      if (!logPath) {
        io.err.error('[kookr reflect] --log requires a path');
        return 2;
      }
    } else if (arg === '--runs') {
      const parsed = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        io.err.error('[kookr reflect] --runs must be a positive integer');
        return 2;
      }
      runs = parsed;
    } else if (arg.startsWith('--runs=')) {
      const parsed = Number.parseInt(arg.slice('--runs='.length), 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        io.err.error('[kookr reflect] --runs must be a positive integer');
        return 2;
      }
      runs = parsed;
    } else {
      io.err.error(`[kookr reflect] Unknown arg: ${arg}`);
      return 2;
    }
  }

  const path = logPath ?? defaultLogPath(io.env);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // First-ever reflection run: no prior ideas to resolve. Not an error.
      if (json) {
        io.out.log(
          JSON.stringify({
            ok: true,
            log: path,
            runs,
            generatedAt: io.now().toISOString(),
            summary: summarizeIdeas([]),
            ideas: [],
          }),
        );
      } else {
        io.out.log(`Reflection ideas — no log yet at ${path}`);
      }
      return 0;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (json) {
      io.out.log(JSON.stringify({ ok: false, code: 'read-error', message: msg }));
    } else {
      io.err.error(`[kookr reflect] Failed to read ${path}: ${msg}`);
    }
    return 1;
  }

  const entries = parseReflectionLog(text);
  const filed = collectIdeasFiled(entries, { runs });
  const resolvedIdeas = await resolveIdeas(filed, io.probe);
  const summary = summarizeIdeas(resolvedIdeas);

  if (json) {
    io.out.log(
      JSON.stringify({
        ok: true,
        log: path,
        runs,
        generatedAt: io.now().toISOString(),
        summary,
        ideas: resolvedIdeas,
      }),
    );
  } else {
    io.out.log(`Reflection ideas — filed→shipped (log: ${path}, runs: ${runs})\n`);
    io.out.log(formatIdeasTable(resolvedIdeas));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// default GitHub probe (gh api graphql)
// ---------------------------------------------------------------------------

const GRAPHQL_QUERY =
  'query($owner:String!,$repo:String!,$num:Int!){' +
  'repository(owner:$owner,name:$repo){' +
  'issue(number:$num){state stateReason ' +
  'closedByPullRequestsReferences(first:5,includeClosedPrs:true){nodes{number url merged}}}}}';

/** Resolve an issue's state via `gh api graphql`. */
export const defaultGhProbe: IssueProbe = async (ref: IssueRef): Promise<RawIssueState> => {
  let stdout: string;
  try {
    // owner/repo are passed with -f (raw string): -F would coerce an all-numeric
    // org/user name to an Int and fail against the String! variables.
    ({ stdout } = await execFileAsync(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        `query=${GRAPHQL_QUERY}`,
        '-f',
        `owner=${ref.owner}`,
        '-f',
        `repo=${ref.repo}`,
        '-F',
        `num=${ref.number}`,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch (err) {
    // gh exits non-zero on GraphQL errors but still prints the body to stdout.
    const withStdout = err as { stdout?: string };
    if (typeof withStdout.stdout === 'string' && withStdout.stdout.trim() !== '') {
      stdout = withStdout.stdout;
    } else {
      throw new Error(ghErrorMessage(err));
    }
  }

  return parseGhIssueResponse(stdout);
};

function ghErrorMessage(err: unknown): string {
  const e = err as { code?: string; stderr?: string; message?: string };
  if (e.code === 'ENOENT') return 'gh CLI not found on PATH';
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  if (stderr) return stderr.split('\n')[0]!;
  return e.message ?? 'gh invocation failed';
}
