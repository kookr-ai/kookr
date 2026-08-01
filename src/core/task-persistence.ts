import { readFile, access, copyFile, readdir, unlink, rename } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isActiveStatus, type Task } from './tasks.js';
import type { Anomaly, LegacyPersistedSnooze, PersistedSnooze } from './types.js';
import type { AttentionQueue, SnoozeEntry } from './attention-queue.js';
import type { TaskStore } from './tasks.js';
import type { PersistedSuppressionEntry } from './snooze-suppression.js';
import { normalizeAgentType } from './agent-types.js';
import { UNKNOWN_PROVENANCE } from './task-provenance.js';
import { atomicWriteFile } from './persistence-utils.js';
import { createLogger } from './logger.js';
import { recordHotPath } from './hot-path-sampler.js';
import {
  isTaskRelationLifecycle,
  isTaskRelationSource,
  isTaskRelationType,
  type TaskRelation,
} from '../shared/contracts/task-relations.js';

export class CorruptTaskFileError extends Error {
  constructor(filePath: string, cause?: unknown) {
    super(`Corrupt task file: ${filePath}`);
    this.name = 'CorruptTaskFileError';
    this.cause = cause;
  }
}

/** Envelope for task persistence — includes metadata alongside the task array. */
interface TaskFileEnvelope {
  version: 2;
  lifetimeSpendUsd: number;
  tasks: Task[];
  snoozes?: PersistedSnooze[];
  snoozedFindings?: LegacyPersistedSnooze[];
  suppressionState?: PersistedSuppressionEntry[];
  /** Typed task-relation graph (issue #599). Absent envelopes pre-#599 deserialize to an empty graph. */
  relations?: TaskRelation[];
}

const logger = createLogger('task-persistence');

export interface TaskSaveMetrics {
  filePath: string;
  bytes: number;
  taskCount: number;
  relationCount: number;
  serializeMs: number;
  writeMs: number;
  totalMs: number;
}

