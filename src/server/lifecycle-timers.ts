import type { Monitor } from '../core/monitor.js';
import { isActiveStatus, type Task, type TaskStore } from '../core/tasks.js';
import type { AgentActivityMeta, AgentEvent, Anomaly, TokenUsage } from '../core/types.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { TokenTracker } from '../core/token-tracker.js';
import type { Watchdog } from '../core/watchdog.js';
import type { BudgetChecker } from '../core/budget-checker.js';
import type { ProjectConfigStore } from '../core/project-config-store.js';
import type { ProgressBudgetBurnDiagnostics } from '../core/progress-budget-burn-diagnostics.js';
import type { HookFileWatcher } from './hook-watcher.js';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { ShadowDetectorRegistry } from '../core/shadow-detector.js';
import type { QuotaAdapter } from '../adapters/quota-adapter.js';
import type { SnoozeSuppressionTracker } from '../core/snooze-suppression.js';
import type { SessionInfo } from '../core/session-read-model.js';
import { reconcile } from './reconciliation.js';
import type { WorktreeRegistry } from '../adapters/git-worktree-registry.js';
import { saveTasks, saveTasksWithSnapshotPolicy, serializeSnoozed } from '../core/task-persistence.js';
import { cleanupSessionResources, completeTask, promotePendingTasks, type LifecycleDeps, type AgentLifecycleDeps } from './agent-lifecycle.js';
import { createSnapshotMessage } from './use-cases/get-snapshot.js';
import { getDetectionStats, type DetectionStats } from '../core/detection-stats.js';
import type { UserInputDeliverySnapshot } from '../shared/contracts/user-input-delivery.js';
import type { PersistenceHealthRecorder } from '../core/persistence-health.js';
import type { TaskStateSaveSchedulerLike } from './task-state-save-scheduler.js';
import {
  DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS,
  listStaleCompletionReadyTasks,
} from '../core/completion-ready-cleanup.js';
import {
  planAndPruneMaintenance,
  type MaintenancePruneResult,
} from '../core/maintenance-prune.js';
import { listExpiredPendingTasks } from '../core/pending-task-ttl.js';
import { appendAuditRow } from '../core/audit-log.js';
import { nowISO } from '../core/interaction-log.js';
import { DEFAULT_HUNG_TASK_REAP_MS, evaluateHungTaskReap } from '../core/hung-task-reaper.js';
import { reapHungTask } from './hung-task-reaper.js';
import type { ProdSmokeTick } from './prod-smoke-tick.js';
import type { DeployLagDetector } from './deploy-lag-detector.js';
import {
  autoCompleteDeliveredTasks,
  createDeliveredCompletionTracker,
  type DeliveredCompletionTracker,
} from './delivered-task-completion-sweep.js';
import type { MergedPrAttribution } from '../core/delivered-task-completion.js';
import { classifyProviderPause, isProviderPaused } from '../core/provider-pause.js';
import { surfaceDirtyWorktreeOnHeadlessCompletion } from './dirty-worktree-completion-finding.js';

export interface TimerDeps {
  monitor: Monitor;
  taskStore: TaskStore;
  queue: AttentionQueue;
  adapter: AgentAdapter;
  adapterRegistry: AdapterRegistry;
  tokenTracker: TokenTracker;
  watchdog: Watchdog;
  hookWatcher: HookFileWatcher;
  terminalBackend: TerminalBackend;
  hooksDir: string;
  tasksFile: string;
  serverCwd: string;
  saveIntervalMs: number;
  livenessIntervalMs: number;
  broadcastToAll: (msg: ServerMessage) => void;
  /** Optional shadow detector registry — runs shadow strategies alongside real detection. */
  shadowRegistry?: ShadowDetectorRegistry;
  /** Agent lifecycle deps — needed for pending task promotion. */
  agentLifecycleDeps?: AgentLifecycleDeps;
  /** Durable terminal-tail store for auto-close / liveness completion paths. */
  taskTailStore?: import('../core/task-tail-store.js').TaskTailStore;
  /** Optional quota adapter for plan usage polling. */
  quotaAdapter?: QuotaAdapter;
  /** Live getter for max concurrent tasks. */
  getMaxActiveTasks?: () => number;
  /**
   * Live getter for the completion-ready auto-close delay, in milliseconds.
   * Read on every liveness tick so a settings change takes effect without a
   * restart. Falls back to {@link DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS}
   * when absent (older wiring / tests).
   */
  getAutoCloseCompletionReadyDelayMs?: () => number;
  /**
   * Live getter for the completion-ready TTL escalation threshold, in
   * milliseconds (issue #1526 Phase A). Read on every liveness tick. Falls
   * back to {@link DEFAULT_COMPLETION_READY_TTL_MS} when absent.
   */
  getCompletionReadyTtlMs?: () => number;
  /**
   * Live getter for the post-merge cleanup budget, in milliseconds (issue
   * #1560, `postMergeCleanupBudgetMinutes` setting). Read on every liveness
   * tick. Falls back to the module default when absent (older wiring/tests).
   */
  getPostMergeCleanupBudgetMs?: () => number;
  /**
   * Delivery attribution for the delivered-completion sweep (issue #1560):
   * a task's attributable merged PR, or null. Wired at bootstrap to read
   * `GitHubStateStore`. Absent → the delivered-completion sweep is skipped.
   */
  resolveMergedPr?: (task: Task) => MergedPrAttribution | null;
  /** Durable signal-outbox spool dir (#1541), threaded so delivered completions raise through it. */
  signalOutboxSpoolDir?: string;
  /** Path to the shared audit.jsonl log — threaded to the completion-ready sweep and hung-task reaper for system-actor audit rows. */
  auditLogPath?: string;
  /**
   * Live getter for the pending-task TTL, in milliseconds (issue #1526
   * Phase C / C3, `pendingTaskTtlMinutes` setting). Read on every liveness
   * tick. Falls back to the module default when absent (older wiring/tests).
   */
  getPendingTaskTtlMs?: () => number;
  /** Kookr data-dir "reports" directory. Hung-task reap writes a markdown evidence report here. */
  reportsDir?: string;
  /** Live getter — hung-task reaper enabled flag (issue #1526 Phase A). Defaults to enabled when absent. */
  getHungTaskReapEnabled?: () => boolean;
  /** Live getter — hung-task reap silence threshold, in milliseconds. */
  getHungTaskReapMs?: () => number;
  /** Optional suppression tracker for snooze storm auto-suppress. */
  suppressionTracker?: SnoozeSuppressionTracker;
  /** Optional durable store for cumulative detector telemetry (persisted on the save tick). */
  detectionStatsStore?: { save(stats: DetectionStats): Promise<void> };
  /** In-memory tracker for runtime persistence failures. */
  persistenceHealth?: PersistenceHealthRecorder;
  /** Coalesced task-state saver used by mutation paths; periodic ticks force-flush it as a backstop. */
  taskStateSaveScheduler?: TaskStateSaveSchedulerLike;
  /** Test seam for task-state persistence. */
  taskStateSaver?: typeof saveTasksWithSnapshotPolicy;
  /** Test seam for detection-stats snapshot gathering. */
  getDetectionStatsSnapshot?: () => DetectionStats;
  /**
   * Optional budget threshold checker (issue #98). When provided and configured with a
   * positive threshold, the token scan tick fires a `budget_exceeded` anomaly the first
   * time a task's observed cost crosses the warning (threshold) and critical (2x)
   * levels. Reactive only — may overshoot by one turn.
   */
  budgetChecker?: BudgetChecker;
  /** Per-project budget threshold overrides. Falls back to the checker's global threshold. */
  projectConfigStore?: Pick<ProjectConfigStore, 'getConfig'>;
  /** Diagnostics-only progress-aware budget-burn sampler. Never mutates the attention queue. */
  progressBudgetBurnDiagnostics?: ProgressBudgetBurnDiagnostics;
  /** Authoritative git worktree registry, refreshed when dashboard clients are connected. */
  worktreeRegistry?: WorktreeRegistry;
  /** Repo path used for single-repo worktree registry refreshes. */
  worktreeRegistryRepoPath?: string;
  /** Live dashboard client count; registry polling is skipped when zero. */
  getDashboardClientCount?: () => number;
  activityMetaProvider?: { getActivityMeta(kookrSessionId: string): AgentActivityMeta | undefined };
  /** True when promoted launches should be audited as running without permission prompts. */
  bypassAllPermissions?: boolean;
  /** Optional closed-loop retry service for unconfirmed mid-session input deliveries. */
  userInputDeliveries?: {
    sweepUnsubmittedDeliveries(): Promise<number>;
    /**
     * Forwarded to tick-driven snapshot broadcasts so they carry the
     * pending-delivery state — without it the frontend's snapshot merge
     * clears `userInputDeliveries` on every tick broadcast (#935).
     */
    getSnapshot(sessionId: string): UserInputDeliverySnapshot[];
  };
  /**
   * Optional server-side scheduled data-directory prune (idea-scout rank 4).
   * Off unless `intervalHours > 0` (default resolved from
   * `KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS`). Runs {@link planAndPruneMaintenance}
   * on a timer so disk growth is not operator-manual-only; every sweep is
   * wrapped so an error is logged and never crashes the server.
   */
  maintenancePrune?: MaintenancePruneScheduleConfig;
  /**
   * Optional hourly prod smoke tick (issue #1593). When provided, a dedicated
   * interval fires the bounded smoke suite against the live prod instance on
   * `prodSmokeTick.hostIntervalMs` and files/updates an operational alert
   * artifact on failure — so a wedge that develops while the server runs (the
   * #1543 /api/health hang) is caught within an hour instead of sitting
   * undetected. Undefined (dev/test, or explicitly disabled) starts no interval.
   * `maybeRun()` never throws and guards against pile-up itself.
   */
  prodSmokeTick?: ProdSmokeTick;
  /**
   * Optional deploy-lag detector (issue #1594). When provided, a dedicated
   * interval compares each monitored prod's running SHA against `origin/main`
   * on `deployLagDetector.hostIntervalMs` and files/updates a single
   * operational-alert artifact when merged commits sit undeployed past the
   * threshold — so an undeployed-merge gap (lucy #1653) is surfaced instead of
   * sitting silent. It never triggers a deploy. Undefined (dev/test, or
   * explicitly disabled) starts no interval. `maybeRun()` never throws and
   * guards against pile-up itself.
   */
  deployLagDetector?: DeployLagDetector;
}

