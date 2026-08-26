import { readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { isTerminalStatus, type TaskStatus } from './task-status.js';

/**
 * Data-directory retention/compaction maintenance sweep.
 *
 * Kookr accumulates per-task append-only stores under its data directory
 * (`~/.kookr` or `~/.kookr-<port>`) with no global retention policy. This
 * module provides a *conservative, idempotent* prune surface. It removes:
 *
 *  - hook event logs — the live `<tmux>.jsonl` base file and its rotated
 *    `<tmux>.jsonl.N` generations (issue #1433) — that belong to terminal
 *    (completed/terminated/cancelled) tasks whose last activity is older than a
 *    configurable age threshold, plus long-dead orphan hook logs no task
 *    references any more;
 *  - activity-ledger files (`activity/<kookrSessionId>.jsonl` and their rotated
 *    `.jsonl.1` companion) under the same terminal/orphan-and-aged rules;
 *  - aged rotated `server.log.N` generations;
 *  - aged `playbook-state/<playbook>/<runKey>` run directories;
 *  - aged operator-signal spool files under
 *    `playbook-state/operator-signals/` (issue #2034), with separate caps for
 *    delivered vs undelivered files and a minimum-age floor for active fire keys; and
 *  - aged first-hook-miss diagnostic reports under `reports/first-hook-miss-*.md`
 *    (issue #2233) — orphan flat files that accumulate when GC-on-delete was
 *    never wired. Hung-task reports (`hung-task-*.md`) are intentionally left
 *    alone (they already have delete-time GC via issue #2126).
 *
 * ## Why these stores, and (deliberately) nothing else
 *
 * Hook event logs live at `<dataDir>/hooks/<tmuxSession>.jsonl` and are keyed
 * directly by a value that is present on every {@link Task} session
 * (`session.tmuxSession`), so they can be mapped to an owning task with no
 * ambiguity. Once a task is terminal *and* aged, the live `HookFileWatcher`
 * no longer watches that session, so the file is inert append-only history.
 *
 * Activity-ledger files live at `<dataDir>/activity/<kookrSessionId>.jsonl`.
 * For the dominant file-source ingestion path the `kookrSessionId` IS the
 * `tmuxSession` (see `HookIngestion.injectHookEvent`), so the exact same
 * active-session exclusion + age gate the hook-log planner uses applies here:
 * a session attached to any non-terminal task is never eligible, and an
 * unmapped orphan is aged by file mtime so a freshly-created live session is
 * always protected. This is why activity is no longer in
 * {@link PRESERVED_STORES} — it is GC'd for terminal/orphan-and-aged sessions
 * exactly like hook logs (idea-scout rank 1; prod `activity` was 5.9 GB).
 *
 * Rotated `server.log.N` generations are process-level diagnostics created by
 * `scripts/prod-restart.sh`; only numbered generations are pruned, never the
 * live `server.log`.
 *
 * Playbook run state lives at `<dataDir>/playbook-state/<playbook>/<runKey>`.
 * Runs never expire on their own (prod: 430 MB). The planner removes run
 * directories older than a configurable age, while (a) always keeping the
 * newest `playbookStateKeepLast` runs per playbook and (b) never removing a run
 * whose `runKey` matches a still-active task id, so an in-flight resume is never
 * pulled out from under a running task (idea-scout rank 6).
 *
 * Operator-signal spool files live at
 * `<dataDir>/playbook-state/operator-signals/<key>.json` (issue #1716/#2034).
 * The delivery bridge marks delivered occurrences in a sibling
 * `.delivered.json` (file name → delivered `createdAt`). Multi-day unattended
 * runs can accumulate these files without retention; the planner therefore
 * removes delivered files older than
 * {@link MaintenancePruneOptions.operatorSignalDeliveredMaxAgeDays} and
 * undelivered files older than
 * {@link MaintenancePruneOptions.operatorSignalUndeliveredMaxAgeDays}, while
 * never deleting files younger than
 * {@link MaintenancePruneOptions.operatorSignalMinAgeDays} (active fire-key
 * floor). Undelivered defaults are longer than delivered so offline paging is
 * not truncated early. The well-known `operator-signals` directory is never
 * treated as a playbook with run keys.
 *
 * First-hook-miss reports live at
 * `<dataDir>/reports/first-hook-miss-<taskId>-<slug>.md` (issue #2036 writer,
 * #2233 retention). Unlike hung-task reports they have no delete-time GC, so
 * unattended hosts accumulate aged orphans after the owning task is gone. The
 * planner ages them by file mtime against {@link MaintenancePruneOptions.maxAgeDays}
 * and only matches the `first-hook-miss-*.md` prefix — sibling report classes
 * (notably `hung-task-*.md`) are never candidates.
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
const ACTIVITY_DIRNAME = 'activity';
const PLAYBOOK_STATE_DIRNAME = 'playbook-state';
/** Flat diagnostic reports written by reapers (`first-hook-miss`, hung-task, …). */
const REPORTS_DIRNAME = 'reports';
/** Flat spool under playbook-state; matches operator-signal.ts path layout. */
const OPERATOR_SIGNALS_DIRNAME = 'operator-signals';
/** Delivery marker file name; mirrors DELIVERED_MARKER_FILE in operator-signal.ts. */
const OPERATOR_SIGNAL_DELIVERED_MARKER = '.delivered.json';
const SERVER_LOG_GENERATION_RE = /^server\.log\.(\d+)$/;
/**
 * First-hook-miss report basenames written by first-hook-deadline-sweep.ts:
 * `first-hook-miss-<taskId>-<iso-slug>.md`. Deliberately narrower than a generic
 * `reports/*.md` match so hung-task and other sibling reports stay untouched.
 */
const FIRST_HOOK_MISS_REPORT_RE = /^first-hook-miss-.+\.md$/;
/**
 * Root-level temporary names emitted by Kookr's atomic writers. Keep this
 * allowlist explicit: a generic `.tmp-*` sweep could delete an operator's
 * unrelated temporary file in the same directory.
 */
const ATOMIC_WRITE_TEMP_RE = /^(?:\.tmp-(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|(?:effort-split\.jsonl|detection-stats\.json|last-good-health\.json|timer-health\.state\.json)\.tmp-\d+(?:-\d+)?|finding-evidence-review-queue\.json\.\d+\.\d+\.tmp|\.achievements-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp|(?:\.schedules|\.schedule-rollups)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp|\.resource-watchdog-state\.[0-9a-f]{12}\.tmp|hook-replay-checkpoints\.json\.tmp|audit\.snapshot\.json\.\d+\.tmp|relay-connection\.json\.\d+\.\d+\.tmp|\.(?:node-id|node-epoch)\.\d+\.\d+\.tmp)$/;
/** Rotated JSONL segment: `<session>.jsonl.N`. Captures the owning session and
 *  the numeric generation. Shared by hook logs (issue #1433) and the activity
 *  ledger's rotated `.jsonl.1` companion. */
const ROTATED_JSONL_RE = /^(.*)\.jsonl\.(\d+)$/;
const DEFAULT_MAX_AGE_DAYS = 30;
/** Keep the newest N runs per playbook regardless of age (0 = age-only). */
const DEFAULT_PLAYBOOK_STATE_KEEP_LAST = 0;
/** Delivered operator-signal files older than this many days are pruneable. */
const DEFAULT_OPERATOR_SIGNAL_DELIVERED_MAX_AGE_DAYS = 7;
/** Undelivered files keep a longer default so offline pages are not lost early. */
const DEFAULT_OPERATOR_SIGNAL_UNDELIVERED_MAX_AGE_DAYS = 30;
/** Absolute floor: never delete fire keys younger than this many days. */
const DEFAULT_OPERATOR_SIGNAL_MIN_AGE_DAYS = 1;
/** Seven days is long enough to outlive a deploy or transient disk-full retry. */
const DEFAULT_ATOMIC_WRITE_TEMP_MAX_AGE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);

export interface MaintenancePruneOptions {
  /** Absolute path to the Kookr data directory (e.g. `~/.kookr`). */
  dataDir: string;
  /**
   * Remove artifacts for terminal tasks whose last activity is older than this
   * many days. Defaults to {@link DEFAULT_MAX_AGE_DAYS}. Values <= 0 are
   * rejected to avoid accidentally pruning everything.
   */
  maxAgeDays?: number;
  /**
   * Age threshold (days) for `playbook-state/<playbook>/<runKey>` run
   * directories. Defaults to {@link MaintenancePruneOptions.maxAgeDays}. Values
   * <= 0 are rejected.
   */
  playbookStateMaxAgeDays?: number;
  /**
   * Always keep the newest N runs per playbook regardless of age. Defaults to
   * {@link DEFAULT_PLAYBOOK_STATE_KEEP_LAST} (age-only). Only ever *protects*
   * runs from removal — it never triggers extra deletion.
   */
  playbookStateKeepLast?: number;
  /**
   * Age threshold (days) for operator-signal files whose current occurrence is
   * marked delivered in `.delivered.json`. Defaults to
   * {@link DEFAULT_OPERATOR_SIGNAL_DELIVERED_MAX_AGE_DAYS}. Values <= 0 rejected.
   */
  operatorSignalDeliveredMaxAgeDays?: number;
  /**
   * Age threshold (days) for operator-signal files not yet delivered (or
   * re-emitted with a fresher `createdAt` than the marker). Defaults to
   * {@link DEFAULT_OPERATOR_SIGNAL_UNDELIVERED_MAX_AGE_DAYS}, which is longer
   * than the delivered default so undelivered alerts survive offline windows.
   * Values <= 0 rejected.
   */
  operatorSignalUndeliveredMaxAgeDays?: number;
  /**
   * Absolute minimum age (days) before any operator-signal file is eligible —
   * the active fire-key floor. Defaults to
   * {@link DEFAULT_OPERATOR_SIGNAL_MIN_AGE_DAYS}. Values <= 0 rejected.
   */
  operatorSignalMinAgeDays?: number;
  /** Age threshold for recognized root-level atomic-write temp files. Defaults to 7 days. */
  atomicWriteTempMaxAgeDays?: number;
  /** When true, compute the plan but do not delete anything. Defaults to false. */
  dryRun?: boolean;
  /** Injectable clock (ms since epoch) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable open-descriptor probe for deterministic safety tests. */
  openFileChecker?: AtomicWriteTempOpenFileChecker;
}

interface PlannedRemovalBase {
  /** Absolute path of the file (or directory) slated for removal. */
  path: string;
  /** Size in bytes captured at planning time (recursive total for directories). */
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
  /**
   * Rotation generation suffix from `<tmux>.jsonl.N` when pruning a rotated
   * hook-log segment (issue #1433); undefined for the live `<tmux>.jsonl`
   * base file. Rotated segments are aged and mapped by the same owning session
   * as the base so a terminal/orphan session sheds its whole rotation set.
   */
  generation?: number;
}

export interface ActivityLedgerPlannedRemoval extends PlannedRemovalBase {
  /** Artifact category. */
  kind: 'activity-ledger';
  reason: 'completed-task-aged' | 'orphan-aged';
  /** Owning task id when the file maps to a known terminal task; undefined for orphans. */
  taskId?: string;
  /** The Kookr session id the ledger file is keyed by (== tmuxSession for file-source). */
  kookrSessionId: string;
  /** Rotation generation from `<session>.jsonl.N`; undefined for the primary file. */
  generation?: number;
}

export interface ServerLogGenerationPlannedRemoval extends PlannedRemovalBase {
  /** Artifact category. */
  kind: 'server-log-generation';
  reason: 'server-log-generation-aged';
  /** Number suffix from `server.log.N` when pruning a rotated server log. */
  generation: number;
}

export interface PlaybookStateRunPlannedRemoval extends PlannedRemovalBase {
  /** Artifact category. */
  kind: 'playbook-state-run';
  reason: 'playbook-run-aged';
  /** Playbook slug (the `<playbook>` directory name). */
  playbook: string;
  /** Run key (the `<runKey>` directory name). */
  runKey: string;
}

export interface OperatorSignalPlannedRemoval extends PlannedRemovalBase {
  /** Artifact category. */
  kind: 'operator-signal';
  reason: 'operator-signal-delivered-aged' | 'operator-signal-undelivered-aged';
  /** Basename of the signal file under `playbook-state/operator-signals/`. */
  fileName: string;
  /** Whether the current occurrence matched the delivered marker at plan time. */
  deliveryStatus: 'delivered' | 'undelivered';
}

export interface FirstHookMissReportPlannedRemoval extends PlannedRemovalBase {
  /** Artifact category. */
  kind: 'first-hook-miss-report';
  reason: 'first-hook-miss-report-aged';
  /** Basename under `reports/` (e.g. `first-hook-miss-<taskId>-<slug>.md`). */
  fileName: string;
}

export interface AtomicWriteTempPlannedRemoval extends PlannedRemovalBase {
  kind: 'atomic-write-temp';
  reason: 'atomic-write-temp-aged';
  /** Allowlisted root-level temporary basename. */
  fileName: string;
}

export type PlannedRemoval =
  | HookLogPlannedRemoval
  | ActivityLedgerPlannedRemoval
  | ServerLogGenerationPlannedRemoval
  | PlaybookStateRunPlannedRemoval
  | OperatorSignalPlannedRemoval
  | FirstHookMissReportPlannedRemoval
  | AtomicWriteTempPlannedRemoval;

export interface AtomicWriteTempSweepReport {
  /** Number of allowlisted regular files inspected. */
  examinedCount: number;
  /** Number of stale files included in the plan. */
  plannedCount: number;
  /** Number of planned files removed; zero for dry-run. */
  removedCount: number;
  /** Bytes represented by the dry-run plan. */
  reclaimableBytes: number;
  /** Bytes actually reclaimed; zero for dry-run. */
  reclaimedBytes: number;
  /** Stale files skipped because a live process holds them open. */
  skippedOpenCount: number;
  /** Bytes represented by stale files skipped because they are open. */
  skippedOpenBytes: number;
  /** Stale files skipped because open-file verification failed closed. */
  skippedSafetyCheckCount: number;
  /** Allowlisted files retained because they are younger than the threshold. */
  skippedFreshCount: number;
}

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
  /** Structured audit for the root-level atomic-write temp sweep. */
  atomicWriteTempSweep?: AtomicWriteTempSweepReport;
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

interface SessionClassification {
  /** Session names attached to ANY non-terminal task — never eligible. */
  activeSessions: Set<string>;
  /** Session name -> owning terminal task info (most recent activity wins). */
  terminalSessions: Map<string, { taskId: string; lastActivityMs: number }>;
  /** Ids of all non-terminal tasks — used to protect matching playbook runs. */
  activeTaskIds: Set<string>;
}

/**
 * Split every task session into the active-exclusion set and the terminal map
 * used by the hook-log and activity-ledger planners, and collect the ids of all
 * non-terminal tasks for the playbook-state planner's active-run guard.
 *
 * A session belonging to ANY non-terminal task is recorded as active even if
 * another (terminal) task shares the name — active always wins.
 */
function classifySessions(tasks: TaskLike[], now: () => number): SessionClassification {
  const activeSessions = new Set<string>();
  const terminalSessions = new Map<string, { taskId: string; lastActivityMs: number }>();
  const activeTaskIds = new Set<string>();

  for (const task of tasks) {
    // Unknown / non-string statuses fall through to "active" (preserved) —
    // the safe default. isTerminalStatus is the canonical terminal-set check
    // (src/shared/contracts/task-status.ts) so this stays in lockstep if a new
    // terminal status is ever added.
    const status = typeof task.status === 'string' ? (task.status as TaskStatus) : undefined;
    const isTerminal = status !== undefined && isTerminalStatus(status) === true;
    if (!isTerminal && typeof task.id === 'string') activeTaskIds.add(task.id);
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

  return { activeSessions, terminalSessions, activeTaskIds };
}

/**
 * Decide whether a session-keyed file (hook log or activity ledger) is eligible
 * for removal, and if so under what reason and age. Shared by both planners so
 * their safety model can never drift apart.
 *
 * Returns `undefined` when the file must be preserved (active session, or not
 * yet aged past the threshold).
 */
function classifySessionKeyedFile(
  sessionName: string,
  fileMtimeMs: number,
  thresholdMs: number,
  now: () => number,
  classification: SessionClassification,
): { reason: 'completed-task-aged' | 'orphan-aged'; taskId?: string; ageDays: number } | undefined {
  // A session attached to any active task is sacred regardless of age.
  if (classification.activeSessions.has(sessionName)) return undefined;

  const terminal = classification.terminalSessions.get(sessionName);
  let reason: 'completed-task-aged' | 'orphan-aged';
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
    ageRefMs = fileMtimeMs;
    reason = 'orphan-aged';
  }

  if (ageRefMs > thresholdMs) return undefined; // too recent — preserve

  return { reason, taskId, ageDays: Math.floor((now() - ageRefMs) / MS_PER_DAY) };
}

async function planHookLogRemovals({
  dataDir,
  maxAgeDays,
  now,
  classification,
  warnings,
}: {
  dataDir: string;
  maxAgeDays: number;
  now: () => number;
  classification: SessionClassification;
  warnings: string[];
}): Promise<PlannedRemoval[]> {
  const planned: PlannedRemoval[] = [];
  const thresholdMs = now() - maxAgeDays * MS_PER_DAY;

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
    // Match either the live base file `<tmux>.jsonl` or a rotated generation
    // `<tmux>.jsonl.N` (issue #1433). Both map to the same owning session so a
    // terminal/orphan session's whole rotation set is aged and pruned together.
    const rotated = ROTATED_JSONL_RE.exec(fileName);
    let tmuxSession: string;
    let generation: number | undefined;
    if (rotated) {
      tmuxSession = rotated[1];
      generation = Number(rotated[2]);
    } else if (fileName.endsWith('.jsonl')) {
      tmuxSession = fileName.slice(0, -'.jsonl'.length);
    } else {
      continue;
    }

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

    const verdict = classifySessionKeyedFile(tmuxSession, mtimeMs, thresholdMs, now, classification);
    if (!verdict) continue;

    planned.push({
      path: filePath,
      kind: 'hook-log',
      reason: verdict.reason,
      taskId: verdict.taskId,
      tmuxSession,
      bytes,
      ageDays: verdict.ageDays,
      ...(generation !== undefined ? { generation } : {}),
    });
  }

  return planned;
}

