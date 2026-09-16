import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { redactSecrets } from '../core/redact-secrets.js';
import { splitHookRecords } from '../server/hook-record-framing.js';
import { resolveKookrDataDir } from './kookr-maintenance.js';

/**
 * `kookr logs <taskId>` is the operator read-side counterpart to the hook
 * *write* path (`bin/kookr-hook-writer.js`) and the *replay* path
 * (`scripts/replay-hooks.ts`). It answers "what is this task doing?" from the
 * shell by tailing a task's persisted hook-event JSONL under
 * `<dataDir>/hooks/<session>.jsonl` — including any rotated `<session>.jsonl.N`
 * generations the writer's size cap split off (issue #1433), read oldest-first
 * so history is not lost — without booting a server or opening the dashboard.
 * See issue #1180.
 *
 * It operates directly on the on-disk data directory (like `kookr maintenance`),
 * reusing `resolveKookrDataDir`, the production `splitHookRecords` framing
 * parser (so output matches replay semantics), and `redactSecrets` on the read
 * path — output may be pasted into bug reports, so known credential formats are
 * scrubbed before they reach the terminal.
 *
 * Task→session resolution follows the configured task store (#3214). SQLite is
 * the default store (#1755); when a `tasks.sqlite` is present we resolve the
 * task and its sessions from it with a narrow read-only query so a stale
 * `tasks.json` export can't shadow the live mapping. We fall back to `tasks.json`
 * only when SQLite is absent, and honor an explicit `KOOKR_TASK_STORE=json`.
 *
 *   kookr logs <taskId> [-n N | --lines N] [--json] [--dir PATH]
 */

const DEFAULT_LINES = 20;

export const LOGS_HELP_TEXT = `kookr logs — tail a task's recent hook-event activity.

Usage:
  kookr logs <taskId> [OPTIONS]

Reads a task's persisted Claude Code / Codex hook events from the local data
directory (~/.kookr/hooks/<session>.jsonl) and prints the most recent records,
newest last. Known secrets in event payloads are redacted on the read path.

Options:
  -n, --lines <N>   Show the last N records (default ${DEFAULT_LINES}).
  --json            Print one machine-readable JSON envelope.
  --dir <PATH>      Read from an explicit data directory (e.g. ~/.kookr-4801).
  -h, --help        Show this help.

<taskId> is a Kookr task id (from the dashboard, or the \`task_id=\` line printed
by \`kookr spawn\`). A session / hook-log id (e.g. kookr-020f33cb) is also accepted.`;

const USAGE = 'Usage: kookr logs <taskId> [-n N] [--json] [--dir PATH]';

export interface LogsOptions {
  taskId?: string;
  lines: number;
  json: boolean;
  dir?: string;
  help?: boolean;
  error?: string;
}

export function parseLogsArgs(argv: string[]): LogsOptions {
  const opts: LogsOptions = { lines: DEFAULT_LINES, json: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        return { ...opts, help: true };
      case '--json':
        opts.json = true;
        break;
      case '-n':
      case '--lines': {
        const value = argv[++i];
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          return { ...opts, error: `${arg} expects a positive integer (got: ${JSON.stringify(value)}).` };
        }
        opts.lines = n;
        break;
      }
      case '--dir': {
        const value = argv[++i];
        if (value === undefined || value.startsWith('-')) {
          return { ...opts, error: '--dir expects a path value.' };
        }
        opts.dir = value;
        break;
      }
      default:
        if (arg.startsWith('-')) return { ...opts, error: `Unknown option: ${arg}` };
        positionals.push(arg);
    }
  }
  if (positionals.length === 0) {
    return { ...opts, error: 'Expected a <taskId> argument. See `kookr logs --help`.' };
  }
  if (positionals.length > 1) {
    return { ...opts, error: `Expected exactly one <taskId> argument (got ${positionals.length}). See \`kookr logs --help\`.` };
  }
  opts.taskId = positionals[0];
  return opts;
}

interface SessionLike {
  tmuxSession?: unknown;
}