export interface MaintenancePruneScheduleConfig {
  /** Absolute path to the Kookr data directory to sweep. */
  dataDir: string;
  /** Interval between sweeps, in hours. `<= 0` disables the timer entirely. */
  intervalHours: number;
  /** Age threshold forwarded to the prune core. Defaults to the core's default. */
  maxAgeDays?: number;
  /** Keep-last-K protection for playbook-state runs, forwarded to the core. */
  playbookStateKeepLast?: number;
  /** Test seam for the prune core. */
  run?: typeof planAndPruneMaintenance;
  /** Injectable clock forwarded to the prune core (tests). */
  now?: () => number;
  /**
   * Aged terminal task-record pruning (issue #1526 Phase C / C2). Wired at
   * bootstrap to `pruneAgedTaskRecords` over the live TaskStore/Monitor so
   * the in-memory record map — and, via the next periodic save, `tasks.json`
   * — sheds terminal tasks older than the retention window on the same
   * maintenance tick as the disk sweep. Optional so existing wirings and
   * tests are unchanged.
   */
  pruneTaskRecords?: () => Promise<{
    outcome: 'pruned' | 'snapshot_failed';
    prunedTaskIds: string[];
    remainingTasks: number;
    maxAgeDays: number;
  }>;
  /** Fired after ≥1 record was pruned — bootstrap broadcasts a fresh snapshot. */
  onTaskRecordsPruned?: (result: { prunedTaskIds: string[]; remainingTasks: number }) => void;
  /**
   * Payload-diet observability (issue #1526 Phase C / C2): when wired, one
   * stats line is logged after every sweep so operators can watch the diet
   * working. Bootstrap also logs the same line once at boot.
   */
  getPayloadDietStats?: () => PayloadDietStats;
}

/** Snapshot of the payload-diet health counters (issue #1526 Phase C / C2). */
export interface PayloadDietStats {
  /** Task records currently tracked in the store (the `/api/health` `agents` count). */
  trackedTasks: number;
  /** Of which in terminal status. */
  terminalTasks: number;
  /** Serialized bytes of the most recent `all`-scope snapshot broadcast, or null before the first. */
  lastSnapshotBytes: number | null;
}

/** One-line operator-facing payload-diet stats record. */
export function formatPayloadDietLogLine(stats: PayloadDietStats): string {
  const snapshot = stats.lastSnapshotBytes === null
    ? 'none yet'
    : `${stats.lastSnapshotBytes} bytes`;
  return (
    `[payload-diet] tracked task records=${stats.trackedTasks} `
    + `(terminal=${stats.terminalTasks}); last snapshot broadcast=${snapshot}`
  );
}

/** Resolve the scheduled-prune interval (hours) from the environment.
 *  Returns 0 (off) when unset, non-numeric, or non-positive — the safe default:
 *  scheduling is strictly opt-in. */