async function planActivityLedgerRemovals({
  dataDir,
  maxAgeDays,
  now,
  classification,
  warnings,
}: {
  dataDir: string;
  maxAgeDays: number;
  now: () => number;
  classification: SessionClassification;
  warnings: string[];
}): Promise<PlannedRemoval[]> {
  const planned: PlannedRemoval[] = [];
  const thresholdMs = now() - maxAgeDays * MS_PER_DAY;

  const activityDir = join(dataDir, ACTIVITY_DIRNAME);
  let files: string[];
  try {
    files = await readdir(activityDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return planned; // clean-state no-op
    warnings.push(`Could not read activity directory ${activityDir}: ${(err as Error).message}`);
    return planned;
  }

  for (const fileName of files) {
    // A ledger file is either `<session>.jsonl` (primary) or its rotated
    // `<session>.jsonl.N` companion; both map to the same owning session.
    const rotated = ROTATED_JSONL_RE.exec(fileName);
    let kookrSessionId: string;
    let generation: number | undefined;
    if (rotated) {
      kookrSessionId = rotated[1];
      generation = Number(rotated[2]);
    } else if (fileName.endsWith('.jsonl')) {
      kookrSessionId = fileName.slice(0, -'.jsonl'.length);
    } else {
      continue;
    }
    if (!kookrSessionId) continue;

    const filePath = join(activityDir, fileName);
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

    const verdict = classifySessionKeyedFile(kookrSessionId, mtimeMs, thresholdMs, now, classification);
    if (!verdict) continue;

    planned.push({
      path: filePath,
      kind: 'activity-ledger',
      reason: verdict.reason,
      taskId: verdict.taskId,
      kookrSessionId,
      bytes,
      ageDays: verdict.ageDays,
      ...(generation !== undefined ? { generation } : {}),
    });
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
 * Plan removal of aged first-hook-miss diagnostic reports (issue #2233).
 *
 * Reports are flat under `reports/` and keyed only by basename prefix — no
 * tasks.json dependency. Age is file mtime against `maxAgeDays`. Sibling
 * report classes (e.g. hung-task) never match {@link FIRST_HOOK_MISS_REPORT_RE}.
 */
async function planFirstHookMissReportRemovals({
  dataDir,
  maxAgeDays,
  now,
  warnings,
}: {
  dataDir: string;
  maxAgeDays: number;
  now: () => number;
  warnings: string[];
}): Promise<FirstHookMissReportPlannedRemoval[]> {
  const planned: FirstHookMissReportPlannedRemoval[] = [];
  const thresholdMs = now() - maxAgeDays * MS_PER_DAY;
  const reportsDir = join(dataDir, REPORTS_DIRNAME);
  let entries: string[];
  try {
    entries = await readdir(reportsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return planned;
    warnings.push(`Could not read reports directory ${reportsDir}: ${(err as Error).message}`);
    return planned;
  }

  for (const fileName of entries) {
    if (!FIRST_HOOK_MISS_REPORT_RE.test(fileName)) continue;

    const filePath = join(reportsDir, fileName);
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
      kind: 'first-hook-miss-report',
      reason: 'first-hook-miss-report-aged',
      fileName,
      bytes,
      ageDays: Math.floor((now() - mtimeMs) / MS_PER_DAY),
    });
  }

  return planned;
}

interface AtomicWriteTempPlan {
  planned: AtomicWriteTempPlannedRemoval[];
  examinedCount: number;
  skippedFreshCount: number;
  skippedOpenCount: number;
  skippedOpenBytes: number;
  skippedSafetyCheckCount: number;
}

export type AtomicWriteTempOpenState = 'open' | 'closed' | 'unknown';
export type AtomicWriteTempOpenFileChecker = (
  filePaths: readonly string[],
) => Promise<ReadonlyMap<string, AtomicWriteTempOpenState>>;

/**
 * Ask the host whether a live process currently has a candidate open. `lsof`
 * exists on the required Linux and macOS platforms. Any inability to verify
 * is treated as unknown so the caller can preserve the file rather than risk
 * deleting a file that a process still needs.
 */
async function checkOpenFiles(filePaths: readonly string[]): Promise<Map<string, AtomicWriteTempOpenState>> {
  const states = new Map<string, AtomicWriteTempOpenState>();
  if (filePaths.length === 0) return states;
  const markOpenPaths = (stdout: string): void => {
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n')) {
        const path = line.slice(1);
        if (states.has(path)) states.set(path, 'open');
      }
    }
  };
  try {
    const { stdout } = await execFileAsync('lsof', ['-Fpn', '--', ...filePaths], {
      encoding: 'utf8',
      maxBuffer: Math.max(16 * 1024, filePaths.length * 128),
      timeout: 10_000,
    });
    for (const filePath of filePaths) states.set(filePath, 'closed');
    markOpenPaths(stdout);
  } catch (err) {
    const code: unknown = (err as NodeJS.ErrnoException).code;
    const stdout = typeof (err as { stdout?: unknown }).stdout === 'string'
      ? (err as { stdout: string }).stdout
      : '';
    const stderr = typeof (err as { stderr?: unknown }).stderr === 'string'
      ? (err as { stderr: string }).stderr
      : '';
    // lsof exits 1 when it found no matching open descriptor; with a mixed
    // batch it may still emit the paths that are open. An empty stderr means
    // the result is valid, so paths absent from stdout are closed. A status
    // error can also use exit 1, so any stderr keeps the batch unknown.
    const validNoMatch = (code === 1 || code === '1') && stderr.trim() === '';
    for (const filePath of filePaths) states.set(filePath, validNoMatch ? 'closed' : 'unknown');
    if (validNoMatch) markOpenPaths(stdout);
  }
  return states;
}

/**
 * Plan stale root-level atomic-write temps. The planner performs the first
 * descriptor check; the executor repeats it immediately before unlinking to
 * narrow the check/delete race. There is no portable atomic "unlink only when
 * unopened" syscall, so a process that opens a file after the final check can
 * still race; writers should therefore use short-lived temps and the sweep
 * remains conservative everywhere it can observe the race.
 */
async function planAtomicWriteTempRemovals({
  dataDir,
  maxAgeDays,
  now,
  warnings,
  openFileChecker,
}: {
  dataDir: string;
  maxAgeDays: number;
  now: () => number;
  warnings: string[];
  openFileChecker: AtomicWriteTempOpenFileChecker;
}): Promise<AtomicWriteTempPlan> {
  const result: AtomicWriteTempPlan = {
    planned: [],
    examinedCount: 0,
    skippedFreshCount: 0,
    skippedOpenCount: 0,
    skippedOpenBytes: 0,
    skippedSafetyCheckCount: 0,
  };
  const thresholdMs = now() - maxAgeDays * MS_PER_DAY;
  const staleCandidates: { path: string; fileName: string; bytes: number; mtimeMs: number }[] = [];
  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`Could not read root atomic-write temp files in ${dataDir}: ${(err as Error).message}`);
    }
    return result;
  }

  let safetyWarningAdded = false;
  for (const fileName of entries) {
    if (!ATOMIC_WRITE_TEMP_RE.test(fileName)) continue;
    const filePath = join(dataDir, fileName);
    let bytes: number;
    let mtimeMs: number;
    try {
      const file = await stat(filePath);
      if (!file.isFile()) continue;
      bytes = file.size;
      mtimeMs = file.mtimeMs;
    } catch {
      continue;
    }
    result.examinedCount += 1;
    if (mtimeMs > thresholdMs) {
      result.skippedFreshCount += 1;
      continue;
    }

    staleCandidates.push({ path: filePath, fileName, bytes, mtimeMs });
  }

  const openStates = await openFileChecker(staleCandidates.map((candidate) => candidate.path));
  for (const candidate of staleCandidates) {
    const openState = openStates.get(candidate.path) ?? 'unknown';
    if (openState === 'open') {
      result.skippedOpenCount += 1;
      result.skippedOpenBytes += candidate.bytes;
      continue;
    }
    if (openState === 'unknown') {
      result.skippedSafetyCheckCount += 1;
      if (!safetyWarningAdded) {
        warnings.push(
          'Could not verify whether one or more atomic-write temp files are open; preserving those files.',
        );
        safetyWarningAdded = true;
      }
      continue;
    }
    result.planned.push({
      path: candidate.path,
      kind: 'atomic-write-temp',
      reason: 'atomic-write-temp-aged',
      fileName: candidate.fileName,
      bytes: candidate.bytes,
      ageDays: Math.floor((now() - candidate.mtimeMs) / MS_PER_DAY),
    });
  }
  return result;
}

