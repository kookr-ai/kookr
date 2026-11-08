/**
 * `kookr supervise <taskRef...> [--goal <text>]... [--until <+Nh|HH:MM>]
 * [--print-brief] [--json]` — attach a supervisor task to running tasks
 * (RFC: attachable task supervisor, phase P1).
 *
 * Each ref resolves to exactly one live task (exact taskId, unique id prefix of
 * at least 8 characters, or exact task name) through the running server's API.
 * A brief is rendered from the resolved targets. `--print-brief` prints it and
 * stops. Otherwise the brief and a `state.json` are written under
 * `<dataDir>/supervisions/<id>/`, a supervisor task is launched with the
 * `task-supervisor` plugin playbook (same POST /api/tasks contract as
 * `kookr spawn`), and one `supervises` relation per target is recorded.
 */

import { randomBytes } from 'node:crypto';

import { isTerminalStatus } from '../shared/contracts/task-status.js';
import {
  resolveDataDir,
  writeSupervisionFiles,
  type SupervisionFs,
  type SupervisionState,
} from '../core/supervision/supervision-files.js';
import {
  EXIT_AMBIGUOUS,
  EXIT_NO_SERVER,
  EXIT_OK,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  resolveStopBaseUrl,
} from './kookr-stop.js';

const PORTS_TO_TRY = [4800, 4801] as const;
const REQUEST_TIMEOUT_MS = 15_000;
const MIN_PREFIX_LENGTH = 8;
const DEFAULT_UNTIL = '+4h';
const MAX_UNTIL_HOURS = 168;
const LAUNCH_ATTEMPTS = 3;
const LAUNCH_BASE_DELAY_MS = 500;
export const SUPERVISOR_PLAYBOOK_PATH = 'task-supervisor.md';

export const HELP_TEXT = `kookr supervise — attach a supervisor to running tasks.

Usage:
  kookr supervise <taskRef...> [--goal <text>]... [--until <+Nh|HH:MM>] [--print-brief] [--json]

Resolves each <taskRef> to exactly one live task (exact taskId, unique id prefix
of at least ${MIN_PREFIX_LENGTH} characters, or exact task name), renders a supervision brief,
launches a supervisor task with the task-supervisor playbook, and records a
"supervises" relation from the supervisor to each target.

Options:
  --goal <text>     What you want achieved. Repeatable. Default: drive each target to completion.
  --until <when>    Mandate end: +Nh (hours from now, 1..${MAX_UNTIL_HOURS}) or HH:MM (local time,
                    next occurrence). Default ${DEFAULT_UNTIL}.
  --print-brief     Print the brief and exit 0 without launching anything (paste it into a
                    plain Claude session). No files are written.
  --json            Print one machine-readable JSON envelope instead of human text.
  -h, --help        Show this help.

Files: ~/.kookr/supervisions/<supervisionId>/brief.md and state.json
(~/.kookr for the default port 4800, ~/.kookr-<port> for another instance;
derived from the server the command talked to).

Environment:
  KOOKR_API_BASE_URL      Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT              Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_SUPERVISOR_TOKEN  Bearer token for a supervisor-gated instance.
  KOOKR_API_TOKEN         Bearer token for a non-loopback server (fallback).

Exit codes:
  0  Success (supervisor launched, or brief printed). A failed relation write is a warning.
  2  User error (bad flags, unknown/terminal ref, target already supervised).
  3  No server reachable.                  4  Server/HTTP error.
  5  Ambiguous port, or a ref matching more than one task.
`;

export interface ParsedSuperviseArgs {
  refs: string[];
  goals: string[];
  until?: string;
  printBrief: boolean;
  json: boolean;
  help: boolean;
  error?: string;
}

