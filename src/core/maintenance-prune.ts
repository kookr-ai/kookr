import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { isTerminalStatus, type TaskStatus } from './task-status.js';

/**
 * Data-directory retention/compaction maintenance sweep.
 *
 * Kookr accumulates per-task append-only stores under its data directory
 * (`~/.kookr` or `~/.kookr-<port>`) with no global retention policy. This
 * module provides a *conservative, idempotent* prune surface: it removes hook
 * event logs that belong to terminal (completed/terminated/cancelled) tasks
 * whose last activity is older than a configurable age threshold, long-dead
 * orphan hook logs no task references any more, and aged rotated
 * `server.log.N` generations.
 *
 * ## Why hook logs and server.log generations, and (deliberately) nothing else
 *
 * Hook event logs live at `<dataDir>/hooks/<tmuxSession>.jsonl` and are keyed
 * directly by a value that is present on every {@link Task} session
 * (`session.tmuxSession`), so they can be mapped to an owning task with no
 * ambiguity. Once a task is terminal *and* aged, the live `HookFileWatcher`
 * no longer watches that session, so the file is inert append-only history.
 *
 * Rotated `server.log.N` generations are process-level diagnostics created by
 * `scripts/prod-restart.sh`; only numbered generations are pruned, never the
 * live `server.log`.
 *
 * Every other on-disk store is left intact on purpose — see
 * {@link PRESERVED_STORES} for the per-store rationale. The guiding rule from
 * the issue: when a store is ambiguous to map, or is needed for crash recovery
 * / audit, leave it alone rather than over-prune. dtach rings, for example,
 * are rooted under `/tmp/kookr-dtach/<uid>/<instanceId>/rings/` (not the data
 * dir), are keyed by an internal session id rather than `tmuxSession`, and
 * exist specifically so a Kookr restart can recover surviving dtach masters —
 * so they are out of scope here and reconciled by the live backend instead.
 */

const HOOKS_DIRNAME = 'hooks';
const SERVER_LOG_GENERATION_RE = /^server\.log\.(\d+)$/;
const DEFAULT_MAX_AGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface MaintenancePruneOptions {
  /** Absolute path to the Kookr data directory (e.g. `~/.kookr`). */
  dataDir: string;
  /**
   * Remove artifacts for terminal tasks whose last activity is older than this
   * many days. Defaults to {@link DEFAULT_MAX_AGE_DAYS}. Values <= 0 are
   * rejected to avoid accidentally pruning everything.
   */
  maxAgeDays?: number;
  /** When true, compute the plan but do not delete anything. Defaults to false. */
  dryRun?: boolean;
  /** Injectable clock (ms since epoch) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

interface PlannedRemovalBase {
  /** Absolute path of the file slated for removal. */
  path: string;
  /** File size in bytes captured at planning time. */
  bytes: number;
  /** Whole-day age of the artifact at planning time. */
  ageDays: number;
}

export interface HookLogPlannedRemoval extends PlannedRemovalBase {
  /** Artifact category. */
  kind: 'hook-log';
  reason: 'completed-task-aged' | 'orphan-aged';
  /** Owning task id when the file maps to a known terminal task; undefined for orphans. */
  taskId?: string;
  /** The tmux session name the hook file is keyed by. */
  tmuxSession: string;
}

export interface ServerLogGenerationPlannedRemoval extends PlannedRemovalBase {
  /** Artifact category. */
  kind: 'server-log-generation';
  reason: 'server-log-generation-aged';
  /** Number suffix from `server.log.N` when pruning a rotated server log. */
  generation: number;
}

export type PlannedRemoval = HookLogPlannedRemoval | ServerLogGenerationPlannedRemoval;

export interface PreservedStore {
  /** Human-readable label of the store left intact. */
  store: string;
  /** Why it is preserved (crash recovery, audit, ambiguous mapping, …). */
  reason: string;
}

export interface MaintenancePruneResult {
  dataDir: string;
  dryRun: boolean;
  maxAgeDays: number;
  /** Removals that were (or, in dry-run, would be) performed. */
  planned: PlannedRemoval[];
  /** Removals actually executed. Empty when `dryRun` is true. */
  removed: PlannedRemoval[];
  /** Total bytes reclaimed (or, in dry-run, reclaimable). */
  reclaimedBytes: number;
  /** Stores deliberately left intact, with rationale. */
  preserved: PreservedStore[];
  /** Non-fatal issues (unreadable task file, a file that vanished mid-sweep, …). */
  warnings: string[];
}

/**
 * Documented record of every store the sweep deliberately does NOT touch.
 * Surfaced in the result so operators (and tests) can see the conservative
 * choices were intentional rather than overlooked.
 */