/** Recursive total byte size of a directory tree; best-effort (skips races). */
async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(entryPath);
    } else if (entry.isFile()) {
      try {
        total += (await stat(entryPath)).size;
      } catch {
        // vanished mid-walk — ignore
      }
    }
  }
  return total;
}

async function planPlaybookStateRemovals({
  dataDir,
  maxAgeDays,
  keepLast,
  now,
  classification,
  warnings,
}: {
  dataDir: string;
  maxAgeDays: number;
  keepLast: number;
  now: () => number;
  classification: SessionClassification;
  warnings: string[];
}): Promise<PlannedRemoval[]> {
  const planned: PlannedRemoval[] = [];
  const thresholdMs = now() - maxAgeDays * MS_PER_DAY;

  const root = join(dataDir, PLAYBOOK_STATE_DIRNAME);
  let playbookDirs: Dirent[];
  try {
    playbookDirs = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return planned; // clean-state no-op
    warnings.push(`Could not read playbook-state directory ${root}: ${(err as Error).message}`);
    return planned;
  }

  for (const playbookEntry of playbookDirs) {
    if (!playbookEntry.isDirectory()) continue;
    const playbook = playbookEntry.name;
    // The operator-signal spool is a flat file directory under playbook-state,
    // not a playbook with run keys — it has its own retention planner (issue #2034).
    if (playbook === OPERATOR_SIGNALS_DIRNAME) continue;
    const playbookDir = join(root, playbook);

    let runEntries: Dirent[];
    try {
      runEntries = await readdir(playbookDir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`Could not read playbook run directory ${playbookDir}: ${(err as Error).message}`);
      continue;
    }

    // Collect run directories with their mtime, newest first.
    const runs: { runKey: string; path: string; mtimeMs: number }[] = [];
    for (const runEntry of runEntries) {
      if (!runEntry.isDirectory()) continue;
      const runPath = join(playbookDir, runEntry.name);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(runPath)).mtimeMs;
      } catch {
        continue; // vanished — nothing to do
      }
      runs.push({ runKey: runEntry.name, path: runPath, mtimeMs });
    }
    runs.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (let index = 0; index < runs.length; index++) {
      const run = runs[index];
      // Keep-last floor: the newest `keepLast` runs are always protected.
      if (index < keepLast) continue;
      // Never remove a run whose key matches a still-active task id — an
      // in-flight resume must never lose its durable state.
      if (classification.activeTaskIds.has(run.runKey)) continue;
      if (run.mtimeMs > thresholdMs) continue; // too recent — preserve

      const bytes = await directorySizeBytes(run.path);
      planned.push({
        path: run.path,
        kind: 'playbook-state-run',
        reason: 'playbook-run-aged',
        playbook,
        runKey: run.runKey,
        bytes,
        ageDays: Math.floor((now() - run.mtimeMs) / MS_PER_DAY),
      });
    }
  }

  return planned;
}