export function parseSuperviseArgs(argv: string[]): ParsedSuperviseArgs {
  const out: ParsedSuperviseArgs = { refs: [], goals: [], printBrief: false, json: false, help: false };
  const fail = (message: string): void => {
    if (out.error === undefined) out.error = message;
  };
  for (let i = 0; i < argv.length; i += 1) {
    let tok = argv[i];
    let inline: string | undefined;
    const eq = tok.startsWith('--') ? tok.indexOf('=') : -1;
    if (eq !== -1) {
      inline = tok.slice(eq + 1);
      tok = tok.slice(0, eq);
    }
    const value = (): string | undefined => (inline !== undefined ? inline : argv[++i]);
    if (tok === '-h' || tok === '--help') out.help = true;
    else if (tok === '--json') out.json = true;
    else if (tok === '--print-brief') out.printBrief = true;
    else if (tok === '--goal') {
      const v = value();
      if (v === undefined || v.trim() === '') fail('--goal requires non-empty text.');
      else out.goals.push(v.trim());
    } else if (tok === '--until') {
      const v = value();
      if (v === undefined || v.trim() === '') fail('--until requires a value (+Nh or HH:MM).');
      else out.until = v.trim();
    } else if (tok.startsWith('-') && tok !== '-') fail(`unknown option: ${argv[i]}`);
    else out.refs.push(tok);
  }
  return out;
}

/**
 * Parse `--until`: `+Nh` (whole hours from `now`) or `HH:MM` (local time, rolling
 * to tomorrow when that time has already passed today). Returns an Error on bad input.
 */
export function parseUntil(raw: string, now: Date): Date | Error {
  const rel = /^\+(\d+)h$/.exec(raw);
  if (rel) {
    const hours = Number(rel[1]);
    if (hours < 1 || hours > MAX_UNTIL_HOURS) {
      return new Error(`--until +Nh needs N between 1 and ${MAX_UNTIL_HOURS} (got: ${raw}).`);
    }
    return new Date(now.getTime() + hours * 3_600_000);
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    if (h > 23 || m > 59) return new Error(`--until HH:MM is not a valid time (got: ${raw}).`);
    const at = new Date(now);
    at.setHours(h, m, 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at;
  }
  return new Error(`--until must be +Nh or HH:MM (got: ${raw}).`);
}

export interface CompactTask {
  taskId: string;
  name: string;
  status: string;
}

export type ResolveResult =
  | { ok: true; task: CompactTask }
  | { ok: false; code: 'UNKNOWN_TASK' | 'AMBIGUOUS_TASK' | 'TERMINAL_TASK'; message: string; candidates: CompactTask[] };

function isTerminal(task: CompactTask): boolean {
  return isTerminalStatus(task.status as Parameters<typeof isTerminalStatus>[0]);
}

function describe(task: CompactTask): string {
  return `${task.taskId} (${task.name || 'unnamed'}, ${task.status})`;
}

/** Resolve one ref: exact id, else exact name (preferring live), else unique id prefix (>= 8 chars). */
export function resolveTaskRef(ref: string, tasks: CompactTask[]): ResolveResult {
  let matches = tasks.filter((t) => t.taskId === ref);
  if (matches.length === 0) {
    const byName = tasks.filter((t) => t.name === ref);
    const live = byName.filter((t) => !isTerminal(t));
    matches = live.length > 0 ? live : byName;
  }
  if (matches.length === 0 && ref.length >= MIN_PREFIX_LENGTH) {
    matches = tasks.filter((t) => t.taskId.startsWith(ref));
  }
  if (matches.length === 0) {
    const hint = ref.length < MIN_PREFIX_LENGTH
      ? ` (id prefixes need at least ${MIN_PREFIX_LENGTH} characters)`
      : '';
    return { ok: false, code: 'UNKNOWN_TASK', message: `no task matches '${ref}'${hint}.`, candidates: [] };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: 'AMBIGUOUS_TASK',
      message: `'${ref}' matches ${matches.length} tasks: ${matches.map(describe).join('; ')}. Use a longer id.`,
      candidates: matches,
    };
  }
  const task = matches[0];
  if (isTerminal(task)) {
    return {
      ok: false,
      code: 'TERMINAL_TASK',
      message: `task ${describe(task)} is already finished; only live tasks can be supervised.`,
      candidates: [task],
    };
  }
  return { ok: true, task };
}