interface TaskLike {
  id?: unknown;
  sessions?: unknown;
}

/**
 * Read and tolerantly parse `tasks.json`. Returns `undefined` when the file is
 * missing/unparseable so the caller can fall back to treating the argument as a
 * direct session/hook-log id instead of guessing. Mirrors the tolerant reader
 * in `maintenance-prune.ts` — we only need `id` and `sessions[].tmuxSession`.
 */
async function readTasks(dataDir: string): Promise<TaskLike[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, 'tasks.json'), 'utf8');
  } catch (err) {
    // No tasks.json is a normal state (fresh instance) — treat as "no tasks"
    // so the caller falls back to the direct session-id path. An actual read
    // error (permissions, I/O) stays `undefined` so the caller can say so.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  // v2 envelope { version, tasks: [...] }; tolerate a bare v1 array too.
  const tasks = Array.isArray(parsed) ? parsed : (parsed as { tasks?: unknown })?.tasks;
  return Array.isArray(tasks) ? (tasks as TaskLike[]) : undefined;
}

/** Extract the ordered hook-log stems from a task's `sessions[]`, dropping
 * entries without a usable `tmuxSession`. Session order is preserved so the
 * CLI's cross-session merge order stays stable regardless of the store. */
function stemsFromSessions(task: TaskLike): string[] {
  const sessions = Array.isArray(task.sessions) ? task.sessions : [];
  const stems: string[] = [];
  for (const session of sessions) {
    const name = (session as SessionLike)?.tmuxSession;
    if (typeof name === 'string' && name.length > 0) stems.push(name);
  }
  return stems;
}

/**
 * Resolve the hook-log stems (session/tmux names) for a task id. Returns
 * `undefined` when no task matches, so the caller can fall back to the direct
 * session-id path.
 */
function hookStemsForTask(tasks: TaskLike[], taskId: string): string[] | undefined {
  const task = tasks.find((t) => typeof t.id === 'string' && t.id === taskId);
  if (!task) return undefined;
  return stemsFromSessions(task);
}

/**
 * How a task→session lookup resolved against the configured store.
 *   - `stems === undefined`  → no matching task; fall back to a direct
 *     session/hook-log id lookup.
 *   - `stems` (possibly empty) → the task's sessions, in order.
 *   - `storeUnreadable`      → the store exists but could not be read/parsed
 *     (corrupt/IO); the caller adds a diagnostic hint if nothing else resolves.
 */
interface StemResolution {
  stems: string[] | undefined;
  storeUnreadable: boolean;
  storeLabel: string;
}

/**
 * Task-store mode, mirroring `resolveTaskStoreMode` in
 * `core/task-sqlite-store.ts` (SQLite is the default; `KOOKR_TASK_STORE=json`
 * opts out). Reimplemented here so the read-only JSON path never eagerly loads
 * the native `better-sqlite3` addon — it's imported lazily only when a
 * `tasks.sqlite` actually needs to be read.
 */
function taskStoreMode(env: NodeJS.ProcessEnv): 'sqlite' | 'json' {
  return env.KOOKR_TASK_STORE?.trim().toLowerCase() === 'json' ? 'json' : 'sqlite';
}

/** Resolve stems from `tasks.json`, preserving the tolerant reader's
 * "unreadable ⇒ diagnostic, missing ⇒ no tasks" semantics. */
async function resolveStemsFromJson(dataDir: string, taskId: string): Promise<StemResolution> {
  const tasks = await readTasks(dataDir);
  return {
    stems: tasks ? hookStemsForTask(tasks, taskId) : undefined,
    storeUnreadable: tasks === undefined,
    storeLabel: 'tasks.json',
  };
}