export const PRESERVED_STORES: readonly PreservedStore[] = [
  {
    store: 'tasks.json (+ .daily / .predelete snapshots)',
    reason:
      'Source of truth for task history and startup recovery; snapshots already have their own bounded retention.',
  },
  {
    store: 'dtach rings + manifest',
    reason:
      'Rooted under /tmp (not the data dir), keyed by internal session id, and required for crash recovery of surviving dtach masters; reconciled by the live backend.',
  },
  {
    store: 'activity ledger (activity/*.jsonl)',
    reason: 'Audit telemetry with its own size-based rotation; not safe to map per-task or trim here.',
  },
  {
    store: 'interaction logs (sessions/*/interactions.jsonl, interaction-log.jsonl)',
    reason: 'Audit trail keyed by Kookr session id (ambiguous to map to tmuxSession); retained for command-outcome analysis.',
  },
  {
    store: 'detection-stats.json',
    reason: 'Global aggregate counters, not per-task; trimming would corrupt detector quality telemetry.',
  },
  {
    store: 'oss-attempts.json + contribution-ledger.jsonl',
    reason: 'Cross-task contribution history used for rate-limiting and dedup; not tied to a single task lifecycle.',
  },
  {
    store: 'ralph-iterations.jsonl',
    reason: 'Lives in the task workspace (not the data dir) and is part of the per-loop audit trail.',
  },
];

interface TaskLike {
  id?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  terminatedAt?: unknown;
  createdAt?: unknown;
  sessions?: unknown;
}

interface SessionLike {
  tmuxSession?: unknown;
  lastEventAt?: unknown;
}

function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** Most recent activity timestamp (ms) we can attribute to a task. */
function taskLastActivityMs(task: TaskLike): number | undefined {
  const candidates: number[] = [];
  for (const ts of [task.updatedAt, task.terminatedAt, task.createdAt]) {
    const ms = toEpochMs(ts);
    if (ms !== undefined) candidates.push(ms);
  }
  if (Array.isArray(task.sessions)) {
    for (const session of task.sessions as SessionLike[]) {
      const ms = toEpochMs(session?.lastEventAt);
      if (ms !== undefined) candidates.push(ms);
    }
  }
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

function sessionsOf(task: TaskLike): SessionLike[] {
  return Array.isArray(task.sessions) ? (task.sessions as SessionLike[]) : [];
}

/**
 * Read and tolerantly parse `tasks.json`. Returns `undefined` when the file is
 * missing or unparseable — callers MUST treat that as "cannot determine which
 * sessions are active" and prune nothing, rather than risk deleting live state.
 */
async function readTasks(dataDir: string): Promise<TaskLike[] | undefined> {
  const path = join(dataDir, 'tasks.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  // v2 envelope { version, tasks: [...] }; tolerate a bare array too.
  const tasks = Array.isArray(parsed)
    ? parsed
    : (parsed as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) return undefined;
  return tasks as TaskLike[];
}

async function planHookLogRemovals({
  dataDir,
  maxAgeDays,
  now,
  warnings,
}: {
  dataDir: string;
  maxAgeDays: number;
  now: () => number;
  warnings: string[];
}): Promise<PlannedRemoval[]> {
  const planned: PlannedRemoval[] = [];
  const tasks = await readTasks(dataDir);
  if (tasks === undefined) {
    // We cannot tell active sessions from dead ones — refuse to delete hook logs.
    warnings.push(
      'tasks.json is unreadable or malformed; skipping all hook-log pruning to avoid deleting live state.',
    );
    return planned;
  }

  const thresholdMs = now() - maxAgeDays * MS_PER_DAY;

  // tmuxSession -> owning terminal task info. Active-task sessions are recorded
  // separately as a hard exclusion set: a session belonging to ANY non-terminal
  // task is never eligible, even if another (terminal) task shares the name.
  const activeSessions = new Set<string>();
  const terminalSessions = new Map<string, { taskId: string; lastActivityMs: number }>();

  for (const task of tasks) {
    // Unknown / non-string statuses fall through to "active" (preserved) —
    // the safe default. isTerminalStatus is the canonical terminal-set check
    // (src/shared/contracts/task-status.ts) so this stays in lockstep if a new
    // terminal status is ever added.
    const status = typeof task.status === 'string' ? (task.status as TaskStatus) : undefined;
    const isTerminal = status !== undefined && isTerminalStatus(status) === true;
    for (const session of sessionsOf(task)) {
      const tmux = typeof session.tmuxSession === 'string' ? session.tmuxSession : undefined;
      if (!tmux) continue;
      if (!isTerminal) {
        activeSessions.add(tmux);
        continue;
      }
      const lastActivityMs = taskLastActivityMs(task) ?? now();
      const existing = terminalSessions.get(tmux);
      // Keep the most recent activity if the same session name recurs.
      if (!existing || lastActivityMs > existing.lastActivityMs) {
        terminalSessions.set(tmux, {
          taskId: typeof task.id === 'string' ? task.id : 'unknown',
          lastActivityMs,
        });
      }
    }
  }

  const hooksDir = join(dataDir, HOOKS_DIRNAME);
  let hookFiles: string[];
  try {
    hookFiles = await readdir(hooksDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return planned; // clean-state no-op
    warnings.push(`Could not read hooks directory ${hooksDir}: ${(err as Error).message}`);
    return planned;
  }

  for (const fileName of hookFiles) {
    if (!fileName.endsWith('.jsonl')) continue;
    const tmuxSession = fileName.slice(0, -'.jsonl'.length);

    // A session attached to any active task is sacred regardless of age.
    if (activeSessions.has(tmuxSession)) continue;

    const filePath = join(hooksDir, fileName);
    let bytes = 0;
    let mtimeMs = now();
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      bytes = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // vanished between readdir and stat — nothing to do
    }

    const terminal = terminalSessions.get(tmuxSession);
    let reason: HookLogPlannedRemoval['reason'];
    let ageRefMs: number;
    let taskId: string | undefined;

    if (terminal) {
      // Age a known terminal task by its last recorded activity.
      ageRefMs = terminal.lastActivityMs;
      reason = 'completed-task-aged';
      taskId = terminal.taskId;
    } else {
      // Orphan: no task references this session. Age it by file mtime so a
      // brand-new session whose task is not yet persisted is protected by the
      // age gate (its mtime is recent).
      ageRefMs = mtimeMs;
      reason = 'orphan-aged';
    }

    if (ageRefMs > thresholdMs) continue; // too recent — preserve

    const ageDays = Math.floor((now() - ageRefMs) / MS_PER_DAY);
    planned.push({ path: filePath, kind: 'hook-log', reason, taskId, tmuxSession, bytes, ageDays });
  }

  return planned;
}

async function planServerLogGenerationRemovals({
  dataDir,
  maxAgeDays,
  now,
  warnings,
}: {
  dataDir: string;
  maxAgeDays: number;
  now: () => number;
  warnings: string[];
}): Promise<PlannedRemoval[]> {
  const planned: PlannedRemoval[] = [];
  const thresholdMs = now() - maxAgeDays * MS_PER_DAY;
  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return planned;
    warnings.push(`Could not read data directory ${dataDir}: ${(err as Error).message}`);
    return planned;
  }

  for (const fileName of entries) {
    const match = SERVER_LOG_GENERATION_RE.exec(fileName);
    if (!match) continue;

    const filePath = join(dataDir, fileName);
    let bytes = 0;
    let mtimeMs = now();
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      bytes = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // vanished between readdir and stat — nothing to do
    }

    if (mtimeMs > thresholdMs) continue;

    planned.push({
      path: filePath,
      kind: 'server-log-generation',
      reason: 'server-log-generation-aged',
      generation: Number(match[1]),
      bytes,
      ageDays: Math.floor((now() - mtimeMs) / MS_PER_DAY),
    });
  }

  return planned;
}