export interface BriefTarget extends CompactTask {
  runState: string;
}

/** Local wall-clock time with offset, e.g. `2026-11-08 18:30 (UTC+01:00)`. */
export function formatLocalTime(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`;
}

export function renderBrief(input: {
  supervisionId?: string;
  targets: BriefTarget[];
  goals: string[];
  deadline: Date;
  now: Date;
}): string {
  const goals = input.goals.length > 0
    ? input.goals.map((g) => `- ${g}`)
    : ['- Drive each target to its own stated completion, verified by the worker.'];
  return [
    '# Supervision brief',
    '',
    ...(input.supervisionId ? [`Supervision id: \`${input.supervisionId}\``, ''] : []),
    '## Targets',
    '',
    'Supervise exactly these tasks (use these ids with `kookr peek` and `kookr reply`):',
    '',
    ...input.targets.map((t) => `- \`${t.taskId}\` — ${t.name || 'unnamed'} — status ${t.status}; ${t.runState}`),
    '',
    '## Goals',
    '',
    ...goals,
    '',
    '## Deadline',
    '',
    `Mandate ends at **${formatLocalTime(input.deadline)}** (${input.deadline.toISOString()}). Brief created ${formatLocalTime(input.now)}.`,
    'At the deadline write a short recap and run `kookr signal completion-ready`.',
    '',
    '## Operator rules',
    '',
    '- Read each worker with `kookr peek <taskId>`; read its FULL last message before concluding anything.',
    '- Heartbeat and stall flags are hints: cross-check before nudging, and never restart a working agent.',
    '- Workers verify their own work. Reject "should work"; demand measured results.',
    '- Send `/compact` (via `kookr reply <taskId> "/compact"`) only when the worker is idle at a turn boundary.',
    '- Decide technical questions yourself.',
    '- Escalate to the operator only for: a dead end, a destructive or irreversible action, spending money, or a credential wall.',
    '- NEVER buy, subscribe, top up or refill anything.',
    '- If `kookr reply` refuses with INPUT_REFUSED the worker is on a menu: `kookr peek` it and escalate; do not retry.',
    '',
  ].join('\n');
}

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const supervisor = env.KOOKR_SUPERVISOR_TOKEN?.trim();
  if (supervisor) return { Authorization: `Bearer ${supervisor}` };
  const apiToken = env.KOOKR_API_TOKEN?.trim();
  if (apiToken) return { Authorization: `Bearer ${apiToken}` };
  return {};
}

export interface SuperviseCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  fetchImpl?: typeof fetch;
  fs?: SupervisionFs;
  now?: () => Date;
  cwd?: () => string;
  newId?: () => string;
  /** Data-dir override for tests; defaults to the dir of the resolved server. */
  dataDir?: string;
  /** Test seam for the launch retry backoff. */
  sleep?: (ms: number) => Promise<void>;
}

interface SnapshotAgent {
  taskId?: string;
  taskStatus?: string;
  turnState?: string;
  anomaly?: { type?: string } | null;
  sessionHealth?: { classification?: string } | null;
}

function summarizeRunState(agent: SnapshotAgent | undefined): string {
  if (!agent) return 'run-state: no live agent reported';
  const parts = [
    agent.turnState ? `turnState ${agent.turnState}` : undefined,
    agent.anomaly?.type ? `anomaly ${agent.anomaly.type}` : undefined,
    agent.sessionHealth?.classification ? `health ${agent.sessionHealth.classification}` : undefined,
  ].filter((p): p is string => p !== undefined);
  return `run-state: ${parts.length > 0 ? parts.join(', ') : 'no signals'}`;
}