/**
 * Resolve stems from `tasks.sqlite` with a narrow, read-only diagnostic query.
 *
 * Opens read-only (`fileMustExist`) so the command never creates, migrates,
 * checkpoints, quarantines, or renames the `tasks.sqlite` database itself — it
 * only reads the one requested task's row (`SELECT data ... WHERE id = ?`) and
 * returns its sessions in stored order. (A read-only open of a live WAL
 * database may still touch SQLite's own `-shm` shared-memory sidecar; it never
 * writes the database or its schema.) A corrupt/unreadable DB — or a corrupt
 * row for the requested task — resolves as `storeUnreadable` rather than masking
 * the failure with stale JSON. `better-sqlite3` is imported lazily so the JSON
 * path never pays the native-addon load cost.
 */
async function resolveStemsFromSqlite(dbPath: string, taskId: string): Promise<StemResolution> {
  const label = 'tasks.sqlite';
  let db: import('better-sqlite3').Database | undefined;
  try {
    const { default: Database } = await import('better-sqlite3');
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT data FROM tasks WHERE id = ? LIMIT 1').get(taskId) as
      | { data: string }
      | undefined;
    if (!row) return { stems: undefined, storeUnreadable: false, storeLabel: label };
    const parsed = JSON.parse(row.data) as TaskLike;
    return { stems: stemsFromSessions(parsed), storeUnreadable: false, storeLabel: label };
  } catch {
    // Corrupt/unreadable store, or a corrupt row for the requested task: a
    // defined diagnostic outcome. Do not fall back to (possibly stale) JSON.
    return { stems: undefined, storeUnreadable: true, storeLabel: label };
  } finally {
    db?.close();
  }
}

/**
 * Resolve the requested task's session stems against the configured store.
 * SQLite is authoritative when a `tasks.sqlite` is present (so a stale JSON
 * export can't shadow it); otherwise — or under explicit JSON mode — the
 * legacy `tasks.json` reader is used.
 */
async function resolveStems(
  dataDir: string,
  taskId: string,
  env: NodeJS.ProcessEnv,
): Promise<StemResolution> {
  if (taskStoreMode(env) === 'json') {
    return resolveStemsFromJson(dataDir, taskId);
  }
  // Same filename/location as core `resolveTaskSqlitePath` (sibling of
  // tasks.json). Probe first so an absent DB falls back to JSON without loading
  // the native addon.
  const dbPath = join(dataDir, 'tasks.sqlite');
  if (!existsSync(dbPath)) {
    return resolveStemsFromJson(dataDir, taskId);
  }
  return resolveStemsFromSqlite(dbPath, taskId);
}

interface HookRecord {
  session: string;
  record: string;
}

/**
 * List the hook-log files for a session stem in chronological (oldest-first)
 * order: the writer rotates the active `<stem>.jsonl` into numbered generations
 * `<stem>.jsonl.N` once it exceeds its size cap (issue #1433), where a higher N
 * is older. So chronological order is the highest generation first, descending
 * to `.1`, then the active base file last. Returns just the base file when the
 * hooks directory can't be read (matching the pre-rotation behavior).
 */
async function hookLogFilesForStem(hooksDir: string, stem: string): Promise<string[]> {
  const base = `${stem}.jsonl`;
  const rotatedRe = new RegExp(`^${escapeRegExp(base)}\\.(\\d+)$`);
  let entries: string[];
  try {
    entries = await readdir(hooksDir);
  } catch {
    return [base];
  }
  const rotated = entries
    .map((name) => {
      const match = rotatedRe.exec(name);
      return match ? { name, generation: Number(match[1]) } : undefined;
    })
    .filter((v): v is { name: string; generation: number } => v !== undefined)
    .sort((a, b) => b.generation - a.generation) // oldest (highest N) first
    .map((v) => v.name);
  return [...rotated, base];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Read every hook record for the given session stems, in session order. */
async function collectRecords(dataDir: string, stems: string[]): Promise<HookRecord[]> {
  const out: HookRecord[] = [];
  const hooksDir = join(dataDir, 'hooks');
  for (const stem of stems) {
    // Read the whole rotation set oldest-first so `kookr logs` still shows
    // history that the writer's size cap moved out of the active file.
    for (const fileName of await hookLogFilesForStem(hooksDir, stem)) {
      let content: string;
      try {
        content = await readFile(join(hooksDir, fileName), 'utf8');
      } catch {
        // Hook file may not exist yet (no activity) or was swept — skip it.
        continue;
      }
      const { records } = splitHookRecords(content);
      for (const record of records) {
        if (record.trim()) out.push({ session: stem, record });
      }
    }
  }
  return out;
}

/** Recursively redact known secret formats in every string value of a record. */
function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(val);
    }
    return out;
  }
  return value;
}