export function resolveMaintenancePruneIntervalHours(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/**
 * Run one scheduled maintenance prune. Errors are caught and logged — a failed
 * sweep must never bubble into the interval callback and crash the process.
 * Returns the result, or `null` when the sweep threw.
 */
export async function runScheduledMaintenancePrune(
  config: MaintenancePruneScheduleConfig,
): Promise<MaintenancePruneResult | null> {
  try {
    const run = config.run ?? planAndPruneMaintenance;
    const result = await run({
      dataDir: config.dataDir,
      maxAgeDays: config.maxAgeDays,
      playbookStateKeepLast: config.playbookStateKeepLast,
      dryRun: false,
      ...(config.now ? { now: config.now } : {}),
    });
    const warn = result.warnings.length > 0 ? `; ${result.warnings.length} warning(s)` : '';
    console.log(
      `[maintenance-prune] scheduled sweep reclaimed ${result.reclaimedBytes} byte(s) ` +
        `across ${result.removed.length} artifact(s)${warn}`,
    );
    await runScheduledTaskRecordPrune(config);
    return result;
  } catch (err) {
    // Non-fatal: log and keep the server running.
    console.error('[maintenance-prune] scheduled sweep failed:', err);
    await runScheduledTaskRecordPrune(config);
    return null;
  }
}

/**
 * Aged terminal task-record prune leg of the scheduled maintenance sweep
 * (issue #1526 Phase C / C2). Isolated from the disk sweep so either leg
 * failing never suppresses the other; always finishes with the payload-diet
 * stats line when the stats provider is wired.
 */
async function runScheduledTaskRecordPrune(config: MaintenancePruneScheduleConfig): Promise<void> {
  if (config.pruneTaskRecords) {
    try {
      const result = await config.pruneTaskRecords();
      if (result.outcome === 'snapshot_failed') {
        console.error('[maintenance-prune] task-record prune skipped: predelete snapshot failed');
      } else {
        console.log(
          `[maintenance-prune] task-record prune removed ${result.prunedTaskIds.length} aged ` +
            `terminal task record(s) (> ${result.maxAgeDays}d); ${result.remainingTasks} remain`,
        );
        if (result.prunedTaskIds.length > 0) config.onTaskRecordsPruned?.(result);
      }
    } catch (err) {
      console.error('[maintenance-prune] task-record prune failed:', err);
    }
  }
  if (config.getPayloadDietStats) {
    try {
      console.log(formatPayloadDietLogLine(config.getPayloadDietStats()));
    } catch (err) {
      console.warn('[payload-diet] failed to compute stats line:', err);
    }
  }
}

export interface PersistenceSaveTickDeps {
  taskStore: TaskStore;
  queue: AttentionQueue;
  tasksFile: string;
  suppressionTracker?: SnoozeSuppressionTracker;
  detectionStatsStore?: { save(stats: DetectionStats): Promise<void> };
  persistenceHealth?: PersistenceHealthRecorder;
  taskStateSaveScheduler?: TaskStateSaveSchedulerLike;
  taskStateSaver?: typeof saveTasksWithSnapshotPolicy;
  getDetectionStatsSnapshot?: () => DetectionStats;
}

export interface TimerHandles {
  tokenScanInterval: ReturnType<typeof setInterval>;
  watchdogInterval: ReturnType<typeof setInterval>;
  livenessInterval: ReturnType<typeof setInterval>;
  snoozeExpiryInterval: ReturnType<typeof setInterval>;
  saveInterval: ReturnType<typeof setInterval>;
  quotaPollTimeout: ReturnType<typeof setTimeout> | null;
  /** Null unless a scheduled maintenance prune interval was configured. */
  maintenancePruneInterval: ReturnType<typeof setInterval> | null;
  /** Null unless the hourly prod smoke tick (issue #1593) was configured. */
  prodSmokeTickInterval: ReturnType<typeof setInterval> | null;
  /** Null unless the deploy-lag detector (issue #1594) was configured. */
  deployLagDetectorInterval: ReturnType<typeof setInterval> | null;
}

/**
 * Pure helper for the token-scan budget check (issue #98). Extracted so the
 * wire-up is testable without booting `startLifecycleTimers` and its real
 * intervals. Picks the first active session on the task, asks the BudgetChecker
 * whether to fire, and routes the resulting anomaly through the caller-supplied
 * enqueue callback. Returns true when an anomaly was enqueued, so the caller
 * can trigger a snapshot broadcast.
 *
 * Skips silently when the checker is absent, threshold is disabled, no active
 * session is available, or the checker returns null.
 */
export function runBudgetCheck(
  task: Task,
  costUsd: number,
  budgetChecker: BudgetChecker | undefined,
  enqueue: (agentId: string, anomaly: Anomaly) => void,
  projectConfigStore?: Pick<ProjectConfigStore, 'getConfig'>,
): boolean {
  if (!budgetChecker) return false;
  const thresholdUsd = task.projectId
    ? projectConfigStore?.getConfig(task.projectId)?.budgetWarnUsd ?? budgetChecker.getThresholdUsd()
    : budgetChecker.getThresholdUsd();
  if (thresholdUsd <= 0) return false;
  const activeSession = findFirstActiveSession(task);
  if (!activeSession) return false;
  const anomaly = budgetChecker.check(task.id, activeSession.tmuxSession, costUsd, undefined, thresholdUsd);
  if (!anomaly) return false;
  enqueue(activeSession.tmuxSession, anomaly);
  return true;
}

export function findFirstActiveSession(task: Task): SessionInfo | undefined {
  return task.sessions.find(
    (s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted',
  );
}

export function runProgressBudgetBurnDiagnosticSample(
  task: Task,
  usage: TokenUsage,
  diagnostics: Pick<ProgressBudgetBurnDiagnostics, 'sample'> | undefined,
  getAgentEvents: (agentId: string) => AgentEvent[],
): boolean {
  const activeSession = findFirstActiveSession(task);
  if (!activeSession || !diagnostics) return false;

  return diagnostics.sample({
    task,
    agentId: activeSession.tmuxSession,
    usage,
    events: getAgentEvents(activeSession.tmuxSession),
  }) !== null;
}

export interface AutoCloseStaleCompletionReadyDeps {
  taskStore: TaskStore;
  lifecycleDeps?: LifecycleDeps;
  /** Path to the shared audit.jsonl log. TTL escalations write a row here; immediate (opted-in) closes do not. */
  auditLogPath?: string;
  /** Optional broadcast for the TTL-escalation alert (issue #1526 Phase A) — reuses the existing 'alert' channel, no new notification surface. */
  broadcastToAll?: (msg: ServerMessage) => void;
  /**
   * Issue #1667: skip auto-closing tasks whose agent is provider-paused
   * (billing/quota). Optional — omit → no pause filtering (legacy tests).
   */
  isProviderPaused?: (task: Task) => boolean;
}

export interface AutoCloseStaleCompletionReadyResult {
  closedTaskIds: string[];
}

/**
 * Cap on how many completion-ready tasks this function will auto-close per
 * BATCH (issue #1526 Phase A). The incident this guards against: 11
 * simultaneous session teardowns each broadcast a multi-MB websocket
 * snapshot on an already-loaded server, which re-triggers the overload that
 * caused the original wedge. Draining oldest-first (entries are sorted by
 * signal age) across successive batches keeps teardown load flat.
 */
export const DEFAULT_MAX_AUTO_CLOSE_PER_TICK = 2;

/**
 * Minimum spacing between auto-close BATCHES (issue #1526 Phase A). This
 * function is invoked from the liveness tick, which runs every 5s in
 * production (`livenessIntervalMs`) — without this throttle, "max 2 per
 * tick" would still drain 11 tasks in ~30s (~22 multi-MB teardown broadcasts
 * in half a minute), on the exact server whose overload caused the incident.
 * With this throttle, 11 tasks drain over ~6 minutes (2 every 60s) instead —
 * comfortably inside the ≤2h drain bound while actually spreading the load.
 */
export const AUTO_CLOSE_SWEEP_MIN_INTERVAL_MS = 60_000;

/**
 * Mutable cross-tick state for the sweep throttle above. Callers that want
 * throttling create ONE of these per server instance (e.g. once in
 * `startLifecycleTimers`) and pass the SAME object on every tick; omitting it
 * disables throttling (only the per-batch cap applies) — used by tests that
 * don't care about batch spacing.
 */
export interface AutoCloseSweepThrottle {
  lastSweepAt: number;
}

export function createAutoCloseSweepThrottle(): AutoCloseSweepThrottle {
  return { lastSweepAt: 0 };
}

export async function autoCloseStaleCompletionReadyTasks(
  deps: AutoCloseStaleCompletionReadyDeps,
  opts: {
    now?: Date;
    thresholdMs?: number;
    ttlMs?: number;
    maxPerTick?: number;
    throttle?: AutoCloseSweepThrottle;
    minIntervalMs?: number;
  } = {},
): Promise<AutoCloseStaleCompletionReadyResult> {
  const closedTaskIds: string[] = [];
  const lifecycleDeps = deps.lifecycleDeps;
  if (!lifecycleDeps) return { closedTaskIds };

  const nowMs = (opts.now ?? new Date()).getTime();
  if (opts.throttle) {
    const minIntervalMs = opts.minIntervalMs ?? AUTO_CLOSE_SWEEP_MIN_INTERVAL_MS;
    if (nowMs - opts.throttle.lastSweepAt < minIntervalMs) return { closedTaskIds };
    opts.throttle.lastSweepAt = nowMs;
  }

  const entries = listStaleCompletionReadyTasks(deps.taskStore.listTasks(), {
    now: opts.now,
    thresholdMs: opts.thresholdMs ?? DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS,
    ...(deps.isProviderPaused ? { isProviderPaused: deps.isProviderPaused } : {}),
    ttlMs: opts.ttlMs,
  })
    .filter((entry) => entry.canAutoClose && !isActiveRalphLoop(entry.task))
    .slice(0, opts.maxPerTick ?? DEFAULT_MAX_AUTO_CLOSE_PER_TICK);

  for (const entry of entries) {
    const taskId = entry.task.id;
    try {
      // Headless completion bypasses the interactive dialog's dirty-worktree
      // verdict, so surface a finding first when the worktree holds
      // uncommitted work (issue #1580). Inspection runs before the transition,
      // while the task still owns the worktree, and never throws.
      await surfaceDirtyWorktreeOnHeadlessCompletion(entry.task, {
        taskStore: deps.taskStore,
        auditLogPath: deps.auditLogPath,
        broadcastToAll: deps.broadcastToAll,
      });
      await completeTask(taskId, lifecycleDeps);
      deps.taskStore.clearPendingSignal(taskId);
      closedTaskIds.push(taskId);
      if (entry.closeReason === 'ttl_escalation') {
        await recordTtlEscalation(entry, deps);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[completion-ready] auto-close failed for task ${taskId}: ${message}`);
      if (deps.taskStore.getTask(taskId)?.status === 'completed') {
        deps.taskStore.clearPendingSignal(taskId);
      }
    }
  }

  return { closedTaskIds };
}

/**
 * Audit + notify a TTL-escalated close (issue #1526 Phase A / FM5). This is
 * the ONLY branch that writes an audit row and broadcasts an alert — an
 * opted-in (`autoCloseOnSignal: true`) close keeps its prior silent behavior,
 * since the operator already asked for exactly that.
 */
async function recordTtlEscalation(
  entry: { task: Task; signal: NonNullable<Task['pendingSignal']>; ageMs: number },
  deps: AutoCloseStaleCompletionReadyDeps,
): Promise<void> {
  const { task, signal, ageMs } = entry;
  await appendAuditRow(deps.auditLogPath, {
    type: 'task.completionReadyTtlEscalation',
    timestamp: nowISO(),
    actor: 'system:completion-ready-ttl',
    taskId: task.id,
    signalRaisedAt: signal.raisedAt,
    ageMs,
  });
  deps.broadcastToAll?.({
    type: 'alert',
    agentId: task.sessions[task.sessions.length - 1]?.tmuxSession ?? '',
    summary: `Auto-closed after TTL: ${task.name ?? 'Task'}`,
    details: `completion_ready pending ${Math.round(ageMs / 60_000)}m with no manual review — closed automatically to free the slot.`,
    severity: 'info',
  });
}

function isActiveRalphLoop(task: Task): boolean {
  return task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused';
}

export interface ExpirePendingTasksDeps {
  taskStore: TaskStore;
  /** Optional lifecycle context — supplies queue purge, claim release, interaction log, and onTaskOutcome. */
  lifecycleDeps?: LifecycleDeps;
  /** Path to the shared audit.jsonl log — every expiry writes a `system:pending-ttl` row. */
  auditLogPath?: string;
  /** Optional broadcast for the sweep-summary alert — reuses the existing 'alert' channel. */
  broadcastToAll?: (msg: ServerMessage) => void;
}

export interface ExpirePendingTasksResult {
  expiredTaskIds: string[];
}

/**
 * Expire pending tasks past the TTL (issue #1526 Phase C / C3). Runs on the
 * liveness tick. Each expired task is cancelled through the existing
 * `pending → cancelled` transition — the same terminal status the promotion
 * loop's failure path uses — with:
 *
 * - an interaction-log `task_cancelled` row, reason `pending_ttl_expired`
 *   (structured reason; NOT `user_cancelled` — nobody clicked anything);
 * - an `audit.jsonl` row, actor `system:pending-ttl` (the convention Phase A's
 *   `system:completion-ready-ttl` / `system:hung-task-reaper` established);
 * - issue-claim release + attention-queue purge (a pending task holds no
 *   sessions, leases, or worktrees, so the full lifecycle cancel is not
 *   needed);
 * - `onTaskOutcome(id, { kind: 'cancelled' })` so chain supervisors observe
 *   the drop.
 *
 * One summary alert per sweep (not per task) keeps a full-queue expiry from
 * flooding the alert channel. No per-tick cap: expiring a pending task tears
 * down no session and broadcasts nothing per-task, so even a maximal sweep
 * (200 tasks) is cheap — unlike the completion-ready drain this deliberately
 * does not throttle.
 */
export async function expirePendingTasks(
  deps: ExpirePendingTasksDeps,
  opts: { now?: Date; ttlMs?: number } = {},
): Promise<ExpirePendingTasksResult> {
  const now = opts.now ?? new Date();
  const entries = listExpiredPendingTasks(deps.taskStore.listTasks(), {
    now,
    ttlMs: opts.ttlMs,
    hasFreshLaunchReservation: (id) => deps.taskStore.hasFreshLaunchReservation(id),
  });

  const expiredTaskIds: string[] = [];
  for (const { task, pendingForMs } of entries) {
    try {
      deps.taskStore.cancelTask(task.id);
    } catch (err) {
      // Raced a promoter or a user cancel — skip; the task is no longer
      // (only) pending, so it is somebody else's to finish.
      console.warn(
        `[pending-ttl] could not expire task ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    expiredTaskIds.push(task.id);
    console.warn(
      `[pending-ttl] expired pending task ${task.id} — queued ${Math.round(pendingForMs / 60_000)}m without launching`,
    );

    deps.lifecycleDeps?.queue?.purgeTask(task.id);
    deps.lifecycleDeps?.issueClaimRegistry?.safeReleaseAllFor(task.id, 'released');
    try {
      deps.lifecycleDeps?.onTaskOutcome?.(task.id, { kind: 'cancelled' });
    } catch (err) {
      console.warn('[pending-ttl] onTaskOutcome threw:', err);
    }

    await deps.lifecycleDeps?.interactionLog?.append({
      type: 'task_cancelled',
      taskId: task.id,
      agentId: '',
      reason: 'pending_ttl_expired',
      durationMs: pendingForMs,
      timestamp: nowISO(),
    });
    await appendAuditRow(deps.auditLogPath, {
      type: 'task.pendingTtlExpired',
      timestamp: nowISO(),
      actor: 'system:pending-ttl',
      taskId: task.id,
      pendingForMs,
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    });
  }

  if (expiredTaskIds.length > 0) {
    deps.broadcastToAll?.({
      type: 'alert',
      agentId: '',
      summary: `Expired ${expiredTaskIds.length} pending task(s) (TTL)`,
      details:
        'These tasks waited in the pending queue past pendingTaskTtlMinutes without ever launching ' +
        'and were cancelled to free queue depth. Relaunch any that are still wanted.',
      severity: 'warning',
    });
  }

  return { expiredTaskIds };
}

/**
 * Check one agent for hung-task reap eligibility and act if so (issue #1526
 * Phase A / FM6). Callers MUST only invoke this when the watchdog's tick for
 * `agentId` just returned `stale_agent` — see the wiring in
 * `startLifecycleTimers`'s watchdog interval for why that gate is what makes
 * needs_input/permission_blocked tasks safe from reaping regardless of how
 * long they have been waiting. Returns true when a task was reaped (caller
 * should broadcast a snapshot).
 */
export async function maybeReapHungTask(
  agentId: string,
  paneContent: string,
  deps: TimerDeps,
  taskStore: TaskStore,
  lifecycleDeps: LifecycleDeps,
  /** Injectable clock (issue #1526 Phase A review fix) — mirrors reapHungTask's own `now`, so tests can assert exact threshold boundaries instead of padding with a wall-clock buffer. Defaults to the real clock. */
  now: () => Date = () => new Date(),
): Promise<boolean> {
  if (!(deps.getHungTaskReapEnabled?.() ?? true)) return false;

  const task = taskStore.findTaskBySession(agentId);
  if (!task) return false;

  const state = deps.watchdog.getState(agentId);
  if (!state) return false;

  const nowDate = now();
  const thresholdMs = deps.getHungTaskReapMs?.();
  const liveness = {
    lastHookEventAt: state.lastEventAt,
    lastPaneChangeAt: state.lastPaneChangeAt,
    lastTokenActivityAt: state.lastTokenActivityAt,
  };
  const verdict = evaluateHungTaskReap(task, liveness, { now: nowDate.getTime(), thresholdMs });
  if (!verdict.eligible) return false;

  // Issue #1667: a billing/quota stall is not a hang — refuse to reap so the
  // delivery-owning child keeps its slot/identity until the pause clears or a
  // human acts. Pane text is load-bearing for the 74d1d038 shape (GH Actions
  // spending-limit annotations visible in the terminal without a stop_failure).
  // Tests often stub Monitor with a partial surface; treat missing
  // getAgentEvents as "no event evidence" and still scan pane text.
  const events =
    typeof deps.monitor.getAgentEvents === 'function'
      ? deps.monitor.getAgentEvents(agentId)
      : [];
  const pause = classifyProviderPause({ events, texts: [paneContent] });
  if (pause.paused) {
    console.warn(
      `[hung-task-reaper] skipping reap for task ${task.id} — provider_paused `
      + `(${pause.detail ?? 'billing/quota'}); holding slot for resume`,
    );
    return false;
  }

  console.warn(
    `[hung-task-reaper] reaping task ${task.id} — silent ${Math.round(verdict.silentForMs / 60_000)}m `
    + `(hook=${new Date(liveness.lastHookEventAt).toISOString()}, `
    + `pane=${new Date(liveness.lastPaneChangeAt).toISOString()}, `
    + `tokens=${new Date(liveness.lastTokenActivityAt).toISOString()})`,
  );

  await reapHungTask(
    task,
    {
      silentForMs: verdict.silentForMs,
      thresholdMs: thresholdMs ?? DEFAULT_HUNG_TASK_REAP_MS,
      ...liveness,
      paneContent,
    },
    {
      taskStore,
      lifecycleDeps,
      reportsDir: deps.reportsDir,
      auditLogPath: deps.auditLogPath,
      broadcastToAll: deps.broadcastToAll,
      resolveMergedPr: deps.resolveMergedPr,
      now,
    },
  );

  if (deps.agentLifecycleDeps) {
    await promotePendingTasks({
      taskStore,
      adapterRegistry: deps.adapterRegistry,
      lifecycleDeps: deps.agentLifecycleDeps,
      broadcastToAll: deps.broadcastToAll,
      serverCwd: deps.serverCwd,
      getMaxActiveTasks: deps.getMaxActiveTasks,
      bypassAllPermissions: deps.bypassAllPermissions,
    });
  }

  return true;
}

export function restoreExpiredSnoozes(queue: AttentionQueue, taskStore: TaskStore): boolean {
  const expired = queue.expireDue();
  if (expired.length === 0) return false;
  let changed = false;

  for (const entry of expired) {
    if (!entry.anomaly) {
      changed = true;
      continue;
    }

    if (entry.key === entry.agentId) {
      queue.enqueue(entry.agentId, entry.anomaly);
      changed = true;
      continue;
    }

    const task = taskStore.getTask(entry.key);
    if (!task || !isActiveStatus(task.status)) {
      changed = true;
      continue;
    }

    const liveSession = [...task.sessions].reverse().find(
      (session) => session.lastStatus !== 'completed'
        && session.lastStatus !== 'aborted'
        && !session.crashRecovered,
    );
    if (liveSession) {
      queue.enqueue(liveSession.tmuxSession, { ...entry.anomaly, agentId: liveSession.tmuxSession });
      changed = true;
    } else {
      queue.importSnoozed([{ ...entry, expiredPendingRestore: true }]);
    }
  }

  return changed;
}

export function startLifecycleTimers(deps: TimerDeps): TimerHandles {
  const {
    monitor, taskStore, queue, adapter, tokenTracker, watchdog,
    hookWatcher, terminalBackend, hooksDir, tasksFile, serverCwd,
    saveIntervalMs, livenessIntervalMs, broadcastToAll,
    shadowRegistry,
  } = deps;

  // issue #1526 Phase A: one throttle per server instance, shared across
  // every liveness tick's auto-close sweep. See AUTO_CLOSE_SWEEP_MIN_INTERVAL_MS.
  const autoCloseSweepThrottle = createAutoCloseSweepThrottle();

  // issue #1560: one tracker per server instance — the delivered-completion
  // budget clock (first-observed-merge per task) + batch throttle.
  const deliveredCompletionTracker: DeliveredCompletionTracker = createDeliveredCompletionTracker();

  // Permission resolution is detected through authoritative signals:
  // 1. Keystroke detection in the terminal bridge (immediate, for Kookr UI)
  // 2. PostToolUse hook events via the event pipeline (definitive proof)
  // 3. Watchdog hook file recovery (backup, every 5s)
  // No pane-snapshot polling needed — raw pane diffs produce false positives
  // (multi-frame rendering, cursor changes, scrolling output).

  // --- Periodic token usage scan ---
  //
  // Re-entrancy guard (issue #1620, change c — same pattern as the watchdog and
  // liveness ticks below): under load a scan can still be awaiting scanGrowth /
  // scanAll disk I/O when the next 5s interval fires. Without this guard,
  // overlapping ticks stack concurrent full-corpus reads on the same
  // transcripts, compounding the very allocation churn this issue bounds.
  let tokenScanTickRunning = false;
  const tokenScanInterval = setInterval(async () => {
    if (tokenScanTickRunning) return;
    tokenScanTickRunning = true;
    try {
      // Freshness probe: ask which transcripts grew on disk since the last
      // scanAll. Used to keep the watchdog from minting stale_agent during a
      // long streaming turn whose `usage` block hasn't finalized yet. Must run
      // BEFORE scanAll so the byte-delta hasn't been consumed yet.
      const growths = await tokenTracker.scanGrowth();
      for (const g of growths) {
        const task = taskStore.getTask(g.taskId);
        if (!task) continue;
        for (const session of task.sessions) {
          if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
            watchdog.recordTokenActivity(session.tmuxSession);
          }
        }
      }
      await tokenTracker.scanAll();
      let changed = false;
      for (const taskId of tokenTracker.getTrackedTaskIds()) {
        const usage = tokenTracker.getUsage(taskId);
        if (usage) {
          const task = taskStore.getTask(taskId);
          if (!task) continue;
          const prev = task.tokenUsage;
          if (!prev || prev.costUsd !== usage.costUsd || prev.inputTokens !== usage.inputTokens || prev.outputTokens !== usage.outputTokens) {
            taskStore.updateTokenUsage(taskId, usage);
            changed = true;
            // Notify watchdog that agent is actively consuming tokens
            for (const session of task.sessions) {
              if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
                watchdog.recordTokenActivity(session.tmuxSession);
              }
            }
          }

          // Budget threshold check (issue #98). Reactive — fires at most once per
          // severity level per task, routed through the same attention queue the
          // watchdog uses.
          if (runBudgetCheck(
            task,
            usage.costUsd,
            deps.budgetChecker,
            (aid, a) => queue.enqueue(aid, a),
            deps.projectConfigStore,
          )) {
            changed = true;
          }

          runProgressBudgetBurnDiagnosticSample(
            task,
            usage,
            deps.progressBudgetBurnDiagnostics,
            (agentId) => monitor.getAgentEvents(agentId),
          );
        }
      }
      if (changed) {
        broadcastToAll(createSnapshotMessage({
          monitor,
          serverCwd,
          activityMetaProvider: deps.activityMetaProvider,
          relationTaskStore: taskStore,
          userInputDeliveryProvider: deps.userInputDeliveries,
        }));
      }
    } catch (err) {
      console.error('Error scanning token usage:', err);
    } finally {
      tokenScanTickRunning = false;
    }
  }, 5_000);

  // --- Periodic watchdog tick ---
  //
  // Hook-file recovery: ask the HookFileWatcher to drain any new lines since
  // its last offset. Recovered events flow through the normal adapter.onEvent
  // pipeline (monitor.processEvents + watchdog.recordEvents), which is the
  // same path the fs.watch listener uses. One reader, one offset map — the
  // watchdog tick is a trigger, not a parser.
  //
  // Re-entrancy guard (issue #1526 Phase A review fix): on a loaded server a
  // tick can still be mid-flight (awaiting adapter.captureDisplay,
  // hookWatcher.drainNow, or a hung-task reap's session teardown) when the
  // next 5s interval fires. Without this guard, overlapping ticks produce
  // duplicate hung-task reap report files and InvalidTransition log spam
  // (two ticks both trying to terminate/complete the same task).
  let watchdogTickRunning = false;
  const watchdogInterval = setInterval(async () => {
    if (watchdogTickRunning) return;
    watchdogTickRunning = true;
    try {
      const agents = watchdog.getTrackedAgents();
      let changed = false;

      for (const agentId of agents) {
        try {
          // Capture pane output
          let paneContent = '';
          let paneCaptureSucceeded = true;
          try {
            paneContent = await adapter.captureDisplay(agentId);
          } catch {
            // Session might be dead — liveness check will handle it
            paneCaptureSucceeded = false;
          }

          // Backup read path: hook-watcher already tails the file via fs.watch
          // and a 3s backup poll, but the watchdog tick forces a drain here so
          // stuck-detection never waits on a dropped fs.watch event. The drain
          // updates the single offset map and dispatches any recovered lines
          // through adapter.onEvent — no parallel parsing, no parallel offset.
          try {
            await hookWatcher.drainNow(agentId);
          } catch {
            // Drain failures are non-critical — next tick retries.
          }

          // Hook events have already propagated into watchdog via recordEvents
          // in the event-pipeline; the tick only evaluates state now.
          const verdict = watchdog.tick(agentId, paneContent, []);

          // Monitor is the single owner of the Anomaly union. Hand the verdict
          // to it and let Monitor decide whether to enqueue, suppress, or clear —
          // this replaces the former in-place reconciliation between Monitor
          // and Watchdog that lived in this file (issue #367 sub-goal 3).
          const watchdogActionable = verdict.status === 'needs_input'
            || verdict.status === 'permission_blocked'
            || verdict.status === 'stale_agent'
            || verdict.status === 'hook_disconnected';

          if (monitor.applyWatchdogVerdict(agentId, verdict, { paneCaptureSucceeded, paneText: paneContent })) {
            changed = true;
          }

          if (
            !watchdogActionable
            && monitor.sampleFindingEvidence(agentId, paneCaptureSucceeded ? paneContent : undefined)
          ) {
            changed = true;
          }

          // Run shadow strategies (fire-and-forget, never affects real detection)
          if (shadowRegistry) {
            const realAnomaly = monitor.getCurrentAnomaly(agentId);
            shadowRegistry.evaluate(agentId, { paneText: paneContent, realAnomaly });
          }

          // Hung-task reaper (issue #1526 Phase A / FM6). Gated on the SAME
          // `stale_agent` verdict just computed above.
          //
          // What `stale_agent` actually guarantees: no recent hook event
          // (`timeSinceLastEvent >= staleThresholdMs`, 30s default), not
          // waiting on input/permission, and not in the MCP-startup/grace
          // window. It does NOT guarantee "no tool in progress" — watchdog.tick
          // also returns `stale_agent` for a tool that's been unmatched
          // (PreToolUse with no PostToolUse) for >= maxToolExecutionTimeMs
          // (10 min default); that override exists specifically so a hung tool
          // call doesn't hide behind indefinite `tool_running` suppression.
          // This is the exact shape of the incident's hung task (20e2ddbd: last
          // event a PreToolUse, pane frozen mid-`write`, silent for 33h) — a
          // tool that's been silent past the reap threshold (hours, not
          // minutes) is correctly treated as hung either way.
          //
          // What protects a genuinely-recent tool call: `evaluateHungTaskReap`
          // checks `lastHookEventAt` (below) against its OWN, much larger
          // threshold, independent of the watchdog's 10-minute override. A
          // PreToolUse an hour ago, with a 3h reap threshold, keeps the hook
          // channel "live" and blocks the reap — regardless of what
          // `verdict.status` says at this instant.
          //
          // Reusing `stale_agent` here means a task genuinely waiting on the
          // user or a permission prompt is excluded for free: those verdicts
          // (`needs_input`, `permission_blocked`, …) never reach this branch.
          if (verdict.status === 'stale_agent' && (deps.getHungTaskReapEnabled?.() ?? true)) {
            if (await maybeReapHungTask(agentId, paneContent, deps, taskStore, lifecycleDeps)) {
              changed = true;
            }
          }
        } catch (err) {
          console.error(`Watchdog error for ${agentId}:`, err);
        }
      }

      try {
        if (await deps.userInputDeliveries?.sweepUnsubmittedDeliveries()) {
          changed = true;
        }
      } catch (err) {
        console.error('Error sweeping unsubmitted user-input deliveries:', err);
      }

      if (changed) {
        broadcastToAll(createSnapshotMessage({
          monitor,
          serverCwd,
          activityMetaProvider: deps.activityMetaProvider,
          relationTaskStore: taskStore,
          userInputDeliveryProvider: deps.userInputDeliveries,
        }));
      }
    } finally {
      watchdogTickRunning = false;
    }
  }, 5_000);

  // --- Periodic liveness check ---
  const lifecycleDeps: LifecycleDeps = {
    adapter, monitor, taskStore, hookWatcher, watchdog, shadowRegistry, tokenTracker,
    queue,
    suppressionTracker: deps.suppressionTracker,
    ...(deps.agentLifecycleDeps?.issueClaimRegistry
      ? { issueClaimRegistry: deps.agentLifecycleDeps.issueClaimRegistry }
      : {}),
    ...(deps.agentLifecycleDeps?.onTaskOutcome
      ? { onTaskOutcome: deps.agentLifecycleDeps.onTaskOutcome }
      : {}),
    ...(deps.agentLifecycleDeps?.getCleanupWorktreeOnComplete
      ? { getCleanupWorktreeOnComplete: deps.agentLifecycleDeps.getCleanupWorktreeOnComplete }
      : {}),
    ...(deps.taskTailStore ? { taskTailStore: deps.taskTailStore } : {}),
  };

  // Re-entrancy guard (issue #1526 Phase A review fix) — same rationale as
  // the watchdog interval above: reconcile()/the completion-ready sweep/a
  // hung-task reap can all still be mid-flight when the next tick fires.
  let livenessTickRunning = false;
  const livenessInterval = setInterval(async () => {
    if (livenessTickRunning) return;
    livenessTickRunning = true;
    try {
      if (
        deps.worktreeRegistry
        && deps.worktreeRegistryRepoPath
        && (deps.getDashboardClientCount?.() ?? 0) > 0
      ) {
        await deps.worktreeRegistry.refresh(deps.worktreeRegistryRepoPath);
      }
      const result = await reconcile(taskStore, terminalBackend, deps.worktreeRegistry);
      // Issue #1667: shared provider-pause check for auto-close + delivered
      // sweeps. Reads recent agent events for the task's live session.
      const isTaskProviderPaused = (task: Task): boolean => {
        const agentId = task.sessions[task.sessions.length - 1]?.tmuxSession;
        if (!agentId) return false;
        const events = monitor.getAgentEvents(agentId);
        const anomaly = queue.peek(agentId);
        return isProviderPaused({
          events,
          anomalyType: anomaly?.type ?? null,
          anomalyExplanation: anomaly?.explanation ?? null,
        });
      };

      const autoCloseResult = await autoCloseStaleCompletionReadyTasks(
        {
          taskStore,
          lifecycleDeps,
          auditLogPath: deps.auditLogPath,
          broadcastToAll: deps.broadcastToAll,
          isProviderPaused: isTaskProviderPaused,
        },
        {
          thresholdMs: deps.getAutoCloseCompletionReadyDelayMs?.(),
          ttlMs: deps.getCompletionReadyTtlMs?.(),
          throttle: autoCloseSweepThrottle,
        },
      );

      // Delivery-aware self-completion (issue #1560): a running task whose PR
      // merged but which never raised a completion signal self-completes once
      // its post-merge cleanup budget is exceeded. Raises through the #1541
      // outbox / autoCloseOnSignal path; the hung-task reaper stays the
      // backstop. Skipped when no merge-attribution resolver is wired.
      // Issue #1667: never auto-complete while provider-paused.
      const deliveredResult = deps.resolveMergedPr
        ? await autoCompleteDeliveredTasks(
          {
            taskStore,
            lifecycleDeps,
            resolveMergedPr: deps.resolveMergedPr,
            isProviderPaused: isTaskProviderPaused,
            tracker: deliveredCompletionTracker,
            ...(deps.signalOutboxSpoolDir ? { signalOutboxSpoolDir: deps.signalOutboxSpoolDir } : {}),
            ...(deps.agentLifecycleDeps?.onTaskOutcome
              ? { onTaskOutcome: deps.agentLifecycleDeps.onTaskOutcome }
              : {}),
            auditLogPath: deps.auditLogPath,
            broadcastToAll: deps.broadcastToAll,
          },
          {
            budgetMs: deps.getPostMergeCleanupBudgetMs?.(),
            throttle: true,
          },
        )
        : { completedTaskIds: [] };

      // Pending-task TTL sweep (issue #1526 Phase C / C3): expire tasks that
      // have starved in the queue past the TTL, freeing depth for the 429
      // depth limit. interactionLog rides in from agentLifecycleDeps — the
      // tick's own lifecycleDeps deliberately omits it for session paths.
      const pendingTtlResult = await expirePendingTasks(
        {
          taskStore,
          lifecycleDeps: {
            ...lifecycleDeps,
            ...(deps.agentLifecycleDeps?.interactionLog
              ? { interactionLog: deps.agentLifecycleDeps.interactionLog }
              : {}),
          },
          auditLogPath: deps.auditLogPath,
          broadcastToAll: deps.broadcastToAll,
        },
        { ttlMs: deps.getPendingTaskTtlMs?.() },
      );

      // Release issue-ownership claims for reconcile-driven terminal
      // transitions. reconcile() calls the RAW TaskStore methods, bypassing
      // the agent-lifecycle wrappers, so this additive call is where claims
      // free up on the dead-session path (RFC rfc-issue-ownership-lock R9;
      // safeReleaseAllFor never throws, R9b).
      const claimRegistry = deps.agentLifecycleDeps?.issueClaimRegistry;
      if (claimRegistry) {
        let claimsReleased = 0;
        for (const id of result.tasksCompleted) {
          claimsReleased += claimRegistry.safeReleaseAllFor(id, 'released').length;
        }
        for (const id of result.tasksTerminated) {
          claimsReleased += claimRegistry.safeReleaseAllFor(id, 'dead_reclaim').length;
        }
        if (claimsReleased > 0) {
          console.log(`[issue-claims] reconcile released ${claimsReleased} claim(s)`);
        }
      }
      const onTaskOutcome = deps.agentLifecycleDeps?.onTaskOutcome;
      if (onTaskOutcome) {
        for (const id of result.tasksCompleted) {
          try {
            onTaskOutcome(id, { kind: 'completed' });
          } catch (err) {
            console.warn('[liveness] onTaskOutcome threw:', err);
          }
        }
        for (const id of result.tasksTerminated) {
          try {
            onTaskOutcome(id, { kind: 'failed' });
          } catch (err) {
            console.warn('[liveness] onTaskOutcome threw:', err);
          }
        }
      }

      // Clean up resources for dead sessions via centralized lifecycle
      for (const tmuxName of result.markedCompleted) {
        await cleanupSessionResources(tmuxName, lifecycleDeps);
      }

      if (
        result.markedCompleted.length > 0
        || result.tasksCompleted.length > 0
        || result.tasksTerminated.length > 0
        || result.worktreesMissing.length > 0
        || result.worktreesStale.length > 0
        || result.worktreesChanged.length > 0
        || autoCloseResult.closedTaskIds.length > 0
        || deliveredResult.completedTaskIds.length > 0
        || pendingTtlResult.expiredTaskIds.length > 0
      ) {
        // Promote pending tasks when slots open from auto-transitioned sessions
        // (completed via backfill, or terminated via the new dead-session path).
        if (deps.agentLifecycleDeps) {
          await promotePendingTasks({
            taskStore,
            adapterRegistry: deps.adapterRegistry,
            lifecycleDeps: deps.agentLifecycleDeps,
            broadcastToAll, serverCwd,
            getMaxActiveTasks: deps.getMaxActiveTasks,
            bypassAllPermissions: deps.bypassAllPermissions,
          });
        }
        broadcastToAll(createSnapshotMessage({
          monitor,
          serverCwd,
          activityMetaProvider: deps.activityMetaProvider,
          relationTaskStore: taskStore,
          userInputDeliveryProvider: deps.userInputDeliveries,
        }));
      }
    } catch (err) {
      console.error('Error during liveness check:', err);
    } finally {
      livenessTickRunning = false;
    }
  }, livenessIntervalMs);

  const snoozeExpiryInterval = setInterval(() => {
    try {
      if (restoreExpiredSnoozes(queue, taskStore)) {
        broadcastToAll(createSnapshotMessage({
          monitor,
          serverCwd,
          activityMetaProvider: deps.activityMetaProvider,
          relationTaskStore: taskStore,
          userInputDeliveryProvider: deps.userInputDeliveries,
        }));
      }
    } catch (err) {
      console.error('Error expiring snoozes:', err);
    }
  }, 1_000);

  // --- Periodic task persistence ---
  // Uses saveTasksWithSnapshotPolicy with 'daily' so the first successful
  // save of each local day copies tasks.json to tasks.json.daily.YYYYMMDD.
  // Snapshot failures are logged inside the helper and never block the save.
  const saveInterval = setInterval(async () => {
    await runPersistenceSaveTick(deps);
  }, saveIntervalMs);

  // --- Periodic quota usage polling (optional) ---
  // Uses setTimeout chain (not setInterval) so each tick respects the adapter's
  // current interval, which changes dynamically during backoff and recovery.
  let quotaPollTimeout: ReturnType<typeof setTimeout> | null = null;
  if (deps.quotaAdapter) {
    const quotaAdapter = deps.quotaAdapter;

    async function pollQuota(): Promise<void> {
      try {
        const changed = await quotaAdapter.poll();
        if (changed) {
          const quota = quotaAdapter.getLatest();
          if (quota) broadcastToAll({ type: 'quotaStatus', quota });
        }
      } catch {
        // non-critical
      }
      // Schedule next poll using the adapter's (possibly updated) interval
      quotaPollTimeout = setTimeout(pollQuota, quotaAdapter.getCurrentIntervalMs());
    }

    // Fire immediately on startup
    void pollQuota();
  }

  // --- Scheduled data-directory maintenance prune (optional, off by default) ---
  // Opt-in via KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS. Deliberately does NOT run
  // at boot (avoids a startup I/O spike); the first sweep fires one interval in.
  // Each sweep is fully wrapped in runScheduledMaintenancePrune so a failure is
  // logged and never crashes the server.
  let maintenancePruneInterval: ReturnType<typeof setInterval> | null = null;
  const maintenancePrune = deps.maintenancePrune;
  if (maintenancePrune && maintenancePrune.intervalHours > 0) {
    const intervalMs = maintenancePrune.intervalHours * 60 * 60 * 1000;
    console.log(
      `[maintenance-prune] scheduled sweep enabled every ${maintenancePrune.intervalHours}h ` +
        `(dir=${maintenancePrune.dataDir})`,
    );
    maintenancePruneInterval = setInterval(() => {
      void runScheduledMaintenancePrune(maintenancePrune);
    }, intervalMs);
  }

  // --- Hourly prod smoke tick (issue #1593), optional ---
  // A cheap in-process liveness check: runs the same bounded smoke suite the
  // deploy gate uses against the live instance, on the tick's own cadence, and
  // files/updates an operational alert artifact on failure. No agent spawn.
  // maybeRun() guards pile-up and never throws, so the interval callback is a
  // one-liner. Undefined unless bootstrap enabled it (default: prod port 4800).
  let prodSmokeTickInterval: ReturnType<typeof setInterval> | null = null;
  const prodSmokeTick = deps.prodSmokeTick;
  if (prodSmokeTick) {
    const intervalMs = prodSmokeTick.hostIntervalMs;
    console.log(
      `[prod-smoke-tick] hourly liveness tick enabled (every ${Math.round(intervalMs / 60_000)}m; ` +
        `artifact=${prodSmokeTick.alertArtifactPath})`,
    );
    prodSmokeTickInterval = setInterval(() => {
      void prodSmokeTick.maybeRun();
    }, intervalMs);
  }

  // --- Deploy-lag detector (issue #1594), optional ---
  // Compares each monitored prod's running SHA against origin/main on its own
  // cadence and files/updates one operational-alert artifact when merged
  // commits sit undeployed past the threshold. Read-only: it never triggers a
  // deploy. maybeRun() guards pile-up and never throws, so the interval callback
  // is a one-liner. Undefined unless bootstrap enabled it (default: prod 4800).
  let deployLagDetectorInterval: ReturnType<typeof setInterval> | null = null;
  const deployLagDetector = deps.deployLagDetector;
  if (deployLagDetector) {
    const intervalMs = deployLagDetector.hostIntervalMs;
    console.log(
      `[deploy-lag] detector enabled (every ${Math.round(intervalMs / 60_000)}m; ` +
        `artifact=${deployLagDetector.alertArtifactPath})`,
    );
    deployLagDetectorInterval = setInterval(() => {
      void deployLagDetector.maybeRun();
    }, intervalMs);
  }

  return {
    tokenScanInterval,
    watchdogInterval,
    livenessInterval,
    snoozeExpiryInterval,
    saveInterval,
    quotaPollTimeout,
    maintenancePruneInterval,
    prodSmokeTickInterval,
    deployLagDetectorInterval,
  };
}

export async function runPersistenceSaveTick(deps: PersistenceSaveTickDeps): Promise<void> {
  try {
    if (deps.taskStateSaveScheduler) {
      await deps.taskStateSaveScheduler.flush('periodic', { force: true, policy: 'daily' });
    } else {
      const snoozes = serializeSnoozed(deps.queue, deps.taskStore);
      const suppressionState = deps.suppressionTracker?.export();
      const taskStateSaver = deps.taskStateSaver ?? saveTasksWithSnapshotPolicy;
      await taskStateSaver(
        deps.taskStore.getAllTasks(),
        deps.tasksFile,
        'daily',
        deps.taskStore.getLifetimeSpendUsd(),
        snoozes,
        suppressionState,
        deps.taskStore.listRelations(),
      );
      deps.persistenceHealth?.recordSuccess('task_state');
    }
  } catch (err) {
    if (!deps.taskStateSaveScheduler) deps.persistenceHealth?.recordFailure('task_state', err);
    console.error('Error saving tasks:', err);
  }
  // Persist cumulative detector telemetry on the same cadence so FP/FN/
  // suppression rates survive restarts. Isolated from the task save so a
  // stats-write failure neither blocks nor is mislabelled as a task error.
  if (!deps.detectionStatsStore) return;
  try {
    await deps.detectionStatsStore.save((deps.getDetectionStatsSnapshot ?? getDetectionStats)());
    deps.persistenceHealth?.recordSuccess('detection_stats');
  } catch (err) {
    deps.persistenceHealth?.recordFailure('detection_stats', err);
    console.error('Error saving detection stats:', err);
  }
}

export function clearAllTimers(handles: TimerHandles): void {
  clearInterval(handles.watchdogInterval);
  clearInterval(handles.tokenScanInterval);
  clearInterval(handles.livenessInterval);
  clearInterval(handles.snoozeExpiryInterval);
  clearInterval(handles.saveInterval);
  if (handles.quotaPollTimeout) clearTimeout(handles.quotaPollTimeout);
  if (handles.maintenancePruneInterval) clearInterval(handles.maintenancePruneInterval);
  if (handles.prodSmokeTickInterval) clearInterval(handles.prodSmokeTickInterval);
  if (handles.deployLagDetectorInterval) clearInterval(handles.deployLagDetectorInterval);
}