function toCompactTask(raw: unknown): CompactTask | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const taskId = typeof o.taskId === 'string' ? o.taskId : typeof o.id === 'string' ? o.id : undefined;
  if (!taskId || typeof o.status !== 'string') return undefined;
  return { taskId, name: typeof o.name === 'string' ? o.name : '', status: o.status };
}

export async function runSuperviseCli(argv: string[], io: SuperviseCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const fetchImpl = io.fetchImpl ?? fetch;
  const now = (io.now ?? (() => new Date()))();
  const cwd = (io.cwd ?? (() => process.cwd()))();

  const args = parseSuperviseArgs(argv);
  if (args.help) {
    out.log(HELP_TEXT);
    return EXIT_OK;
  }

  const emit = (payload: { ok: boolean; code: string; message: string; details?: unknown }): void => {
    out.log(JSON.stringify(payload));
  };
  const failWith = (code: string, message: string, exitCode: number, details?: Record<string, unknown>): number => {
    if (args.json) emit({ ok: false, code, message, details: { subcommand: 'supervise', ...details } });
    else err.error(`kookr supervise: ${message}`);
    return exitCode;
  };
  const userError = (
    message: string,
    details?: Record<string, unknown>,
    code = 'USER_ERROR',
    exitCode = EXIT_USER_ERROR,
  ): number => {
    const rc = failWith(code, message, exitCode, details);
    if (!args.json && code === 'USER_ERROR') err.error('Run `kookr supervise --help` for usage.');
    return rc;
  };

  if (args.error) return userError(args.error);
  if (args.refs.length === 0) return userError('at least one <taskRef> is required.');
  const deadline = parseUntil(args.until ?? DEFAULT_UNTIL, now);
  if (deadline instanceof Error) return userError(deadline.message);

  const base = await resolveStopBaseUrl({ env, fetchImpl });
  if (base.kind === 'invalid_port') return userError(`KOOKR_PORT must be an integer in 1..65535 (got: ${base.raw})`);
  if (base.kind === 'ambiguous') {
    return failWith(
      'AMBIGUOUS_PORT',
      `two Kookr instances are reachable on :${base.ports[0]} and :${base.ports[1]}. Set KOOKR_PORT to choose one.`,
      EXIT_AMBIGUOUS,
      { ports: base.ports },
    );
  }
  if (base.kind === 'none') {
    return failWith(
      'NO_SERVER',
      `no Kookr server reachable (checked ports ${PORTS_TO_TRY.join(', ')}). Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.`,
      EXIT_NO_SERVER,
    );
  }
  const baseUrl = base.baseUrl;

  const getJson = async (path: string): Promise<{ kind: 'ok'; body: unknown } | { kind: 'fail'; rc: number }> => {
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        headers: authHeaders(env),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        return { kind: 'fail', rc: failWith('SERVER_ERROR', `GET ${path} returned HTTP ${res.status}.`, EXIT_SERVER_ERROR, { status: res.status }) };
      }
      return { kind: 'ok', body: await res.json() };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return { kind: 'fail', rc: failWith('NO_SERVER', `no Kookr server reachable at ${baseUrl}: ${detail}`, EXIT_NO_SERVER, { baseUrl }) };
    }
  };

  const tasksRes = await getJson('/api/tasks?view=compact');
  if (tasksRes.kind === 'fail') return tasksRes.rc;
  if (!Array.isArray(tasksRes.body)) {
    return failWith('SERVER_ERROR', 'unexpected /api/tasks response (expected an array).', EXIT_SERVER_ERROR);
  }
  const tasks = tasksRes.body.map(toCompactTask).filter((t): t is CompactTask => t !== undefined);

  const targets: CompactTask[] = [];
  for (const ref of args.refs) {
    const r = resolveTaskRef(ref, tasks);
    if (!r.ok) {
      return userError(r.message, { ref, candidates: r.candidates }, r.code, r.code === 'AMBIGUOUS_TASK' ? EXIT_AMBIGUOUS : EXIT_USER_ERROR);
    }
    if (!targets.some((t) => t.taskId === r.task.taskId)) targets.push(r.task);
  }

  // One live supervisor per target (RFC R1): refuse when an active `supervises`
  // edge already points at a target from a supervisor that is still live.
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  for (const t of targets) {
    const rels = await getJson(`/api/task-relations?targetTaskId=${encodeURIComponent(t.taskId)}&type=supervises`);
    if (rels.kind === 'fail') return rels.rc;
    const list = (rels.body && typeof rels.body === 'object' ? (rels.body as { relations?: unknown }).relations : undefined);
    if (!Array.isArray(list)) {
      return failWith('SERVER_ERROR', 'unexpected /api/task-relations response (expected { relations: [] }).', EXIT_SERVER_ERROR);
    }
    for (const rel of list as Array<Record<string, unknown>>) {
      if (rel.type !== 'supervises' || rel.targetTaskId !== t.taskId) continue;
      if (rel.lifecycle !== undefined && rel.lifecycle !== 'active') continue;
      const sup = typeof rel.sourceTaskId === 'string' ? byId.get(rel.sourceTaskId) : undefined;
      if (sup && !isTerminal(sup)) {
        return userError(
          `task ${describe(t)} is already supervised by live task ${describe(sup)}. Stop that supervisor first.`,
          { targetTaskId: t.taskId, supervisorTaskId: sup.taskId },
          'ALREADY_SUPERVISED',
        );
      }
    }
  }

  // Run-state is best effort: the brief is still useful without it.
  let agents: SnapshotAgent[] = [];
  const snap = await (async () => {
    try {
      const res = await fetchImpl(`${baseUrl}/api/snapshot`, {
        headers: authHeaders(env),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return res.ok ? await res.json() : undefined;
    } catch {
      return undefined;
    }
  })();
  if (Array.isArray(snap)) agents = snap as SnapshotAgent[];
  const briefTargets: BriefTarget[] = targets.map((t) => ({
    ...t,
    runState: summarizeRunState(agents.find((a) => a.taskId === t.taskId)),
  }));

  if (args.printBrief) {
    const brief = renderBrief({ targets: briefTargets, goals: args.goals, deadline, now });
    if (args.json) {
      emit({ ok: true, code: 'OK', message: 'Brief rendered; nothing launched.', details: { printBrief: true, brief, deadlineAt: deadline.toISOString(), targets: briefTargets } });
    } else {
      out.log(brief);
    }
    return EXIT_OK;
  }

  const supervisionId = (io.newId ?? (() => `sup-${randomBytes(6).toString('hex')}`))();
  const brief = renderBrief({ supervisionId, targets: briefTargets, goals: args.goals, deadline, now });
  const state: SupervisionState = {
    supervisionId,
    targets: targets.map((t) => ({ taskId: t.taskId, name: t.name })),
    goals: args.goals,
    deadlineAt: deadline.toISOString(),
    createdAt: now.toISOString(),
    supervisorTaskId: null,
  };
  const dataDir = io.dataDir ?? resolveDataDir(baseUrl, env);
  let dir: string;
  try {
    dir = writeSupervisionFiles(dataDir, state, brief, io.fs);
  } catch (e) {
    return failWith('FILE_ERROR', `could not write supervision files under ${dataDir}: ${e instanceof Error ? e.message : String(e)}`, EXIT_SERVER_ERROR);
  }

  const post = async (path: string, body: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: unknown }> => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `kookr-supervise/node-${process.versions.node}`,
        ...extra,
        ...authHeaders(env),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  };

  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const idempotencyKey = `supervise-${supervisionId}`;
  const launchBody = {
    prompt: brief,
    cwd,
    playbook: { path: SUPERVISOR_PLAYBOOK_PATH, scope: 'plugin' },
    idempotencyKey,
  };
  const idFrom = (o: Record<string, unknown>): string | undefined =>
    typeof o.id === 'string' ? o.id : typeof o.taskId === 'string' ? o.taskId : undefined;

  // Mirror kookr-spawn's reconciliation (#1591): a timeout, network error or 5xx
  // leaves the outcome unknown, and re-POSTing the identical body with the same
  // idempotency key is replay-or-create, so it can never start a second supervisor.
  let supervisorTaskId: string | undefined;
  let lastFailure = '';
  for (let attempt = 0; attempt < LAUNCH_ATTEMPTS && supervisorTaskId === undefined; attempt += 1) {
    if (attempt > 0) await sleep(LAUNCH_BASE_DELAY_MS * 2 ** (attempt - 1));
    try {
      const launch = await post('/api/tasks', launchBody, { 'X-Kookr-Launch-Source': 'cli' });
      const lb = (launch.body && typeof launch.body === 'object' ? launch.body : {}) as Record<string, unknown>;
      const id = idFrom(lb) ?? (lb.task && typeof lb.task === 'object' ? idFrom(lb.task as Record<string, unknown>) : undefined);
      if (launch.status >= 200 && launch.status < 300 && id) {
        supervisorTaskId = id;
      } else if (launch.status >= 500) {
        lastFailure = `HTTP ${launch.status}`;
      } else {
        // Definitive rejection (4xx, 429 backpressure): nothing was created.
        const message = typeof lb.error === 'string' ? lb.error : `launching the supervisor failed (HTTP ${launch.status}).`;
        return failWith('SERVER_ERROR', message, EXIT_SERVER_ERROR, { status: launch.status, supervisionId });
      }
    } catch (e) {
      lastFailure = e instanceof Error ? e.message : String(e);
    }
  }
  if (supervisorTaskId === undefined) {
    return failWith(
      'LAUNCH_UNCERTAIN',
      `the supervisor launch outcome is unknown after ${LAUNCH_ATTEMPTS} attempts (${lastFailure}). A supervisor may or may not exist: check the dashboard for it. supervisionId=${supervisionId} idempotencyKey=${idempotencyKey}`,
      EXIT_SERVER_ERROR,
      { supervisionId, idempotencyKey },
    );
  }

  const warnings: string[] = [];
  try {
    writeSupervisionFiles(dataDir, { ...state, supervisorTaskId }, undefined, io.fs);
  } catch (e) {
    warnings.push(`supervisor launched but state.json could not record its task id: ${e instanceof Error ? e.message : String(e)}`);
  }

  const relationsCreated: string[] = [];
  for (const t of targets) {
    try {
      const res = await post('/api/task-relations', {
        sourceTaskId: supervisorTaskId,
        targetTaskId: t.taskId,
        type: 'supervises',
        confidence: 1,
        source: 'api',
        evidence: [{ snippet: `supervision:${supervisionId}`, observedAt: now.toISOString() }],
      });
      if (res.status >= 200 && res.status < 300) relationsCreated.push(t.taskId);
      else warnings.push(`supervises relation to ${t.taskId} was rejected (HTTP ${res.status}).`);
    } catch (e) {
      warnings.push(`supervises relation to ${t.taskId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const message = `Supervisor task ${supervisorTaskId} launched for ${targets.length} target(s) until ${formatLocalTime(deadline)}.`;
  if (args.json) {
    emit({
      ok: true,
      code: 'OK',
      message,
      details: {
        supervisionId,
        supervisorTaskId,
        targets: state.targets,
        deadlineAt: state.deadlineAt,
        dir,
        relationsCreated,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    });
  } else {
    out.log(message);
    out.log(`Supervision ${supervisionId}: ${dir}`);
    for (const w of warnings) err.error(`kookr supervise: warning: ${w}`);
  }
  return EXIT_OK;
}