/**
 * Parse a hook record and deep-redact its string values. Redacting the parsed
 * object (not the raw JSON text) is deliberate: the key-value credential
 * pattern (`token=<value>`, `[^\s&]+`) would otherwise consume structural
 * characters across a minified record and corrupt an otherwise-valid event.
 * A structurally-broken line is tagged and its raw text still redacted.
 */
function redactRecord(raw: string): unknown {
  try {
    return redactDeep(JSON.parse(raw));
  } catch {
    return { malformed: true, raw: redactSecrets(raw) };
  }
}

/** One-line human summary of a redacted hook event for the default view. */
function summarizeEvent(event: unknown): string {
  if (event === null || typeof event !== 'object' || 'malformed' in (event as object)) {
    return '<unparseable hook record>';
  }
  const obj = event as Record<string, unknown>;
  const name = typeof obj.hook_event_name === 'string' ? obj.hook_event_name : 'unknown';
  const tool = typeof obj.tool_name === 'string' ? obj.tool_name : undefined;
  return tool ? `${name} (${tool})` : name;
}

interface LogsDeps {
  env?: NodeJS.ProcessEnv;
  out?: { log: (msg?: unknown) => void };
  err?: { error: (msg?: unknown) => void };
}

export async function runLogsCli(argv: string[], deps: LogsDeps = {}): Promise<number> {
  const { env = process.env, out = console, err = console } = deps;
  const opts = parseLogsArgs(argv);

  if (opts.help) {
    out.log(LOGS_HELP_TEXT);
    return 0;
  }
  if (opts.error) {
    err.error(opts.error);
    err.error(USAGE);
    return 2;
  }

  const taskId = opts.taskId as string;
  const dataDir = opts.dir ?? resolveKookrDataDir(env);

  const { stems, storeUnreadable, storeLabel } = await resolveStems(dataDir, taskId, env);

  let all: HookRecord[];
  let hookLogs: string[];
  if (stems === undefined) {
    // No matching task (or unreadable store) — accept the argument as a direct
    // session / hook-log id if a matching JSONL file exists. Read once and
    // reuse the result rather than re-framing the file for existence.
    all = await collectRecords(dataDir, [taskId]);
    if (all.length === 0) {
      const hint = storeUnreadable ? ` (could not read ${storeLabel} in ${dataDir})` : '';
      err.error(`No task or hook log found for '${taskId}' in ${dataDir}.${hint}`);
      return 1;
    }
    hookLogs = [taskId];
  } else {
    if (stems.length === 0) {
      out.log(`Task '${taskId}' has no sessions with hook logs yet.`);
      return 0;
    }
    all = await collectRecords(dataDir, stems);
    if (all.length === 0) {
      out.log(`No hook activity recorded for '${taskId}' yet.`);
      return 0;
    }
    hookLogs = stems;
  }

  const shown = all.slice(-opts.lines).map(({ session, record }) => ({
    session,
    event: redactRecord(record),
  }));

  if (opts.json) {
    out.log(
      JSON.stringify({ taskId, dataDir, hookLogs, totalRecords: all.length, records: shown }),
    );
    return 0;
  }

  const multiSession = hookLogs.length > 1;
  out.log(
    `Task ${taskId} — ${all.length} hook record(s) across ${hookLogs.length} session(s); showing last ${shown.length}:`,
  );
  for (const { session, event } of shown) {
    const prefix = multiSession ? `[${session}] ` : '';
    out.log(`  ${prefix}${summarizeEvent(event)}`);
  }
  return 0;
}
