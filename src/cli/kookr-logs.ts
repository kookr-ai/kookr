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

/**
 * Resolve the hook-log stems (session/tmux names) for a task id. Returns
 * `undefined` when no task matches, so the caller can fall back to the direct
 * session-id path.
 */
function hookStemsForTask(tasks: TaskLike[], taskId: string): string[] | undefined {
  const task = tasks.find((t) => typeof t.id === 'string' && t.id === taskId);
  if (!task) return undefined;
  const sessions = Array.isArray(task.sessions) ? task.sessions : [];
  const stems: string[] = [];
  for (const session of sessions) {
    const name = (session as SessionLike)?.tmuxSession;
    if (typeof name === 'string' && name.length > 0) stems.push(name);
  }
  return stems;
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

  const tasks = await readTasks(dataDir);
  const stems = tasks ? hookStemsForTask(tasks, taskId) : undefined;

  let all: HookRecord[];
  let hookLogs: string[];
  if (stems === undefined) {
    // No matching task (or unreadable tasks.json) — accept the argument as a
    // direct session / hook-log id if a matching JSONL file exists. Read once
    // and reuse the result rather than re-framing the file for existence.
    all = await collectRecords(dataDir, [taskId]);
    if (all.length === 0) {
      const hint = tasks === undefined ? ` (could not read tasks.json in ${dataDir})` : '';
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