/**
 * Plan (and, unless `dryRun`, execute) a conservative data-directory prune.
 *
 * Idempotent: on a clean data dir, or once aged artifacts have already been
 * removed, it is a silent no-op with an empty plan.
 */
export async function planAndPruneMaintenance(
  options: MaintenancePruneOptions,
): Promise<MaintenancePruneResult> {
  const { dataDir, dryRun = false } = options;
  const now = options.now ?? Date.now;
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new Error(`maxAgeDays must be a positive number (got ${String(options.maxAgeDays)})`);
  }

  const warnings: string[] = [];
  const result: MaintenancePruneResult = {
    dataDir,
    dryRun,
    maxAgeDays,
    planned: [],
    removed: [],
    reclaimedBytes: 0,
    preserved: [...PRESERVED_STORES],
    warnings,
  };

  result.planned.push(
    ...(await planHookLogRemovals({ dataDir, maxAgeDays, now, warnings })),
    ...(await planServerLogGenerationRemovals({ dataDir, maxAgeDays, now, warnings })),
  );

  // Stable, deterministic ordering for output and tests.
  result.planned.sort((a, b) => a.path.localeCompare(b.path));

  for (const removal of result.planned) {
    if (dryRun) {
      result.reclaimedBytes += removal.bytes; // reclaimable, not yet reclaimed
      continue;
    }
    try {
      await unlink(removal.path);
      result.removed.push(removal);
      result.reclaimedBytes += removal.bytes;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Already gone — idempotent success, but no bytes actually reclaimed now.
        result.removed.push(removal);
        continue;
      }
      warnings.push(`Failed to remove ${removal.path}: ${(err as Error).message}`);
    }
  }

  return result;
}