/**
 * True when a basename looks like an operator-signal payload file (not a
 * marker, temp, or other sidecar). Mirrors listSignalFiles() in
 * operator-signal.ts without importing across the observability boundary.
 */
function isOperatorSignalPayloadFile(name: string): boolean {
  return name.endsWith('.json') && !name.startsWith('.') && !name.includes('.tmp-');
}

/**
 * Load the delivery marker. Corrupt/missing → empty object (all files treated
 * as undelivered, which uses the longer retention and is the safe default).
 */
async function loadOperatorSignalDeliveredMarker(
  signalDir: string,
): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(signalDir, OPERATOR_SIGNAL_DELIVERED_MARKER), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Corrupt/unreadable: fall through to empty marker.
    }
  }
  return {};
}

/** Best-effort `createdAt` from a signal file; undefined when unreadable. */
async function readOperatorSignalCreatedAt(filePath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { createdAt?: unknown }).createdAt === 'string'
    ) {
      return (parsed as { createdAt: string }).createdAt;
    }
  } catch {
    // unreadable / invalid JSON — treat as undelivered below
  }
  return undefined;
}

async function planOperatorSignalRemovals({
  dataDir,
  deliveredMaxAgeDays,
  undeliveredMaxAgeDays,
  minAgeDays,
  now,
  warnings,
}: {
  dataDir: string;
  deliveredMaxAgeDays: number;
  undeliveredMaxAgeDays: number;
  minAgeDays: number;
  now: () => number;
  warnings: string[];
}): Promise<OperatorSignalPlannedRemoval[]> {
  const planned: OperatorSignalPlannedRemoval[] = [];
  const signalDir = join(dataDir, PLAYBOOK_STATE_DIRNAME, OPERATOR_SIGNALS_DIRNAME);
  const floorMs = now() - minAgeDays * MS_PER_DAY;
  const deliveredThresholdMs = now() - deliveredMaxAgeDays * MS_PER_DAY;
  const undeliveredThresholdMs = now() - undeliveredMaxAgeDays * MS_PER_DAY;

  let entries: string[];
  try {
    entries = await readdir(signalDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return planned;
    warnings.push(`Could not read operator-signal directory ${signalDir}: ${(err as Error).message}`);
    return planned;
  }

  const marker = await loadOperatorSignalDeliveredMarker(signalDir);

  for (const fileName of entries) {
    if (!isOperatorSignalPayloadFile(fileName)) continue;

    const filePath = join(signalDir, fileName);
    let bytes = 0;
    let mtimeMs = now();
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      bytes = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // vanished between readdir and stat
    }

    // Active fire-key floor: never delete anything younger than minAgeDays,
    // even when the configured delivery cap would otherwise allow it.
    if (mtimeMs > floorMs) continue;

    const createdAt = await readOperatorSignalCreatedAt(filePath);
    const isDelivered =
      createdAt !== undefined && marker[fileName] === createdAt;
    const thresholdMs = isDelivered ? deliveredThresholdMs : undeliveredThresholdMs;
    if (mtimeMs > thresholdMs) continue;

    planned.push({
      path: filePath,
      kind: 'operator-signal',
      reason: isDelivered ? 'operator-signal-delivered-aged' : 'operator-signal-undelivered-aged',
      fileName,
      deliveryStatus: isDelivered ? 'delivered' : 'undelivered',
      bytes,
      ageDays: Math.floor((now() - mtimeMs) / MS_PER_DAY),
    });
  }

  return planned;
}

