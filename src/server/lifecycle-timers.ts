/**
 * Lifecycle timer scheduler (issue #1822).
 *
 * This module's job is to *register and clear* the server's periodic timers and
 * to drive the inline token-scan / watchdog / liveness ticks. The body of each
 * domain job it schedules lives next to that domain's owner and is imported here
 * as a single callback:
 *
 * - completion-ready auto-close → {@link ./completion-ready-sweep.js}
 * - pending-task TTL expiry     → {@link ./pending-ttl-sweep.js}
 * - snooze-expiry restore       → {@link ./snooze-restore.js}
 * - periodic persistence save   → {@link ./persistence-save-tick.js}
 * - maintenance / relay-orphan  → {@link ./maintenance-prune-schedule.js}
 *
 * New periodic behaviour belongs in the relevant domain module, wired in here
 * as one more scheduled callback — not implemented inline.
 */
import type { Monitor } from '../core/monitor.js';
import type { Task, TaskStore } from '../core/tasks.js';
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
import { cleanupReconciledTaskWorktrees } from '../adapters/git-worktree.js';
import type { saveTasksWithSnapshotPolicy } from '../core/task-persistence.js';
import { cleanupSessionResources, promotePendingTasks, type LifecycleDeps, type AgentLifecycleDeps } from './agent-lifecycle.js';
import { createSnapshotMessage } from './use-cases/get-snapshot.js';
import type { DetectionStats } from '../core/detection-stats.js';
import type { UserInputDeliverySnapshot } from '../shared/contracts/user-input-delivery.js';
import type { PersistenceHealthRecorder } from '../core/persistence-health.js';
import type { TimerHealthRecorder } from '../core/timer-health.js';
import type { TaskStateSaveSchedulerLike } from './task-state-save-scheduler.js';
import { DEFAULT_HUNG_TASK_REAP_MS, evaluateHungTaskReap } from '../core/hung-task-reaper.js';
import { reapHungTask } from './hung-task-reaper.js';
import type { ProdSmokeTick } from './prod-smoke-tick.js';
import type { DeployLagDetector } from './deploy-lag-detector.js';
import {
  autoCompleteDeliveredTasks,
  createDeliveredCompletionTracker,
  type DeliveredCompletionTracker,
} from './delivered-task-completion-sweep.js';
import type { MergedPrAttribution } from '../core/completion/index.js';
import { classifyProviderPause, isProviderPaused } from '../core/provider-pause.js';
// Domain job bodies extracted from this scheduler (issue #1822). Each lives
// next to its domain owner; this module only registers/clears the timers that
// drive them.
import {
  autoCloseStaleCompletionReadyTasks,
  createAutoCloseSweepThrottle,
} from './completion-ready-sweep.js';
import { expirePendingTasks } from './pending-ttl-sweep.js';
import {
  reclaimAgedFinishedAwaitingAckTasks,
  type FinishedAwaitingAckTtlReclaimMetrics,
} from './finished-awaiting-ack-ttl-sweep.js';
import { restoreExpiredSnoozes } from './snooze-restore.js';
import { runPersistenceSaveTick } from './persistence-save-tick.js';
import {
  runScheduledMaintenancePrune,
  runScheduledRelayOrphanSweep,
  type MaintenancePruneScheduleConfig,
  type RelayOrphanSweepScheduleConfig,
} from './maintenance-prune-schedule.js';
import {
  runScheduledReflectWorktreeSweep,
  type ReflectWorktreeSweepScheduleConfig,
} from './use-cases/request-task-reflect.js';

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
   * Bounded auto-retry hook for schedule-provenance `provider_transient` silent
   * failures (issue #1712). Threaded onto the auto-close path's LifecycleDeps so
   * a scheduled task the sweep would complete — that is actually a zero-tool-call
   * 529 — reclassifies and retries instead of masking the failure as `completed`.
   */
  providerTransientRetry?: LifecycleDeps['providerTransientRetry'];
  /** Operator-alert hook fired when a `provider_transient` failure exhausts its retry budget (issue #1712). */
  providerTransientAlert?: LifecycleDeps['providerTransientAlert'];
  /** Path to the disposition-ledger JSONL (issue #1540) — threaded to the hung-task reaper so every reap-driven cancel records a work-conservation disposition. Absent → reaper disposition writes are skipped. */
  dispositionLedgerPath?: string;
  /**
   * Live getter for the pending-task TTL, in milliseconds (issue #1526
   * Phase C / C3, `pendingTaskTtlMinutes` setting). Read on every liveness
   * tick. Falls back to the module default when absent (older wiring/tests).
   */
  getPendingTaskTtlMs?: () => number;
  /**
   * Live getter for the finishedAwaitingAck TTL, in milliseconds (issue
   * #1884, `finishedAwaitingAckTtlMinutes` setting). Read on every liveness
   * tick. Falls back to the module default (15m) when absent.
   */
  getFinishedAwaitingAckTtlMs?: () => number;
  /**
   * Stranded-PR / `merge_required` exemption predicate for the
   * finishedAwaitingAck TTL reclaim (issue #1884), backed by
   * `GitHubStateStore`. Absent ⇒ every candidate is treated as a possible PR
   * hold and never reclaimed (fail-safe default — see
   * `core/finished-awaiting-ack-ttl.ts`).
   */
  isTaskHoldingOpenPr?: (task: Task) => boolean | undefined;
  /** Optional counter for the finishedAwaitingAck TTL reclaim, exposed via `/metrics` (issue #1884). */
  finishedAwaitingAckTtlReclaimMetrics?: Pick<FinishedAwaitingAckTtlReclaimMetrics, 'recordReclaimed'>;
  /** Kookr data-dir "reports" directory. Hung-task reap writes a markdown evidence report here. */
  reportsDir?: string;
  /** Live getter — hung-task reaper enabled flag (issue #1526 Phase A). Defaults to enabled when absent. */
  getHungTaskReapEnabled?: () => boolean;
  /** Live getter — hung-task reap silence threshold, in milliseconds. */
  getHungTaskReapMs?: () => number;
  /**
   * Orphan/terminal-task session reaper (issue #1720). Run on every liveness
   * tick, after `reconcile()` — reaps true orphan sessions and sessions whose
   * owning task already reached a terminal status but whose process tree is
   * still resident. Absent only in tests that don't care about this sweep.
   */
  sessionReaper?: Pick<import('./session-reaper.js').SessionReaperService, 'runSweep'>;
  /** Optional suppression tracker for snooze storm auto-suppress. */
  suppressionTracker?: SnoozeSuppressionTracker;
  /** Optional durable store for cumulative detector telemetry (persisted on the save tick). */
  detectionStatsStore?: { save(stats: DetectionStats): Promise<void> };
  /** In-memory tracker for runtime persistence failures. */
  persistenceHealth?: PersistenceHealthRecorder;
  /**
   * Optional per-loop last-fired stamps for GET /api/diagnostics/timer-health
   * (issue #1771). Absent in tests that do not care about timer health.
   */
  timerHealth?: TimerHealthRecorder;
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
  /**
   * Optional relay-orphan sweep (issue #1723). When `intervalHours > 0`
   * (resolved from `KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS`, default off), a
   * dedicated interval reaps leaked `relay/server.ts` processes whose task
   * worktree no longer exists — the backstop for the die-with-parent watchdog.
   * Production-safe: a live relay's cwd always exists, so it is never selected.
   * Every sweep is wrapped so an error is logged and never crashes the server.
   */
  relayOrphanSweep?: RelayOrphanSweepScheduleConfig;
  /**
   * Optional reflect-worktree orphan sweep (issue #1860). When `intervalHours > 0`
   * (resolved from `KOOKR_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS`, default 1h), a
   * dedicated interval reaps ephemeral reflect worktrees whose source task is
   * gone — the periodic backstop for the startup-only sweep. Worktrees whose
   * source task still has a live reflect task are never reclaimed. Every sweep
   * is wrapped so an error is logged and never crashes the server.
   */
  reflectWorktreeSweep?: ReflectWorktreeSweepScheduleConfig;
  /**
   * Optional event-loop pressure gate for non-critical intervals (issue #1785).
   * When elevated, maintenance prune / relay-orphan / reflect-worktree /
   * prod-smoke / deploy-lag ticks skip their body. Critical loops (token scan,
   * watchdog, liveness, save, snooze, quota) are never gated. Fail-open when omitted.
   */
  nonCriticalTickPause?: {
    shouldSkipTick(): boolean;
    recordPause(timerName: string): void;
  };
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
  /** Null unless the relay-orphan sweep (issue #1723) was configured. */
  relayOrphanSweepInterval: ReturnType<typeof setInterval> | null;
  /** Null unless the reflect-worktree orphan sweep (issue #1860) was configured. */
  reflectWorktreeSweepInterval: ReturnType<typeof setInterval> | null;
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
      dispositionLedgerPath: deps.dispositionLedgerPath,
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


/** Fixed cadence for the token-usage scan tick (issue #1771 timer-health). */
export const TOKEN_SCAN_INTERVAL_MS = 5_000;
/** Fixed cadence for the watchdog tick (issue #1771 timer-health). */
export const WATCHDOG_INTERVAL_MS = 5_000;
/** Fixed cadence for snooze-expiry restore (issue #1771 timer-health). */
export const SNOOZE_EXPIRY_INTERVAL_MS = 1_000;

/**
 * Helper for issue #1785: if the optional non-critical pause gate is elevated,
 * record a pause metric and return true so the interval body is skipped.
 * Fail-open when the gate is not wired.
 */
export function shouldSkipNonCriticalLifecycleTick(
  gate: TimerDeps['nonCriticalTickPause'] | undefined,
  timerName: string,
): boolean {
  if (!gate?.shouldSkipTick()) return false;
  gate.recordPause(timerName);
  return true;
}

export function startLifecycleTimers(deps: TimerDeps): TimerHandles {
  const {
    monitor, taskStore, queue, adapter, tokenTracker, watchdog,
    hookWatcher, terminalBackend, hooksDir, tasksFile, serverCwd,
    saveIntervalMs, livenessIntervalMs, broadcastToAll,
    shadowRegistry,
    timerHealth,
    nonCriticalTickPause,
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
  timerHealth?.register('tokenScan', TOKEN_SCAN_INTERVAL_MS);
  let tokenScanTickRunning = false;
  const tokenScanInterval = setInterval(async () => {
    if (tokenScanTickRunning) return;
    tokenScanTickRunning = true;
    timerHealth?.recordFire('tokenScan', TOKEN_SCAN_INTERVAL_MS);
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
  }, TOKEN_SCAN_INTERVAL_MS);

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
  timerHealth?.register('watchdog', WATCHDOG_INTERVAL_MS);
  let watchdogTickRunning = false;
  const watchdogInterval = setInterval(async () => {
    if (watchdogTickRunning) return;
    watchdogTickRunning = true;
    timerHealth?.recordFire('watchdog', WATCHDOG_INTERVAL_MS);
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
    // Silent-failure integrity guard wiring (issue #1712): the auto-close sweep
    // completes via agent-lifecycle.completeTask, so it must carry the audit
    // path + retry/alert hooks for the reclassification guard to fire.
    ...(deps.auditLogPath ? { auditLogPath: deps.auditLogPath } : {}),
    ...(deps.providerTransientRetry ? { providerTransientRetry: deps.providerTransientRetry } : {}),
    ...(deps.providerTransientAlert ? { providerTransientAlert: deps.providerTransientAlert } : {}),
  };

  // Re-entrancy guard (issue #1526 Phase A review fix) — same rationale as
  // the watchdog interval above: reconcile()/the completion-ready sweep/a
  // hung-task reap can all still be mid-flight when the next tick fires.
  timerHealth?.register('liveness', livenessIntervalMs);
  let livenessTickRunning = false;
  const livenessInterval = setInterval(async () => {
    if (livenessTickRunning) return;
    livenessTickRunning = true;
    timerHealth?.recordFire('liveness', livenessIntervalMs);
    try {
      if (
        deps.worktreeRegistry
        && deps.worktreeRegistryRepoPath
        && (deps.getDashboardClientCount?.() ?? 0) > 0
      ) {
        await deps.worktreeRegistry.refresh(deps.worktreeRegistryRepoPath);
      }
      const result = await reconcile(taskStore, terminalBackend, deps.worktreeRegistry);
      // Orphan/terminal-task session reaper (issue #1720) — runs after every
      // reconcile so a session whose owning task JUST reached a terminal
      // status (or that reconcile just re-confirmed is unowned) is swept
      // promptly rather than waiting for the next boot. Never blocks the
      // liveness tick on failure.
      try {
        await deps.sessionReaper?.runSweep();
      } catch (err) {
        console.warn('[session-reaper] periodic sweep failed:', err instanceof Error ? err.message : err);
      }
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

      // finishedAwaitingAck TTL reclaim (issue #1884): force-complete tasks
      // that finished their work and raised completion_ready but sat
      // unacknowledged past the TTL, chronically holding an active
      // concurrency slot. The stranded-PR exemption (isTaskHoldingOpenPr)
      // keeps a merge_required delivery from ever being clobbered.
      const finishedAwaitingAckTtlResult = await reclaimAgedFinishedAwaitingAckTasks(
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
          isHoldingOpenPr: deps.isTaskHoldingOpenPr,
          metrics: deps.finishedAwaitingAckTtlReclaimMetrics,
        },
        { ttlMs: deps.getFinishedAwaitingAckTtlMs?.() },
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

      // Reap worktrees for reconcile-driven terminal transitions (#1727).
      // reconcile() bypasses the agent-lifecycle wrappers that normally fire
      // cleanup, so a task whose sessions all died leaves its worktree on
      // disk forever without this — the disk-level twin of the claim-release
      // call above. Fire-and-forget: cleanup runs git/du and must not block
      // the tick; inspectWorktreeCleanup preserves dirty/unmerged/shared
      // worktrees. The completed subset honors cleanupWorktreeOnComplete just
      // like the manual completeTask path; the terminated subset always reaps.
      void cleanupReconciledTaskWorktrees(
        taskStore,
        result,
        deps.agentLifecycleDeps?.interactionLog,
        { cleanupCompleted: deps.agentLifecycleDeps?.getCleanupWorktreeOnComplete?.() ?? true },
      )
        .then((cleaned) => {
          if (cleaned.length > 0) {
            console.log(
              `[worktree-cleanup] reconcile reaped worktrees for ${cleaned.length} task(s)`,
            );
          }
        })
        .catch(() => {});

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
        || finishedAwaitingAckTtlResult.reclaimedTaskIds.length > 0
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

  timerHealth?.register('snoozeExpiry', SNOOZE_EXPIRY_INTERVAL_MS);
  const snoozeExpiryInterval = setInterval(() => {
    timerHealth?.recordFire('snoozeExpiry', SNOOZE_EXPIRY_INTERVAL_MS);
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
  }, SNOOZE_EXPIRY_INTERVAL_MS);

  // --- Periodic task persistence ---
  // Uses saveTasksWithSnapshotPolicy with 'daily' so the first successful
  // save of each local day copies tasks.json to tasks.json.daily.YYYYMMDD.
  // Snapshot failures are logged inside the helper and never block the save.
  timerHealth?.register('save', saveIntervalMs);
  const saveInterval = setInterval(async () => {
    timerHealth?.recordFire('save', saveIntervalMs);
    await runPersistenceSaveTick(deps);
  }, saveIntervalMs);

  // --- Periodic quota usage polling (optional) ---
  // Uses setTimeout chain (not setInterval) so each tick respects the adapter's
  // current interval, which changes dynamically during backoff and recovery.
  let quotaPollTimeout: ReturnType<typeof setTimeout> | null = null;
  if (deps.quotaAdapter) {
    const quotaAdapter = deps.quotaAdapter;
    timerHealth?.register('quotaPoll', quotaAdapter.getCurrentIntervalMs());

    async function pollQuota(): Promise<void> {
      const intervalMs = quotaAdapter.getCurrentIntervalMs();
      timerHealth?.recordFire('quotaPoll', intervalMs);
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
      const nextIntervalMs = quotaAdapter.getCurrentIntervalMs();
      // Keep expected cadence current for overdue checks during backoff.
      timerHealth?.register('quotaPoll', nextIntervalMs);
      quotaPollTimeout = setTimeout(pollQuota, nextIntervalMs);
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
    timerHealth?.register('maintenancePrune', intervalMs);
    maintenancePruneInterval = setInterval(() => {
      if (shouldSkipNonCriticalLifecycleTick(nonCriticalTickPause, 'maintenancePrune')) return;
      timerHealth?.recordFire('maintenancePrune', intervalMs);
      void runScheduledMaintenancePrune(maintenancePrune);
    }, intervalMs);
  }

  // --- Relay-orphan sweep (issue #1723), optional ---
  // Reaps leaked `relay/server.ts` processes whose task worktree no longer
  // exists — the backstop for the die-with-parent watchdog. Off unless
  // KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS is a positive number.
  let relayOrphanSweepInterval: ReturnType<typeof setInterval> | null = null;
  const relayOrphanSweep = deps.relayOrphanSweep;
  if (relayOrphanSweep && relayOrphanSweep.intervalHours > 0) {
    const intervalMs = relayOrphanSweep.intervalHours * 60 * 60 * 1000;
    console.log(
      `[relay-orphan-sweep] scheduled sweep enabled every ${relayOrphanSweep.intervalHours}h`,
    );
    timerHealth?.register('relayOrphanSweep', intervalMs);
    relayOrphanSweepInterval = setInterval(() => {
      if (shouldSkipNonCriticalLifecycleTick(nonCriticalTickPause, 'relayOrphanSweep')) return;
      timerHealth?.recordFire('relayOrphanSweep', intervalMs);
      void runScheduledRelayOrphanSweep(relayOrphanSweep);
    }, intervalMs);
  }

  // --- Reflect-worktree orphan sweep (issue #1860), optional ---
  // Reaps ephemeral reflect worktrees whose source task is gone — periodic
  // backstop for the startup sweep so long-lived instances don't fill disk.
  // Default interval is 1h when wired from bootstrap; intervalHours <= 0
  // disables. Deliberately does NOT run at timer start (boot already sweeps).
  let reflectWorktreeSweepInterval: ReturnType<typeof setInterval> | null = null;
  const reflectWorktreeSweep = deps.reflectWorktreeSweep;
  if (reflectWorktreeSweep && reflectWorktreeSweep.intervalHours > 0) {
    const intervalMs = reflectWorktreeSweep.intervalHours * 60 * 60 * 1000;
    console.log(
      `[reflect-sweep] scheduled sweep enabled every ${reflectWorktreeSweep.intervalHours}h ` +
        `(dir=${reflectWorktreeSweep.reflectWorktreesDir})`,
    );
    timerHealth?.register('reflectWorktreeSweep', intervalMs);
    reflectWorktreeSweepInterval = setInterval(() => {
      if (shouldSkipNonCriticalLifecycleTick(nonCriticalTickPause, 'reflectWorktreeSweep')) return;
      timerHealth?.recordFire('reflectWorktreeSweep', intervalMs);
      void runScheduledReflectWorktreeSweep(reflectWorktreeSweep);
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
    timerHealth?.register('prodSmokeTick', intervalMs);
    prodSmokeTickInterval = setInterval(() => {
      if (shouldSkipNonCriticalLifecycleTick(nonCriticalTickPause, 'prodSmokeTick')) return;
      timerHealth?.recordFire('prodSmokeTick', intervalMs);
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
    timerHealth?.register('deployLagDetector', intervalMs);
    deployLagDetectorInterval = setInterval(() => {
      if (shouldSkipNonCriticalLifecycleTick(nonCriticalTickPause, 'deployLagDetector')) return;
      timerHealth?.recordFire('deployLagDetector', intervalMs);
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
    relayOrphanSweepInterval,
    reflectWorktreeSweepInterval,
  };
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
  if (handles.relayOrphanSweepInterval) clearInterval(handles.relayOrphanSweepInterval);
  if (handles.reflectWorktreeSweepInterval) clearInterval(handles.reflectWorktreeSweepInterval);
}