function roundDuration(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function maybeLogTaskSaveMetrics(metrics: TaskSaveMetrics): void {
  if (process.env.KOOKR_LOG_TASK_SAVE_METRICS !== '1') return;
  logger.info('saved tasks.json', {
    filePath: metrics.filePath,
    bytes: metrics.bytes,
    taskCount: metrics.taskCount,
    relationCount: metrics.relationCount,
    serializeMs: metrics.serializeMs,
    writeMs: metrics.writeMs,
    totalMs: metrics.totalMs,
  });
}

/**
 * Save tasks to a JSON file atomically (write to temp, fsync, then rename).
 * The fsync ensures data is durable on disk before the rename, preventing
 * data loss on power failure or kernel crash.
 */
export async function saveTasks(
  tasks: Task[],
  filePath: string,
  lifetimeSpendUsd?: number,
  snoozes?: PersistedSnooze[],
  suppressionState?: PersistedSuppressionEntry[],
  relations?: TaskRelation[],
): Promise<TaskSaveMetrics> {
  const startedAt = performance.now();
  const envelope: TaskFileEnvelope = {
    version: 2,
    lifetimeSpendUsd: lifetimeSpendUsd ?? 0,
    tasks,
  };
  if (snoozes && snoozes.length > 0) {
    envelope.snoozes = snoozes;
  }
  if (suppressionState && suppressionState.length > 0) {
    envelope.suppressionState = suppressionState;
  }
  if (relations && relations.length > 0) {
    envelope.relations = relations;
  }
  const serialized = JSON.stringify(envelope, null, 2);
  const serializedAt = performance.now();
  await atomicWriteFile(filePath, serialized);
  const finishedAt = performance.now();
  const metrics: TaskSaveMetrics = {
    filePath,
    bytes: Buffer.byteLength(serialized, 'utf-8'),
    taskCount: tasks.length,
    relationCount: relations?.length ?? 0,
    serializeMs: roundDuration(serializedAt - startedAt),
    writeMs: roundDuration(finishedAt - serializedAt),
    totalMs: roundDuration(finishedAt - startedAt),
  };
  maybeLogTaskSaveMetrics(metrics);
  // Hot-path ranking (issue #1781): task-save total time is a known heavy
  // contributor (serialize + fsync). Always recorded — cheap and independent of
  // the env-gated metrics log above.
  recordHotPath('task_save', metrics.totalMs);
  return metrics;
}

// ---------------------------------------------------------------------------
// Snapshot rotation — rfc-task-loss-prevention D3
// ---------------------------------------------------------------------------
//
// Two snapshot surfaces coexist:
//   - 'daily':     first successful save of each local day, 7-day retention
//   - 'predelete': before any destructive op (clearCompleted), last 5
//
// Snapshots are taken AFTER a successful saveTasks — so a failed save never
// overwrites a snapshot with stale content. All snapshot failures are logged
// at warn level and swallowed; the primary save path must never fail because
// of a snapshot error. See rfc §D3 for the full rationale.

export type SnapshotPolicy = 'none' | 'daily' | 'predelete';

const DAILY_RETENTION_DAYS = 7;
const PREDELETE_RETENTION_COUNT = 5;

function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function formatYmdHms(d: Date): string {
  return `${formatYmd(d)}T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
}

function dailyFileName(taskFileBase: string, ymd: string): string {
  return `${taskFileBase}.daily.${ymd}`;
}

function predeleteFileName(taskFileBase: string, stamp: string): string {
  return `${taskFileBase}.predelete.${stamp}`;
}

/** Parse YYYYMMDD; returns null for non-date strings. */
function parseYmd(s: string): Date | null {
  if (!/^\d{8}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return new Date(y, m - 1, d);
}

/**
 * Apply the daily snapshot policy: if no `<filePath>.daily.<today>` exists,
 * copy the just-saved `filePath` to that location. Prunes `.daily.*` files
 * older than DAILY_RETENTION_DAYS.
 *
 * Best-effort. Errors are logged at warn and swallowed.
 */
async function applyDailySnapshot(filePath: string): Promise<void> {
  try {
    const today = formatYmd(new Date());
    const target = dailyFileName(filePath, today);
    try {
      await access(target);
      // Today's snapshot already exists — no-op.
    } catch {
      await copyFile(filePath, target);
    }
    await pruneDailySnapshots(filePath);
  } catch (err) {
    console.warn(`[tasks-snapshot] daily snapshot failed for ${filePath}:`, err);
  }
}

/** Remove `.daily.*` files older than DAILY_RETENTION_DAYS. */
async function pruneDailySnapshots(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const prefix = `${base}.daily.`;

  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - DAILY_RETENTION_DAYS);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const ymd = entry.slice(prefix.length);
    const d = parseYmd(ymd);
    if (!d) continue;
    if (d < cutoff) {
      try {
        await unlink(join(dir, entry));
      } catch {
        // If a daily file is gone by the time we unlink, that's fine.
      }
    }
  }
}

/**
 * Apply the predelete snapshot policy: always take one, then prune to the
 * last PREDELETE_RETENTION_COUNT by lexicographic order of the timestamp
 * suffix (YYYYMMDDTHHMMSS sorts correctly as a string).
 */
async function applyPredeleteSnapshot(filePath: string): Promise<void> {
  try {
    const stamp = formatYmdHms(new Date());
    const target = predeleteFileName(filePath, stamp);
    await copyFile(filePath, target);
    await prunePredeleteSnapshots(filePath);
  } catch (err) {
    console.warn(`[tasks-snapshot] predelete snapshot failed for ${filePath}:`, err);
  }
}

/** Keep only the PREDELETE_RETENTION_COUNT newest `.predelete.*` files. */
async function prunePredeleteSnapshots(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const prefix = `${base}.predelete.`;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  const matches = entries.filter((e) => e.startsWith(prefix));
  // YYYYMMDDTHHMMSS sorts lexicographically == chronologically, so newest last.
  matches.sort();
  const toDelete = matches.slice(0, Math.max(0, matches.length - PREDELETE_RETENTION_COUNT));
  for (const entry of toDelete) {
    try {
      await unlink(join(dir, entry));
    } catch {
      // Missing file is benign.
    }
  }
}

/**
 * Save + optional snapshot. Snapshots are taken AFTER a successful save from
 * the just-written file, so they always reflect durable on-disk state.
 * A snapshot failure never throws.
 */
export async function saveTasksWithSnapshotPolicy(
  tasks: Task[],
  filePath: string,
  policy: SnapshotPolicy,
  lifetimeSpendUsd?: number,
  snoozes?: PersistedSnooze[],
  suppressionState?: PersistedSuppressionEntry[],
  relations?: TaskRelation[],
): Promise<void> {
  await saveTasks(tasks, filePath, lifetimeSpendUsd, snoozes, suppressionState, relations);
  switch (policy) {
    case 'daily':
      await applyDailySnapshot(filePath);
      return;
    case 'predelete':
      await applyPredeleteSnapshot(filePath);
      return;
    case 'none':
      return;
  }
}

// ---------------------------------------------------------------------------

export interface LoadTasksResult {
  tasks: Task[];
  lifetimeSpendUsd?: number;
  snoozes?: PersistedSnooze[];
  snoozedFindings?: LegacyPersistedSnooze[];
  suppressionState?: PersistedSuppressionEntry[];
  /** Validated relations. Empty array when the file pre-dates #599 or has no relations. */
  relations?: TaskRelation[];
  recovery?: TaskFileRecovery;
}

export interface TaskFileRecovery {
  quarantinedPath: string;
  restoredFrom?: string;
}

/**
 * Load tasks from a JSON file. Returns empty array if file doesn't exist.
 * Throws CorruptTaskFileError if file exists but contains invalid JSON.
 * Supports both v1 (plain array) and v2 (envelope with lifetimeSpendUsd).
 */
export async function loadTasks(filePath: string): Promise<LoadTasksResult> {
  try {
    await access(filePath);
  } catch {
    return { tasks: [] };
  }

  const raw = await readFile(filePath, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    // Detect format: v2 envelope has a "version" field, v1 is a plain array
    let tasks: Task[];
    let lifetimeSpendUsd: number | undefined;
    let snoozes: PersistedSnooze[] | undefined;
    let snoozedFindings: LegacyPersistedSnooze[] | undefined;
    let suppressionState: PersistedSuppressionEntry[] | undefined;
    let relations: TaskRelation[] | undefined;
    if (Array.isArray(parsed)) {
      // v1 format: plain array of tasks
      tasks = parsed as Task[];
    } else if (parsed && typeof parsed === 'object' && 'tasks' in parsed) {
      // v2 format: envelope
      tasks = parsed.tasks as Task[];
      lifetimeSpendUsd = parsed.lifetimeSpendUsd;
      snoozes = parsed.snoozes ?? [];
      snoozedFindings = parsed.snoozedFindings ?? [];
      suppressionState = parsed.suppressionState;
      relations = normalizePersistedRelations(parsed.relations);
    } else {
      throw new Error('Unexpected task file format');
    }
    // Restore Date objects from JSON strings
    for (const task of tasks) {
      task.agentType = normalizeAgentType(task.agentType);
      // Legacy tasks persisted before launch provenance (issue #1583) read back
      // with an explicit `unknown` marker rather than a silently absent field.
      if (!task.provenance) task.provenance = { ...UNKNOWN_PROVENANCE };
      task.createdAt = new Date(task.createdAt);
      task.updatedAt = new Date(task.updatedAt);
      if (task.finishedAt) task.finishedAt = new Date(task.finishedAt);
      if (task.terminatedAt) task.terminatedAt = new Date(task.terminatedAt);
      for (const session of task.sessions) {
        session.agentType = normalizeAgentType(session.agentType);
        session.createdAt = new Date(session.createdAt);
      }
    }
    return { tasks, lifetimeSpendUsd, snoozes, snoozedFindings, suppressionState, relations };
  } catch (err) {
    throw new CorruptTaskFileError(filePath, err);
  }
}

/**
 * Boot-time task loader. A corrupt live `tasks.json` should not brick Kookr:
 * preserve the bad file before any autosave can overwrite it, then restore
 * from the newest valid daily snapshot or continue with an empty store.
 */
export async function loadTasksWithRecovery(filePath: string): Promise<LoadTasksResult> {
  try {
    return await loadTasks(filePath);
  } catch (err) {
    if (!(err instanceof CorruptTaskFileError)) throw err;
  }

  const quarantinedPath = await quarantineCorruptTaskFile(filePath);
  const restored = await loadNewestDailySnapshot(filePath);
  if (restored) {
    await restoreSnapshotToLiveFile(restored.path, filePath);
  }
  const recovery: TaskFileRecovery = restored
    ? { quarantinedPath, restoredFrom: restored.path }
    : { quarantinedPath };
  return { ...(restored?.result ?? { tasks: [] }), recovery };
}

async function restoreSnapshotToLiveFile(snapshotPath: string, filePath: string): Promise<void> {
  await atomicWriteFile(filePath, await readFile(snapshotPath, 'utf-8'));
}

async function quarantineCorruptTaskFile(filePath: string): Promise<string> {
  const stamp = new Date().toISOString();
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const target = `${filePath}.corrupt-${stamp}${suffix}`;
    try {
      await rename(filePath, target);
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`Unable to choose a quarantine path for corrupt task file: ${filePath}`);
}

async function loadNewestDailySnapshot(filePath: string): Promise<{ path: string; result: LoadTasksResult } | null> {
  let entries: string[];
  try {
    entries = await readdir(dirname(filePath));
  } catch {
    return null;
  }

  const base = basename(filePath);
  const prefix = `${base}.daily.`;
  const snapshots = entries
    .filter((entry) => entry.startsWith(prefix) && parseYmd(entry.slice(prefix.length)))
    .sort()
    .reverse();

  for (const snapshot of snapshots) {
    const snapshotPath = join(dirname(filePath), snapshot);
    try {
      return { path: snapshotPath, result: await loadTasks(snapshotPath) };
    } catch (err) {
      if (err instanceof CorruptTaskFileError) {
        console.warn(`[tasks-recovery] skipping corrupt daily snapshot ${snapshotPath}`);
        continue;
      }
      console.warn(`[tasks-recovery] skipping unreadable daily snapshot ${snapshotPath}:`, err);
    }
  }
  return null;
}

/**
 * Validate persisted task relations on read. Anything that doesn't satisfy
 * the contract is dropped silently — we'd rather lose a malformed inferred
 * edge than refuse to start with a corrupt task store. Returns undefined
 * when no relations key was present (legacy file).
 */
function normalizePersistedRelations(raw: unknown): TaskRelation[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  const out: TaskRelation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<TaskRelation>;
    if (
      typeof r.id !== 'string'
      || typeof r.sourceTaskId !== 'string'
      || typeof r.targetTaskId !== 'string'
      || !isTaskRelationType(r.type)
      || typeof r.confidence !== 'number'
      || !Number.isFinite(r.confidence)
      || r.confidence < 0
      || r.confidence > 1
      || !isTaskRelationSource(r.source)
      || typeof r.createdAt !== 'string'
      || typeof r.updatedAt !== 'string'
      || !isTaskRelationLifecycle(r.lifecycle)
    ) {
      continue;
    }
    const evidence = Array.isArray(r.evidence) ? r.evidence : [];
    out.push({
      id: r.id,
      sourceTaskId: r.sourceTaskId,
      targetTaskId: r.targetTaskId,
      type: r.type,
      confidence: r.confidence,
      source: r.source,
      evidence: evidence
        .filter((e): e is { snippet?: string; path?: string; observedAt: string } => (
          !!e && typeof e === 'object' && typeof (e as { observedAt?: unknown }).observedAt === 'string'
        ))
        .map((e) => ({
          ...(typeof e.snippet === 'string' ? { snippet: e.snippet } : {}),
          ...(typeof e.path === 'string' ? { path: e.path } : {}),
          observedAt: e.observedAt,
        })),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lifecycle: r.lifecycle,
    });
  }
  return out;
}

/**
 * Serialize snoozed findings from the attention queue for persistence.
 *
 * The queue's snooze entry already carries its map `key` — taskId in
 * production, agentId for orphans/no-resolver tests. We trust that key
 * when it points to a known task, so the persisted record stays
 * authoritative even if `findTaskBySession` would no longer find the
 * recorded agentId (e.g. the original session was pruned).
 *
 * Falls back to `findTaskBySession(agentId)` only when the cached key is
 * not a known taskId (orphan path / tests). Snoozes that don't resolve
 * to any task are dropped with a warn line so the disappearance is
 * debuggable.
 */
export function serializeSnoozed(queue: AttentionQueue, taskStore: TaskStore): PersistedSnooze[] {
  const snoozed = queue.getSnoozed();
  const result: PersistedSnooze[] = [];

  for (const entry of snoozed) {
    let taskId: string | undefined;
    if (taskStore.getTask(entry.key)) {
      taskId = entry.key;
    } else {
      const task = taskStore.findTaskBySession(entry.agentId);
      taskId = task?.id;
    }
    if (!taskId) {
      console.warn(
        `[snooze] Dropping orphan snooze for agent ${entry.agentId} (no owning task)`,
      );
      continue;
    }

    result.push({
      taskId,
      agentId: entry.agentId,
      kind: entry.kind,
      ...(entry.anomaly ? {
        anomaly: {
          agentId: entry.anomaly.agentId,
          type: entry.anomaly.type,
          severity: entry.anomaly.severity,
          explanation: entry.anomaly.explanation,
          detectedAt: entry.anomaly.detectedAt.toISOString(),
          count: entry.anomaly.count,
        },
      } : {}),
      expiresAt: entry.expiresAt,
      createdAt: entry.createdAt,
      expiredPendingRestore: entry.expiredPendingRestore,
      reason: entry.reason,
    });
  }

  return result;
}

/**
 * Deserialize persisted snoozes back to attention-queue format.
 *
 * Snoozes are keyed by taskId in persistence, so survival across redeploys
 * does NOT depend on a live session existing at restore time. We pass the
 * taskId through as the queue's snooze map `key` directly — that bypasses
 * the queue's resolver on import and keeps the round-trip robust against
 * future TaskStore changes (e.g. session pruning).
 *
 * The `agentId` we plug in is "best-known": the latest live session if
 * one exists (so `getSnoozedUntil(liveAgent)` answers immediately after
 * restore), otherwise the anomaly's original agentId. Either way, the
 * snooze sits under taskId in the queue; subsequent sessions of the task
 * will resolve to the same key and be suppressed.
 *
 * Drops when the task itself no longer exists, when an expired no-anomaly
 * task snooze no longer needs suppression, or when an expired finding belongs
 * to a terminal task. Expired findings for active tasks are retained as
 * pending restoration so the server can rebind them to a live session.
 */
export function deserializeSnoozed(
  persisted: Array<PersistedSnooze | LegacyPersistedSnooze> | undefined,
  taskStore: TaskStore,
): SnoozeEntry[] {
  if (!persisted || persisted.length === 0) return [];

  const now = Date.now();
  const result: SnoozeEntry[] = [];

  for (const entry of persisted) {
    const kind = 'kind' in entry ? entry.kind : 'finding';
    const anomaly = 'anomaly' in entry ? entry.anomaly : undefined;
    const expired = entry.expiresAt <= now;
    if (expired && !anomaly) continue;

    const task = taskStore.getTask(entry.taskId);
    if (!task) {
      console.warn(
        `[snooze] Dropping snooze for deleted task ${entry.taskId} `
        + (anomaly ? `(was ${anomaly.type} on agent ${anomaly.agentId})` : '(no anomaly)'),
      );
      continue;
    }
    if (expired && !isActiveStatus(task.status)) continue;

    let chosenAgentId: string | undefined;
    for (let i = task.sessions.length - 1; i >= 0; i--) {
      const s = task.sessions[i];
      if (s.lastStatus !== 'completed' && s.lastStatus !== 'aborted' && !s.crashRecovered) {
        chosenAgentId = s.tmuxSession;
        break;
      }
    }
    if (!chosenAgentId) chosenAgentId = ('agentId' in entry ? entry.agentId : undefined) ?? anomaly?.agentId ?? entry.taskId;

    result.push({
      agentId: chosenAgentId,
      key: entry.taskId,
      kind,
      ...(anomaly ? {
        anomaly: {
          agentId: anomaly.agentId,
          type: anomaly.type,
          severity: anomaly.severity,
          explanation: anomaly.explanation,
          detectedAt: new Date(anomaly.detectedAt),
          count: anomaly.count,
        },
      } : {}),
      expiresAt: entry.expiresAt,
      createdAt: 'createdAt' in entry ? entry.createdAt : now,
      expiredPendingRestore: ('expiredPendingRestore' in entry ? entry.expiredPendingRestore : undefined) ?? expired,
      reason: entry.reason,
    });
  }

  return result;
}