/**
 * Drop marker entries for files we just removed so the delivered map does not
 * grow unbounded after the spool files themselves are gone.
 */
async function scrubOperatorSignalMarker(
  dataDir: string,
  removedFileNames: string[],
  warnings: string[],
): Promise<void> {
  if (removedFileNames.length === 0) return;
  const signalDir = join(dataDir, PLAYBOOK_STATE_DIRNAME, OPERATOR_SIGNALS_DIRNAME);
  const markerPath = join(signalDir, OPERATOR_SIGNAL_DELIVERED_MARKER);
  let marker: Record<string, string>;
  try {
    marker = await loadOperatorSignalDeliveredMarker(signalDir);
  } catch {
    return;
  }
  let changed = false;
  for (const name of removedFileNames) {
    if (name in marker) {
      delete marker[name];
      changed = true;
    }
  }
  if (!changed) return;
  const tmp = `${markerPath}.tmp-prune`;
  let renamed = false;
  try {
    await writeFile(tmp, JSON.stringify(marker, null, 2), 'utf8');
    await rename(tmp, markerPath);
    renamed = true;
  } catch (err) {
    warnings.push(
      `Failed to scrub operator-signal delivered marker after prune: ${(err as Error).message}`,
    );
  } finally {
    if (!renamed) {
      try {
        await unlink(tmp);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          warnings.push(
            `Failed to remove operator-signal marker temp file after prune: ${(err as Error).message}`,
          );
        }
      }
    }
  }
}

async function verifyAtomicWriteTempBeforeRemoval(
  removal: AtomicWriteTempPlannedRemoval,
  maxAgeDays: number,
  now: () => number,
  openState: AtomicWriteTempOpenState,
): Promise<'safe' | 'fresh' | 'open' | 'unknown' | 'gone'> {
  let file: Awaited<ReturnType<typeof stat>>;
  try {
    file = await stat(removal.path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    return 'unknown';
  }
  if (!file.isFile()) return 'gone';
  if (file.mtimeMs > now() - maxAgeDays * MS_PER_DAY) return 'fresh';
  if (openState === 'open') return 'open';
  if (openState === 'unknown') return 'unknown';
  return 'safe';
}

async function removeArtifact(removal: PlannedRemoval): Promise<void> {
  if (removal.kind === 'playbook-state-run') {
    await rm(removal.path, { recursive: true, force: true });
    return;
  }
  await unlink(removal.path);
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
  const openFileChecker = options.openFileChecker ?? checkOpenFiles;
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new Error(`maxAgeDays must be a positive number (got ${String(options.maxAgeDays)})`);
  }
  const playbookStateMaxAgeDays = options.playbookStateMaxAgeDays ?? maxAgeDays;
  if (!Number.isFinite(playbookStateMaxAgeDays) || playbookStateMaxAgeDays <= 0) {
    throw new Error(
      `playbookStateMaxAgeDays must be a positive number (got ${String(options.playbookStateMaxAgeDays)})`,
    );
  }
  const playbookStateKeepLast = options.playbookStateKeepLast ?? DEFAULT_PLAYBOOK_STATE_KEEP_LAST;
  if (!Number.isInteger(playbookStateKeepLast) || playbookStateKeepLast < 0) {
    throw new Error(
      `playbookStateKeepLast must be a non-negative integer (got ${String(options.playbookStateKeepLast)})`,
    );
  }
  const operatorSignalDeliveredMaxAgeDays =
    options.operatorSignalDeliveredMaxAgeDays ?? DEFAULT_OPERATOR_SIGNAL_DELIVERED_MAX_AGE_DAYS;
  if (!Number.isFinite(operatorSignalDeliveredMaxAgeDays) || operatorSignalDeliveredMaxAgeDays <= 0) {
    throw new Error(
      `operatorSignalDeliveredMaxAgeDays must be a positive number (got ${String(options.operatorSignalDeliveredMaxAgeDays)})`,
    );
  }
  const operatorSignalUndeliveredMaxAgeDays =
    options.operatorSignalUndeliveredMaxAgeDays ?? DEFAULT_OPERATOR_SIGNAL_UNDELIVERED_MAX_AGE_DAYS;
  if (!Number.isFinite(operatorSignalUndeliveredMaxAgeDays) || operatorSignalUndeliveredMaxAgeDays <= 0) {
    throw new Error(
      `operatorSignalUndeliveredMaxAgeDays must be a positive number (got ${String(options.operatorSignalUndeliveredMaxAgeDays)})`,
    );
  }
  const operatorSignalMinAgeDays =
    options.operatorSignalMinAgeDays ?? DEFAULT_OPERATOR_SIGNAL_MIN_AGE_DAYS;
  if (!Number.isFinite(operatorSignalMinAgeDays) || operatorSignalMinAgeDays <= 0) {
    throw new Error(
      `operatorSignalMinAgeDays must be a positive number (got ${String(options.operatorSignalMinAgeDays)})`,
    );
  }
  const atomicWriteTempMaxAgeDays =
    options.atomicWriteTempMaxAgeDays ?? DEFAULT_ATOMIC_WRITE_TEMP_MAX_AGE_DAYS;
  if (!Number.isFinite(atomicWriteTempMaxAgeDays) || atomicWriteTempMaxAgeDays <= 0) {
    throw new Error(
      `atomicWriteTempMaxAgeDays must be a positive number (got ${String(options.atomicWriteTempMaxAgeDays)})`,
    );
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
    atomicWriteTempSweep: {
      examinedCount: 0,
      plannedCount: 0,
      removedCount: 0,
      reclaimableBytes: 0,
      reclaimedBytes: 0,
      skippedOpenCount: 0,
      skippedOpenBytes: 0,
      skippedSafetyCheckCount: 0,
      skippedFreshCount: 0,
    },
  };

  const atomicWriteTempPlan = await planAtomicWriteTempRemovals({
    dataDir,
    maxAgeDays: atomicWriteTempMaxAgeDays,
    now,
    warnings,
    openFileChecker,
  });
  result.planned.push(...atomicWriteTempPlan.planned);
  result.atomicWriteTempSweep = {
    examinedCount: atomicWriteTempPlan.examinedCount,
    plannedCount: atomicWriteTempPlan.planned.length,
    removedCount: 0,
    reclaimableBytes: atomicWriteTempPlan.planned.reduce((total, removal) => total + removal.bytes, 0),
    reclaimedBytes: 0,
    skippedOpenCount: atomicWriteTempPlan.skippedOpenCount,
    skippedOpenBytes: atomicWriteTempPlan.skippedOpenBytes,
    skippedSafetyCheckCount: atomicWriteTempPlan.skippedSafetyCheckCount,
    skippedFreshCount: atomicWriteTempPlan.skippedFreshCount,
  };

  const tasks = await readTasks(dataDir);
  if (tasks === undefined) {
    // We cannot tell active sessions from dead ones — refuse to delete any
    // session-keyed or task-keyed artifact. server.log generations, the
    // operator-signal spool, and first-hook-miss reports are process/outbox
    // diagnostics with no task dependency, so they can still be pruned.
    warnings.push(
      'tasks.json is unreadable or malformed; skipping hook-log, activity-ledger, and playbook-state pruning to avoid deleting live state.',
    );
    result.planned.push(
      ...(await planServerLogGenerationRemovals({ dataDir, maxAgeDays, now, warnings })),
      ...(await planFirstHookMissReportRemovals({ dataDir, maxAgeDays, now, warnings })),
      ...(await planOperatorSignalRemovals({
        dataDir,
        deliveredMaxAgeDays: operatorSignalDeliveredMaxAgeDays,
        undeliveredMaxAgeDays: operatorSignalUndeliveredMaxAgeDays,
        minAgeDays: operatorSignalMinAgeDays,
        now,
        warnings,
      })),
    );
  } else {
    const classification = classifySessions(tasks, now);
    result.planned.push(
      ...(await planHookLogRemovals({ dataDir, maxAgeDays, now, classification, warnings })),
      ...(await planActivityLedgerRemovals({ dataDir, maxAgeDays, now, classification, warnings })),
      ...(await planServerLogGenerationRemovals({ dataDir, maxAgeDays, now, warnings })),
      ...(await planFirstHookMissReportRemovals({ dataDir, maxAgeDays, now, warnings })),
      ...(await planPlaybookStateRemovals({
        dataDir,
        maxAgeDays: playbookStateMaxAgeDays,
        keepLast: playbookStateKeepLast,
        now,
        classification,
        warnings,
      })),
      ...(await planOperatorSignalRemovals({
        dataDir,
        deliveredMaxAgeDays: operatorSignalDeliveredMaxAgeDays,
        undeliveredMaxAgeDays: operatorSignalUndeliveredMaxAgeDays,
        minAgeDays: operatorSignalMinAgeDays,
        now,
        warnings,
      })),
    );
  }

  // Stable, deterministic ordering for output and tests.
  result.planned.sort((a, b) => a.path.localeCompare(b.path));

  const removedOperatorSignalNames: string[] = [];
  for (const removal of result.planned) {
    if (dryRun) {
      result.reclaimedBytes += removal.bytes; // reclaimable, not yet reclaimed
      continue;
    }
    if (removal.kind === 'atomic-write-temp') {
      const openStates = await openFileChecker([removal.path]);
      const safety = await verifyAtomicWriteTempBeforeRemoval(
        removal,
        atomicWriteTempMaxAgeDays,
        now,
        openStates.get(removal.path) ?? 'unknown',
      );
      if (safety !== 'safe') {
        if (safety === 'open') {
          result.atomicWriteTempSweep!.skippedOpenCount += 1;
          result.atomicWriteTempSweep!.skippedOpenBytes =
            (result.atomicWriteTempSweep!.skippedOpenBytes ?? 0) + removal.bytes;
          warnings.push(`Preserved open atomic-write temp file: ${removal.path}`);
        } else if (safety === 'unknown') {
          result.atomicWriteTempSweep!.skippedSafetyCheckCount += 1;
          warnings.push(`Preserved atomic-write temp file because open-file verification failed: ${removal.path}`);
        } else if (safety === 'fresh') {
          result.atomicWriteTempSweep!.skippedFreshCount += 1;
          warnings.push(`Preserved fresh atomic-write temp file after plan changed: ${removal.path}`);
        }
        continue;
      }
    }
    try {
      await removeArtifact(removal);
      result.removed.push(removal);
      result.reclaimedBytes += removal.bytes;
      if (removal.kind === 'atomic-write-temp') {
        result.atomicWriteTempSweep!.removedCount += 1;
        result.atomicWriteTempSweep!.reclaimedBytes += removal.bytes;
      }
      if (removal.kind === 'operator-signal') {
        removedOperatorSignalNames.push(removal.fileName);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Already gone — idempotent success, but no bytes actually reclaimed now.
        // Keep it out of removed/audit counts: this run did not delete it.
        continue;
      }
      warnings.push(`Failed to remove ${removal.path}: ${(err as Error).message}`);
    }
  }

  if (!dryRun) {
    await scrubOperatorSignalMarker(dataDir, removedOperatorSignalNames, warnings);
  }

  return result;
}
