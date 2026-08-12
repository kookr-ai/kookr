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
import { DEFAULT_REAP_GRACE_SECONDS } from '../core/reap-warning-coordinator.js';
import { appendAuditRow } from '../core/audit-log.js';
import { nowISO } from '../core/interaction-log.js';
import { reapHungTask } from './hung-task-reaper.js';
import type { ProdSmokeTick } from './prod-smoke-tick.js';
import type { DeployLagDetector } from './deploy-lag-detector.js';
import type { DeployConvergenceController } from './deploy-convergence-controller.js';
import { pruneLoopDeliveryWatchdog, type LoopDeliveryWatchdogRegistry } from '../core/loop-delivery-watchdog.js';
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
import {
  reapAwaitingPollFinishedAwaitingAckTasks,
  runFinishedAwaitingAckReapMaintenance,
  type FinishedAwaitingAckAckReaperMetrics,
} from './finished-awaiting-ack-ack-reaper.js';
import {
  reclaimAgedHungSuspectTasks,
  type HungSuspectTtlReclaimMetrics,
} from './hung-suspect-ttl-sweep.js';
import {
  maybeReapFirstHookMiss,
  type FirstHookMissMetrics,
} from './first-hook-deadline-sweep.js';
import type { HungSuspectResidualAlerter } from './hung-suspect-residual-alert.js';
import type { FinishedAwaitingAckResidualAlerter } from './finished-awaiting-ack-residual-alert.js';
import {
  reclaimAgedProviderPausedTasks,
  type ProviderPausedOccupancyMetrics,
  type ProviderPausedStartTracker,
} from './provider-paused-ttl-sweep.js';
import type { ProviderPausedOccupancyAlerter } from './provider-paused-occupancy-alert.js';
import { resolveTaskAttentionSignals } from './task-attention-signals.js';
import {
  DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS,
  DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS,
  capacityAllowsProviderPausedEarlyReclaim,
  summarizeProviderPausedOccupancy,
} from '../core/provider-paused-ttl.js';
import { DEFAULT_FINISHED_AWAITING_ACK_SOFT_TTL_MS } from '../core/finished-awaiting-ack-ttl.js';
import { restoreExpiredSnoozes } from './snooze-restore.js';
import { runPersistenceSaveTick } from './persistence-save-tick.js';
import {
  runScheduledMaintenancePrune,
  runScheduledRelayOrphanSweep,
  type MaintenancePruneScheduleConfig,
  type RelayOrphanSweepScheduleConfig,
} from './maintenance-prune-schedule.js';
import {
  runScheduledHostStaleDtachReap,
  type HostStaleDtachReaperService,
} from './host-stale-dtach-reaper.js';
import {
  runScheduledReflectWorktreeSweep,
  type ReflectWorktreeSweepScheduleConfig,
} from './use-cases/request-task-reflect.js';
import {
  runScheduledServerLogRotation,
  type ServerLogRotationConfig,
} from './server-log-rotation.js';

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
  /**
   * Coalesced + load-shed-aware snapshot request (from wireEventPipeline).
   * Prefer this over `broadcastToAll(createSnapshotMessage(...))` on timer
   * ticks so token/watchdog/liveness changes never force a full multi-MB
   * snapshot rebuild under event-loop pressure. Falls back to direct
   * broadcast when absent (tests / minimal wirings).
   */
  requestSnapshotBroadcast?: () => void;
  /** Optional shadow detector registry — runs shadow strategies alongside real detection. */
  shadowRegistry?: ShadowDetectorRegistry;
  /** Agent lifecycle deps — needed for pending task promotion. */
  agentLifecycleDeps?: AgentLifecycleDeps;
  /** Durable terminal-tail store for auto-close / liveness completion paths. */
  taskTailStore?: import('../core/task-tail-store.js').TaskTailStore;
  /** Optional quota adapter for plan usage polling. */
  quotaAdapter?: QuotaAdapter;
  /**
   * Re-queue-after-reset hook (issue #1896 / #1699 WS1.4). Invoked when the
   * reaper detects a `provider_paused` task it is holding for resume. It
   * registers the paused issue for auto-re-dispatch at its provider reset
   * (jittered + token-bucket-bounded, lease-keyed dedup — see
   * {@link ProviderResetScheduler}) and returns whether the reaper should keep
   * holding the slot:
   *  - `holdForResume: true`  → reset not yet elapsed; refuse to reap (hold the
   *    slot/lease so the {@link ProviderResetScheduler} can hand off at reset).
   *  - `holdForResume: false` → reset elapsed; the reaper should proceed to reap
   *    the wedged task, freeing its slot + relaunch lease so the scheduled
   *    resume can re-dispatch a fresh task on the issue.
   * Absent (older wiring/tests) means the reaper keeps its pre-#1896 behavior of
   * never reaping a `provider_paused` task (#1667). Must not throw.
   */
  recordProviderPause?: (task: Task, detail: string | undefined) => { holdForResume: boolean } | void;
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
   * Live getter for the finishedAwaitingAck hard TTL, in milliseconds (issue
   * #1884, `finishedAwaitingAckTtlMinutes` setting). Read on every liveness
   * tick. Falls back to the module default (15m) when absent.
   */
  getFinishedAwaitingAckTtlMs?: () => number;
  /**
   * Live getter for the finishedAwaitingAck soft TTL, in milliseconds
   * (issue #2355). Used when capacity-pressure early reclaim is enabled.
   * Falls back to 5m when absent.
   */
  getFinishedAwaitingAckSoftTtlMs?: () => number;
  /**
   * Capacity gate for soft `awaiting_poll` FAA reclaim (issue #2355). When
   * true, the sweep uses soft TTL for awaiting_poll only. When absent, early
   * reclaim is disabled (hard TTL only).
   */
  getCapacityAllowsFinishedAwaitingAckEarlyReclaim?: () => boolean;
  /**
   * Stranded-PR / `merge_required` exemption predicate for the
   * finishedAwaitingAck TTL reclaim (issue #1884), backed by
   * `GitHubStateStore`. Absent ⇒ every candidate is treated as a possible PR
   * hold and never reclaimed (fail-safe default — see
   * `core/finished-awaiting-ack-ttl.ts`).
   */
  isTaskHoldingOpenPr?: (task: Task) => boolean | undefined;
  /**
   * Optional counters for the finishedAwaitingAck TTL reclaim (#1884),
   * meta auto-complete (#2070), skip-reason breakdown (#2084), and
   * capacity-pressure soft reclaim (#2355), exposed via `/metrics` + `/api/health`.
   */
  finishedAwaitingAckTtlReclaimMetrics?: Pick<
    FinishedAwaitingAckTtlReclaimMetrics,
    | 'recordReclaimed'
    | 'recordCapacityPressureEarlyReclaimed'
    | 'recordAttempted'
    | 'recordSelection'
    | 'recordSoftTtlPolicy'
    | 'recordAutoCompleted'
    | 'recordAutoCompleteDeferred'
  >;
  /**
   * Operator page when finishedAwaitingAck residual stays high after the TTL
   * reclaim window (issue #2077). Page-only — never force-completes extra
   * tasks. Prefer a `detectorBroadcast` path so fire/clear edges spool to
   * Discord.
   */
  finishedAwaitingAckResidualAlerter?: Pick<FinishedAwaitingAckResidualAlerter, 'evaluate'>;
  /**
   * Live getter for the hungSuspect TTL, in milliseconds (issue #1935,
   * `hungSuspectTtlMinutes` setting). Read on every liveness tick. Falls back
   * to the module default (25m) when absent.
   */
  getHungSuspectTtlMs?: () => number;
  /** Optional counter for the hungSuspect TTL reclaim, exposed via `/metrics` (issue #1935). */
  hungSuspectTtlReclaimMetrics?: Pick<
    HungSuspectTtlReclaimMetrics,
    'recordReclaimed' | 'recordAttempted' | 'recordSelection'
  >;
  /**
   * Live getter for the post-spawn first-hook ack deadline, in milliseconds
   * (issue #2036, `firstHookDeadlineSeconds` setting). Read on every watchdog
   * tick. Falls back to the module default (180s) when absent.
   */
  getFirstHookDeadlineMs?: () => number;
  /** Optional counter for first-hook misses, exposed via `/api/health` + `/metrics` (issue #2036). */
  firstHookMissMetrics?: Pick<FirstHookMissMetrics, 'recordMiss'>;
  /**
   * Operator page when hungSuspect residual stays high after the TTL reclaim
   * window (issue #1993). Page-only — never terminates extra tasks. Prefer a
   * `detectorBroadcast` path so fire/clear edges spool to Discord.
   */
  hungSuspectResidualAlerter?: Pick<HungSuspectResidualAlerter, 'evaluate'>;
  /**
   * First-observed continuous provider_pause start tracker (issue #2079).
   * Shared across liveness ticks so hard-TTL age is stable.
   */
  providerPausedStartTracker?: ProviderPausedStartTracker;
  /**
   * Live getter for the provider_paused hard TTL, in milliseconds (issue
   * #2079). Read on every liveness tick. Falls back to 2h when absent.
   */
  getProviderPausedHardTtlMs?: () => number;
  /**
   * Live getter for the provider_paused soft TTL, in milliseconds (issue
   * #2225). Used when capacity-aware early reclaim is enabled. Falls back
   * to 40m when absent.
   */
  getProviderPausedSoftTtlMs?: () => number;
  /**
   * Capacity gate for soft provider_paused reclaim (issue #2225). Receives
   * the live provider_paused occupancy count. When true, the sweep uses
   * soft TTL. When absent, early reclaim is disabled (hard TTL only).
   */
  getCapacityAllowsProviderPausedEarlyReclaim?: (
    providerPausedCount: number,
  ) => boolean;
  /** Optional counters for provider_paused occupancy + hard-TTL reclaim (issue #2079). */
  providerPausedOccupancyMetrics?: Pick<
    ProviderPausedOccupancyMetrics,
    | 'recordReclaimed'
    | 'recordAttempted'
    | 'recordSelection'
    | 'recordOccupancy'
    | 'recordHardTtlMs'
    | 'recordSoftTtlPolicy'
  >;
  /**
   * Operator page when provider_paused occupancy stays high (issue #2079).
   * Page-only for the occupancy bound — hard TTL reclaim is separate.
   * Prefer `detectorBroadcast` so fire/clear edges spool to Discord.
   */
  providerPausedOccupancyAlerter?: Pick<ProviderPausedOccupancyAlerter, 'evaluate'>;
  /** Kookr data-dir "reports" directory. Hung-task reap writes a markdown evidence report here. */
  reportsDir?: string;
  /** Live getter — hung-task reaper enabled flag (issue #1526 Phase A). Defaults to enabled when absent. */
  getHungTaskReapEnabled?: () => boolean;
  /** Live getter — hung-task reap silence threshold, in milliseconds. */
  getHungTaskReapMs?: () => number;
  /**
   * Grace-period warning before a hung-task reap (RFC rfc-reap-grace-warning.md).
   * When the coordinator is wired AND the warning phase is enabled, a
   * reap-eligible task is warned (a countdown surfaces in the snapshot) and only
   * reaped once the deadline passes; a maintenance pass clears warnings whose
   * task recovered, and a bounded presence auto-hold protects a task a live
   * dashboard currently has open. All four are optional so existing wirings and
   * tests behave exactly as before (immediate reap).
   */
  reapWarningCoordinator?: import('../core/reap-warning-coordinator.js').ReapWarningCoordinator;
  /** Live getter — warned phase enabled flag. Independent kill switch; defaults to enabled when absent. */
  getHungTaskReapWarningEnabled?: () => boolean;
  /** Live getter — grace-period countdown, in milliseconds. */
  getHungTaskReapGraceMs?: () => number;
  /**
   * finishedAwaitingAck ack-path reaper (issue #2170). Bounds the
   * `awaiting_poll` FAA dwell: a finished task unacknowledged past
   * {@link getFinishedAwaitingAckAckReapMs} is force-completed after a
   * grace-period + operator-veto phase (parity with #2163), via its OWN
   * coordinator instance (separate from the hung reaper's). All optional so
   * existing wirings/tests skip the fast path and keep the strict TTL backstop.
   */
  faaAckReapWarningCoordinator?: import('../core/reap-warning-coordinator.js').ReapWarningCoordinator;
  /** Live getter — ack-path reaper enabled flag (kill switch). Defaults to enabled when absent. */
  getFinishedAwaitingAckAckReaperEnabled?: () => boolean;
  /** Live getter — ack-path hard reap deadline, in milliseconds. */
  getFinishedAwaitingAckAckReapMs?: () => number;
  /** Live getter — ack-path grace-period countdown, in milliseconds. */
  getFinishedAwaitingAckAckReapGraceMs?: () => number;
  /** Optional counters for the ack-path reaper, exposed via `GET /api/diagnostics/reap-warnings` (issue #2170). */
  finishedAwaitingAckAckReaperMetrics?: FinishedAwaitingAckAckReaperMetrics;
  /** Presence probe — true when a live dashboard connection currently has the task selected. */
  isTaskSelectedByAnyConnection?: (taskId: string) => boolean;
  /**
   * Orphan/terminal-task session reaper (issue #1720). Run on every liveness
   * tick, after `reconcile()` — reaps true orphan sessions and sessions whose
   * owning task already reached a terminal status but whose process tree is
   * still resident. Absent only in tests that don't care about this sweep.
   */
  sessionReaper?: Pick<import('./session-reaper.js').SessionReaperService, 'runSweep'>;
  /**
   * Ralph orphan-loop recovery (issue #2193). Closes loops stuck at
   * `status:"running"` after their owning task reached a terminal status
   * (e.g. first-hook miss) without a Stop event. Absent only in tests that
   * don't care about this sweep.
   */
  ralphLoopService?: Pick<import('./ralph-loop-service.js').RalphLoopService, 'reconcileOrphanedLoops'>;
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
   * Schedule service for live terminate → consecutiveFailures (issue #2353).
   * When present, hung-task reaps notify the schedule so timeout thrash
   * increments the failure streak and can auto-pause. Absent in tests /
   * minimal wirings.
   */
  scheduleService?: {
    recordTaskTerminalOutcome(taskId: string, status: 'completed' | 'cancelled'): Promise<void>;
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
   * Mid-process size-capped rotation for `server.log` (issue #1991). When
   * `intervalMs > 0`, `maxBytes > 0`, and `generations > 0`, a dedicated
   * interval stats the live log and renames generations when over threshold,
   * reopening process stdio onto a fresh file so appends are not lost.
   * Defaults are on (50 MiB / 3 generations / 60s) when wired from bootstrap.
   */
  serverLogRotation?: ServerLogRotationScheduleConfig;
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
   * Optional in-process deploy-convergence controller (issue #2226). When
   * provided, a dedicated interval asserts serving SHA includes origin/main
   * and — past the 15m grace — triggers the canonical redeploy path, plus
   * pages a residual operator signal when behindCount≥1 and deploying=false
   * for the residual stale window. Closes the gap left when the agent
   * schedule was never registered. Undefined (dev/test, or disabled) starts
   * no interval. `maybeRun()` never throws and guards against pile-up itself.
   */
  deployConvergenceController?: DeployConvergenceController;
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
   * Optional host-stale dtach reaper (issues #2356, #2384). When
   * `intervalMinutes > 0` (resolved from
   * `KOOKR_HOST_STALE_DTACH_REAP_INTERVAL_MINUTES`, default 5), a dedicated
   * interval reclaims process-table kookr-dtach masters that are not
   * live-attached and whose socket is gone (`missing_socket_aged` always
   * selects, rate-limited). Distinct from session reaper. Failures are logged,
   * never crash.
   */
  hostStaleDtachReaper?: {
    intervalMinutes: number;
    service: Pick<HostStaleDtachReaperService, 'runSweep'>;
  };
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
   * When elevated, maintenance prune / server-log rotation / relay-orphan /
   * reflect-worktree / prod-smoke / deploy-lag / deploy-convergence ticks skip
   * their body. Critical loops (token scan, watchdog, liveness, save, snooze,
   * quota) are never gated. Fail-open when omitted.
   */
  nonCriticalTickPause?: {
    shouldSkipTick(): boolean;
    recordPause(timerName: string): void;
  };
  /**
   * Delivery-aware loop watchdog registry (issue #1902). The registry is
   * SAMPLED per-iteration in {@link ../server/ralph-loop-service}; here the
   * liveness tick only PRUNES entries for loops that are no longer running, so
   * terminated loops don't leak watchdog state. Absent (or a `0` threshold) ⇒
   * no pruning is needed.
   */
  loopDeliveryWatchdog?: LoopDeliveryWatchdogRegistry;
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
  /** Null unless mid-process server.log rotation (issue #1991) was configured. */
  serverLogRotationInterval: ReturnType<typeof setInterval> | null;
  /** Null unless the hourly prod smoke tick (issue #1593) was configured. */
  prodSmokeTickInterval: ReturnType<typeof setInterval> | null;
  /** Null unless the deploy-lag detector (issue #1594) was configured. */
  deployLagDetectorInterval: ReturnType<typeof setInterval> | null;
  /** Null unless the deploy-convergence controller (issue #2226) was configured. */
  deployConvergenceInterval: ReturnType<typeof setInterval> | null;
  /** Null unless the relay-orphan sweep (issue #1723) was configured. */
  relayOrphanSweepInterval: ReturnType<typeof setInterval> | null;
  /** Null unless the relay-orphan sweep startup reclaim (issue #1885) is pending. */
  relayOrphanSweepStartupTimer: ReturnType<typeof setTimeout> | null;
  /** Null unless the host-stale dtach reaper (issue #2356) was configured. */
  hostStaleDtachReapInterval: ReturnType<typeof setInterval> | null;
  /** Null unless the host-stale dtach reaper startup reclaim is pending. */
  hostStaleDtachReapStartupTimer: ReturnType<typeof setTimeout> | null;
  /** Null unless the reflect-worktree orphan sweep (issue #1860) was configured. */
  reflectWorktreeSweepInterval: ReturnType<typeof setInterval> | null;
}

/** Config for the mid-process `server.log` size-cap timer (issue #1991). */
export interface ServerLogRotationScheduleConfig {
  logPath: string;
  maxBytes: number;
  generations: number;
  /** Check interval in ms. `<= 0` disables the timer. */
  intervalMs: number;
  /** Test seam replacing the rotate tick body. */
  run?: (config: ServerLogRotationScheduleConfig) => void;
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
 * long they have been waiting. Returns true when the caller should broadcast a
 * snapshot — i.e. a task was reaped, OR a grace-period warning was just raised
 * (RFC rfc-reap-grace-warning.md); false while a warning's countdown is still
 * running or nothing changed.
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
    // Issue #1896: register the held issue for auto-re-dispatch at its provider
    // reset (so the operator no longer re-dispatches by hand), and learn whether
    // the reset has elapsed. Before reset → keep holding the slot. After reset →
    // stop holding and fall through to reap, which frees the slot + relaunch
    // lease so the ProviderResetScheduler can hand off a fresh task. Defensive:
    // a throw here must never turn a "hold for resume" into an accidental reap,
    // so on any error we default to holding (the pre-#1896 #1667 behavior).
    let holdForResume = true;
    try {
      const decision = deps.recordProviderPause?.(task, pause.detail);
      if (decision && decision.holdForResume === false) holdForResume = false;
    } catch (err) {
      console.error(`[hung-task-reaper] recordProviderPause failed for task ${task.id}:`, err);
      holdForResume = true;
    }
    if (holdForResume) {
      // A billing/quota pause is not a hang. Drop any reap warning raised
      // before the pause was recognized so the dashboard banner disappears
      // immediately, rather than freezing at 0:00 until the maintenance
      // self-heal window elapses (correctness review). Signal a broadcast when
      // a banner was actually cleared so the client updates promptly.
      const clearedWarning = deps.reapWarningCoordinator?.clear(task.id, 'recovered');
      if (clearedWarning) {
        await appendReapWarningClearedAudit(deps.auditLogPath, task.id, 'recovered');
      }
      console.warn(
        `[hung-task-reaper] skipping reap for task ${task.id} — provider_paused `
        + `(${pause.detail ?? 'billing/quota'}); holding slot until provider reset`,
      );
      return clearedWarning !== undefined;
    }
    console.warn(
      `[hung-task-reaper] reaping provider_paused task ${task.id} — provider reset elapsed `
      + `(${pause.detail ?? 'billing/quota'}); freeing slot + lease for auto-resume`,
    );
    // fall through to the normal reap below
  }

  // Grace-period warning phase (RFC rfc-reap-grace-warning.md). Composed AFTER
  // the provider-pause hold so a billing-paused task is never warned. When the
  // coordinator is wired and the warned phase is enabled, warn first (a
  // countdown surfaces in the snapshot) and only reap once the deadline passes;
  // a task a live dashboard currently has open is auto-held (bounded). When the
  // coordinator is absent or the phase is disabled, fall through to the
  // unchanged immediate reap — the independent rollback lever.
  let reapWarnedAt: number | undefined;
  let reapKeptAliveCount: number | undefined;
  const coordinator = deps.reapWarningCoordinator;
  if (coordinator && (deps.getHungTaskReapWarningEnabled?.() ?? true)) {
    const graceMs = deps.getHungTaskReapGraceMs?.() ?? DEFAULT_REAP_GRACE_SECONDS * 1000;
    const present = deps.isTaskSelectedByAnyConnection?.(task.id) ?? false;
    const advance = coordinator.advance({
      taskId: task.id,
      agentId,
      silentForMs: verdict.silentForMs,
      now: nowDate.getTime(),
      graceMs,
      present,
    });
    if (advance.action === 'warn') {
      console.warn(
        `[reap-warning] warned task ${task.id} — reap in ${Math.round(graceMs / 1000)}s `
        + `unless kept alive (silent ${Math.round(verdict.silentForMs / 60_000)}m, present=${present})`,
      );
      await appendAuditRow(deps.auditLogPath, {
        type: 'task.hungTaskReapWarned',
        timestamp: nowISO(),
        actor: 'system:hung-task-reaper',
        taskId: task.id,
        silentForMs: verdict.silentForMs,
        graceMs,
        present,
      });
      return true; // snapshot carries the new warning — caller broadcasts on `changed`
    }
    if (advance.action === 'wait') {
      return false; // countdown still running
    }
    // advance.action === 'reap' → the warning was consumed; fall through to the
    // real reap, carrying its linkage onto the terminal audit row.
    reapWarnedAt = advance.warning.warnedAt;
    reapKeptAliveCount = advance.warning.keptAliveCount;
    console.warn(
      `[reap-warning] grace elapsed for task ${task.id} `
      + `(kept alive ${advance.warning.keptAliveCount}×) — reaping`,
    );
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
      ...(reapWarnedAt !== undefined ? { warnedAt: reapWarnedAt } : {}),
      ...(reapKeptAliveCount !== undefined ? { keptAliveCount: reapKeptAliveCount } : {}),
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


/**
 * Self-heal window (RFC rfc-reap-grace-warning.md): a warning left this long
 * past its deadline without being reaped — because the watchdog stopped
 * reporting `stale_agent`, so the gated reap path (A) never fired — is cleared
 * so a countdown banner can never freeze at 0:00.
 */
export const REAP_WARNING_STUCK_CLEAR_MS = 60_000;

/**
 * Warning-maintenance pass (RFC rfc-reap-grace-warning.md), run once per
 * watchdog tick AFTER the per-agent loop, over the coordinator's OWN warned
 * task-ids — independent of which agents are tracked or `stale_agent` this
 * tick. This is what makes the headline scenario correct: when the user submits
 * a prompt, the pane changes → the task is no longer reap-eligible → the
 * warning is cleared here (the gated path (A) is skipped because the agent went
 * active). It also reclaims warnings for tasks that left `inProgress` off the
 * tracked-agent path, applies the bounded presence auto-hold, and self-heals a
 * warning stuck past its deadline. It NEVER reaps — reaping stays exclusively
 * in the `stale_agent`-gated {@link maybeReapHungTask}.
 *
 * Returns true when a clear happened (caller should broadcast a snapshot).
 * Presence extensions are intentionally silent — they ride the next periodic
 * snapshot, and the client renders a "held while you're viewing" state rather
 * than a ticking countdown, so no per-tick rebroadcast is needed.
 */
export async function runReapWarningMaintenance(
  deps: Pick<TimerDeps,
    'reapWarningCoordinator' | 'getHungTaskReapWarningEnabled' | 'getHungTaskReapMs'
    | 'getHungTaskReapGraceMs' | 'isTaskSelectedByAnyConnection' | 'watchdog' | 'auditLogPath'>,
  taskStore: TaskStore,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const coordinator = deps.reapWarningCoordinator;
  if (!coordinator) return false;
  const warnedIds = coordinator.warnedTaskIds();
  if (warnedIds.length === 0) return false;

  // Disabled at runtime → drop all warnings so banners disappear and the reaper
  // reverts to immediate. This pass owns the cleanup because the per-agent
  // stale branch short-circuits before maybeReapHungTask when disabled.
  if (!(deps.getHungTaskReapWarningEnabled?.() ?? true)) {
    const cleared = coordinator.clearAll();
    for (const id of cleared) {
      await appendAuditRow(deps.auditLogPath, {
        type: 'task.hungTaskReapWarningCleared',
        timestamp: nowISO(),
        actor: 'system:hung-task-reaper',
        taskId: id,
        reason: 'disabled',
      });
    }
    if (cleared.length > 0) {
      console.warn(`[reap-warning] warned phase disabled — cleared ${cleared.length} warning(s)`);
    }
    return cleared.length > 0;
  }

  const nowMs = now().getTime();
  const thresholdMs = deps.getHungTaskReapMs?.();
  const graceMs = deps.getHungTaskReapGraceMs?.() ?? DEFAULT_REAP_GRACE_SECONDS * 1000;
  let changed = false;

  for (const taskId of warnedIds) {
    const task = taskStore.getTask(taskId);
    if (!task || task.status !== 'inProgress') {
      if (coordinator.clear(taskId, 'gone')) {
        changed = true;
        await appendReapWarningClearedAudit(deps.auditLogPath, taskId, 'gone');
      }
      continue;
    }

    const warning = coordinator.getWarning(taskId);
    const state = warning ? deps.watchdog.getState(warning.agentId) : undefined;
    const stillEligible = state
      ? evaluateHungTaskReap(
        task,
        {
          lastHookEventAt: state.lastEventAt,
          lastPaneChangeAt: state.lastPaneChangeAt,
          lastTokenActivityAt: state.lastTokenActivityAt,
        },
        { now: nowMs, thresholdMs },
      ).eligible
      : false; // no watchdog state → agent gone/untracked → treat as recovered

    if (!stillEligible) {
      if (coordinator.clear(taskId, 'recovered')) {
        changed = true;
        console.log(`[reap-warning] cleared task ${taskId} — recovered (no longer reap-eligible)`);
        await appendReapWarningClearedAudit(deps.auditLogPath, taskId, 'recovered');
      }
      continue;
    }

    // Still eligible: bounded presence auto-hold, then self-heal a stuck banner.
    const present = deps.isTaskSelectedByAnyConnection?.(taskId) ?? false;
    coordinator.applyPresence(taskId, present, nowMs, graceMs);
    const held = coordinator.getWarning(taskId);
    if (held && nowMs > held.deadlineAt + REAP_WARNING_STUCK_CLEAR_MS) {
      if (coordinator.clear(taskId, 'stale')) {
        changed = true;
        console.warn(`[reap-warning] cleared task ${taskId} — stuck past deadline with no reap (self-heal)`);
        await appendReapWarningClearedAudit(deps.auditLogPath, taskId, 'stale');
      }
    }
  }

  return changed;
}

async function appendReapWarningClearedAudit(
  auditLogPath: string | undefined,
  taskId: string,
  reason: 'recovered' | 'gone' | 'stale',
): Promise<void> {
  await appendAuditRow(auditLogPath, {
    type: 'task.hungTaskReapWarningCleared',
    timestamp: nowISO(),
    actor: 'system:hung-task-reaper',
    taskId,
    reason,
  });
}

/** Fixed cadence for the token-usage scan tick (issue #1771 timer-health). */
export const TOKEN_SCAN_INTERVAL_MS = 5_000;
/** Fixed cadence for the watchdog tick (issue #1771 timer-health). */
export const WATCHDOG_INTERVAL_MS = 5_000;
/** Fixed cadence for snooze-expiry restore (issue #1771 timer-health). */
export const SNOOZE_EXPIRY_INTERVAL_MS = 1_000;
/**
 * Delay before the relay-orphan sweep's one-shot startup reclaim (issue #1885).
 * Long enough to clear the boot I/O spike, short enough that an already-degraded
 * daemon sheds its accumulated orphans within a minute of coming up.
 */
export const RELAY_ORPHAN_SWEEP_STARTUP_DELAY_MS = 30_000;
/**
 * Delay before the host-stale dtach reaper's one-shot startup reclaim (#2356).
 * Slightly after the relay-orphan startup reclaim so boot I/O is staggered.
 */
export const HOST_STALE_DTACH_REAP_STARTUP_DELAY_MS = 45_000;

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

/**
 * Prefer the event-pipeline coalesced snapshot path so timer ticks never force
 * a full multi-MB createSnapshotMessage under load. Falls back to a direct
 * broadcast for minimal wirings/tests that omit requestSnapshotBroadcast.
 */
function broadcastDashboardSnapshot(deps: TimerDeps): void {
  if (deps.requestSnapshotBroadcast) {
    deps.requestSnapshotBroadcast();
    return;
  }
  deps.broadcastToAll(createSnapshotMessage({
    monitor: deps.monitor,
    serverCwd: deps.serverCwd,
    activityMetaProvider: deps.activityMetaProvider,
    relationTaskStore: deps.taskStore,
    userInputDeliveryProvider: deps.userInputDeliveries,
  }));
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
        broadcastDashboardSnapshot(deps);
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

          // First-hook miss reaper (issue #2036). Independent of the watchdog
          // verdict: a post-spawn session that never emits SessionStart / any
          // agent hook must free capacity well before the multi-hour hung-task
          // threshold. Runs after hook drain so a late-but-in-window SessionStart
          // is recorded as firstHookAt before we evaluate. MCP-startup grace is
          // honored inside evaluateFirstHookMiss.
          {
            const firstHookState = watchdog.getState(agentId);
            if (
              firstHookState
              && await maybeReapFirstHookMiss(
                agentId,
                paneContent,
                {
                  taskStore,
                  lifecycleDeps,
                  getFirstHookDeadlineMs: deps.getFirstHookDeadlineMs,
                  getMcpStartupGracePeriodMs: () => watchdog.getConfig().mcpStartupGracePeriodMs,
                  reportsDir: deps.reportsDir,
                  auditLogPath: deps.auditLogPath,
                  dispositionLedgerPath: deps.dispositionLedgerPath,
                  broadcastToAll: deps.broadcastToAll,
                  metrics: deps.firstHookMissMetrics,
                  now: () => new Date(),
                  promotePending: deps.agentLifecycleDeps
                    ? async () => {
                      await promotePendingTasks({
                        taskStore,
                        adapterRegistry: deps.adapterRegistry,
                        lifecycleDeps: deps.agentLifecycleDeps!,
                        broadcastToAll: deps.broadcastToAll,
                        serverCwd: deps.serverCwd,
                        getMaxActiveTasks: deps.getMaxActiveTasks,
                        bypassAllPermissions: deps.bypassAllPermissions,
                      });
                    }
                    : undefined,
                },
                {
                  registeredAt: firstHookState.registeredAt,
                  firstHookAt: firstHookState.firstHookAt,
                  mcpStartupAt: firstHookState.mcpStartupAt,
                },
              )
            ) {
              changed = true;
              continue; // session is gone — skip hung-task reaper for this agent
            }
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

      // Reap-warning maintenance (RFC rfc-reap-grace-warning.md): clear warnings
      // whose task recovered, apply the bounded presence auto-hold, self-heal
      // stuck warnings — over the coordinator's own keys, outside the per-agent
      // stale gate so a prompt-submit recovery clears the banner.
      try {
        if (await runReapWarningMaintenance(deps, taskStore)) {
          changed = true;
        }
      } catch (err) {
        console.error('Error during reap-warning maintenance:', err);
      }

      // FAA ack-path reap-warning maintenance (issue #2170): mirror the hung
      // maintenance for the ack-reaper's own coordinator — clear a warning the
      // moment its task is acked / no longer finishedAwaitingAck, apply the
      // presence hold, self-heal a stuck countdown. Never closes here.
      if (deps.faaAckReapWarningCoordinator) {
        try {
          const faaMaintChanged = await runFinishedAwaitingAckReapMaintenance(
            {
              coordinator: deps.faaAckReapWarningCoordinator,
              auditLogPath: deps.auditLogPath,
              isTaskSelectedByAnyConnection: deps.isTaskSelectedByAnyConnection,
              getEnabled: deps.getFinishedAwaitingAckAckReaperEnabled,
              getGraceMs: deps.getFinishedAwaitingAckAckReapGraceMs,
            },
            taskStore,
          );
          if (faaMaintChanged) changed = true;
        } catch (err) {
          console.error('Error during FAA ack-reap maintenance:', err);
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
        broadcastDashboardSnapshot(deps);
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
    // Live terminate → schedule consecutiveFailures (issue #2353).
    ...(deps.scheduleService
      ? {
          recordScheduleTaskTerminal: (taskId, status) =>
            deps.scheduleService!.recordTaskTerminalOutcome(taskId, status),
        }
      : {}),
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

      // Prune delivery-watchdog entries for loops no longer active (issue
      // #1902). The registry is sampled per-iteration in ralph-loop-service;
      // this keeps terminated loops from leaking watchdog state while retaining
      // paused loops so a resume continues the same streak. Cheap: one pass
      // over tasks per liveness tick, only when the watchdog is enabled.
      if (deps.loopDeliveryWatchdog) {
        // viewTasks (no clone): watchdog only needs id + ralphLoop.status.
        pruneLoopDeliveryWatchdog(taskStore.viewTasks(), deps.loopDeliveryWatchdog);
      }

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

      // Ralph orphan-loop recovery (issue #2193): a terminal task whose
      // ralphLoop is still `running` (first-hook miss, hung reap, etc.) never
      // gets a Stop event, so stop-driven relaunch cannot close it. Same
      // contract as startup recovery, without requiring a server restart.
      // Fail-open: never block the liveness tick.
      let orphanLoopsFailed = 0;
      try {
        const orphanSummary = await deps.ralphLoopService?.reconcileOrphanedLoops();
        if (orphanSummary && orphanSummary.failed > 0) {
          orphanLoopsFailed = orphanSummary.failed;
          console.warn(
            `[ralph-orphan-recovery] closed ${orphanSummary.failed} orphaned loop(s) `
            + `(examined ${orphanSummary.examined})`,
          );
        }
      } catch (err) {
        console.warn(
          '[ralph-orphan-recovery] periodic sweep failed:',
          err instanceof Error ? err.message : err,
        );
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

      // finishedAwaitingAck ack-path reaper (issue #2170): bound the
      // `awaiting_poll` FAA dwell BEFORE the slower strict TTL reclaim. A
      // finished task unacknowledged past the short ack-reap deadline is warned
      // (grace countdown rides the snapshot; operator can "Keep it alive") and
      // force-completed once the grace elapses — same open-PR / live-turn /
      // interactive-pane fail-safes as the strict path. Runs first so it
      // front-runs the strict reclaim for the population that never reaches it.
      if (deps.faaAckReapWarningCoordinator) {
        try {
          // A reap force-completes via completeTask (which broadcasts on its
          // own); a new warning rides the next periodic snapshot the liveness
          // loop already emits — same cadence the strict TTL sweep relies on —
          // so no explicit change flag is threaded here.
          await reapAwaitingPollFinishedAwaitingAckTasks({
            taskStore,
            coordinator: deps.faaAckReapWarningCoordinator,
            lifecycleDeps: {
              ...lifecycleDeps,
              ...(deps.agentLifecycleDeps?.interactionLog
                ? { interactionLog: deps.agentLifecycleDeps.interactionLog }
                : {}),
            },
            auditLogPath: deps.auditLogPath,
            broadcastToAll: deps.broadcastToAll,
            isHoldingOpenPr: deps.isTaskHoldingOpenPr,
            isTaskSelectedByAnyConnection: deps.isTaskSelectedByAnyConnection,
            getEnabled: deps.getFinishedAwaitingAckAckReaperEnabled,
            getDeadlineMs: deps.getFinishedAwaitingAckAckReapMs,
            getGraceMs: deps.getFinishedAwaitingAckAckReapGraceMs,
            metrics: deps.finishedAwaitingAckAckReaperMetrics,
            ...(deps.taskTailStore
              ? {
                  getTaskPaneText: async (taskId: string) => {
                    try {
                      const record = await deps.taskTailStore!.getByTaskId(taskId);
                      return record?.text;
                    } catch {
                      return undefined;
                    }
                  },
                }
              : {}),
          });
        } catch (err) {
          console.error('Error during FAA ack-path reap:', err);
        }
      }

      // finishedAwaitingAck TTL reclaim (issue #1884) + capacity-pressure soft
      // TTL for awaiting_poll phantoms (issue #2355) + meta auto-complete
      // (issue #2070): force-complete aged completion_ready tasks. Strict path
      // requires isHoldingOpenPr === false; soft path only accelerates
      // awaiting_poll under capacity pressure; meta allowlist relaxes unknown PR
      // refs and applies Lucy #2238-style TOCTOU (re-GET + live turn / tail veto).
      const faaCapacityEarly =
        deps.getCapacityAllowsFinishedAwaitingAckEarlyReclaim?.() === true;
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
          ...(deps.taskTailStore
            ? {
                getTaskPaneText: async (taskId: string) => {
                  try {
                    const record = await deps.taskTailStore!.getByTaskId(taskId);
                    return record?.text;
                  } catch {
                    return undefined;
                  }
                },
              }
            : {}),
        },
        {
          ttlMs: deps.getFinishedAwaitingAckTtlMs?.(),
          softTtlMs:
            deps.getFinishedAwaitingAckSoftTtlMs?.()
            ?? DEFAULT_FINISHED_AWAITING_ACK_SOFT_TTL_MS,
          capacityAllowsEarlyReclaim: faaCapacityEarly,
        },
      );

      // finishedAwaitingAck residual page (issue #2077): after reclaim, if
      // residual occupancy stays high without decreasing for the stale window,
      // page the operator (Discord via detectorBroadcast). Never force-completes
      // extra tasks — the reclaim above already did what TTL allows.
      if (deps.finishedAwaitingAckResidualAlerter) {
        const closedIds = new Set([
          ...finishedAwaitingAckTtlResult.reclaimedTaskIds,
          ...finishedAwaitingAckTtlResult.autoCompletedTaskIds,
        ]);
        let residualFaa = 0;
        let oldestRaisedAtMs: number | undefined;
        const nowMs = Date.now();
        // Live-only: residual FAA is never about terminal history.
        for (const task of taskStore.viewLiveTasks()) {
          if (task.status !== 'inProgress') continue;
          if (task.pendingSignal?.kind !== 'completion_ready') continue;
          if (closedIds.has(task.id)) continue;
          residualFaa += 1;
          const raisedAt = task.pendingSignal.raisedAt
            ? Date.parse(task.pendingSignal.raisedAt)
            : NaN;
          if (Number.isFinite(raisedAt)
            && (oldestRaisedAtMs === undefined || raisedAt < oldestRaisedAtMs)) {
            oldestRaisedAtMs = raisedAt;
          }
        }
        try {
          deps.finishedAwaitingAckResidualAlerter.evaluate({
            residualCount: residualFaa,
            reclaimedCount:
              finishedAwaitingAckTtlResult.reclaimedTaskIds.length
              + finishedAwaitingAckTtlResult.autoCompletedTaskIds.length,
            oldestAgeMs:
              oldestRaisedAtMs !== undefined ? nowMs - oldestRaisedAtMs : null,
          });
        } catch (err) {
          console.warn(
            '[liveness] finishedAwaitingAck residual alerter threw:',
            err instanceof Error ? err.message : err,
          );
        }
      }

      // hungSuspect TTL reclaim (issue #1935): terminate tasks classified
      // hungSuspect that have been all-channels-silent past the short TTL,
      // freeing phantom-active concurrency slots. Soft reclaim (terminate +
      // needs-human/obsolete disposition), never force-complete incomplete work.
      // Stranded-PR exemption reuses the FAA predicate. Classification reuses
      // the same resolveTaskAttentionSignals path /api/health uses so reclaim
      // only acts on tasks already reported as hungSuspect.
      const hungSuspectNowMs = Date.now();
      // Resolve attention signals once per task (isHungSuspect + liveness +
      // queued anomaly + provider pause all come from the same hot-path lookup).
      const hungSuspectSignalsCache = new Map<string, ReturnType<typeof resolveTaskAttentionSignals>>();
      const hungSuspectSignals = (task: Task) => {
        let signals = hungSuspectSignalsCache.get(task.id);
        if (!signals) {
          signals = resolveTaskAttentionSignals(
            task,
            { queue: deps.queue, watchdog: deps.watchdog },
            hungSuspectNowMs,
          );
          hungSuspectSignalsCache.set(task.id, signals);
        }
        return signals;
      };
      const hungSuspectTtlResult = await reclaimAgedHungSuspectTasks(
        {
          taskStore,
          lifecycleDeps: {
            ...lifecycleDeps,
            ...(deps.agentLifecycleDeps?.interactionLog
              ? { interactionLog: deps.agentLifecycleDeps.interactionLog }
              : {}),
          },
          auditLogPath: deps.auditLogPath,
          dispositionLedgerPath: deps.dispositionLedgerPath,
          broadcastToAll: deps.broadcastToAll,
          isHungSuspect: (task) => hungSuspectSignals(task).hungSuspect,
          getLiveness: (task) => hungSuspectSignals(task).liveness,
          getQueuedAnomalyType: (task) => hungSuspectSignals(task).queuedAnomalyType,
          // Use the same event+anomaly provider-pause predicate as auto-close /
          // delivered sweeps (and the hard reaper's event scan), not the
          // attention-signals-only flag — a purged billing anomaly with
          // stop_failure:billing_error in the event stream must still hold
          // (issue #1667 / independent review PR #1955).
          isProviderPaused: isTaskProviderPaused,
          isHoldingOpenPr: deps.isTaskHoldingOpenPr,
          resolveMergedPr: deps.resolveMergedPr,
          metrics: deps.hungSuspectTtlReclaimMetrics,
        },
        { ttlMs: deps.getHungSuspectTtlMs?.() },
      );

      // hungSuspect residual page (issue #1993): after reclaim, if residual
      // occupancy stays high without decreasing for the stale window, page
      // the operator (Discord via detectorBroadcast). Never terminates extra
      // tasks — the reclaim above already did what TTL allows.
      if (deps.hungSuspectResidualAlerter) {
        // Count like the capacity ledger's hungSuspect class: inProgress only,
        // and not finishedAwaitingAck (completion_ready). isTaskHungSuspect
        // short-circuits true on queued stale_agent without consulting
        // pendingSignal, so FAA tasks would otherwise inflate residual and
        // false-page while byClass.hungSuspect stays 0. Skip ids just
        // reclaimed this tick — hungSuspectSignalsCache may still say true
        // for them (filled during reclaim before terminate/purge).
        const reclaimedIds = new Set(hungSuspectTtlResult.reclaimedTaskIds);
        let residualHungSuspect = 0;
        // Live-only: hungSuspect residual is inProgress-only capacity math.
        for (const task of taskStore.viewLiveTasks()) {
          if (task.status !== 'inProgress') continue;
          if (task.pendingSignal?.kind === 'completion_ready') continue;
          if (reclaimedIds.has(task.id)) continue;
          if (hungSuspectSignals(task).hungSuspect) residualHungSuspect += 1;
        }
        try {
          // Issue #2232: pass last-pass outcomes so the page names dominant
          // skip reason + sample task ids (open_pr_failsafe-dominated residual).
          // Page-only — never terminates extra tasks beyond the reclaim above.
          deps.hungSuspectResidualAlerter.evaluate({
            residualCount: residualHungSuspect,
            reclaimedCount: hungSuspectTtlResult.reclaimedTaskIds.length,
            lastOutcomes: hungSuspectTtlResult.selection?.outcomes,
          });
        } catch (err) {
          console.warn(
            '[liveness] hungSuspect residual alerter threw:',
            err instanceof Error ? err.message : err,
          );
        }
      }

      // provider_paused occupancy bound + hard/soft TTL (issues #2079 / #2225):
      // observe pauseStartedAt, reclaim aged pauses (needs-human, never
      // delivered) — soft TTL when capacity allows early reclaim — then page
      // when occupancy stays ≥ bound past the stale window.
      let providerPausedTtlResult: Awaited<ReturnType<typeof reclaimAgedProviderPausedTasks>> | null =
        null;
      if (deps.providerPausedStartTracker) {
        try {
          // Pre-count occupancy for the soft-TTL capacity gate (issue #2225).
          // Uses the same pause-start tracker + pause predicate the sweep will
          // use; a second observeAll inside the sweep is idempotent.
          const prePauseNow = Date.now();
          const preGetPauseStart = deps.providerPausedStartTracker.observeAll(
            taskStore.listTasks(),
            isTaskProviderPaused,
            prePauseNow,
          );
          const preOccupancy = summarizeProviderPausedOccupancy(taskStore.listTasks(), {
            now: new Date(prePauseNow),
            isProviderPaused: isTaskProviderPaused,
            getPauseStartedAtMs: (task) => preGetPauseStart(task),
          });
          const capacityAllowsEarlyReclaim =
            deps.getCapacityAllowsProviderPausedEarlyReclaim?.(preOccupancy.count)
            ?? capacityAllowsProviderPausedEarlyReclaim({
              // Fallback when wiring omits the capacity callback: only occupancy
              // count is known here — refuse early reclaim without free-slot
              // evidence (fail closed on capacity).
              phantomActive: 0,
              providerPausedCount: preOccupancy.count,
              freeForGeneralSources: 0,
            });

          providerPausedTtlResult = await reclaimAgedProviderPausedTasks(
            {
              taskStore,
              lifecycleDeps: {
                ...lifecycleDeps,
                ...(deps.agentLifecycleDeps?.interactionLog
                  ? { interactionLog: deps.agentLifecycleDeps.interactionLog }
                  : {}),
              },
              auditLogPath: deps.auditLogPath,
              dispositionLedgerPath: deps.dispositionLedgerPath,
              broadcastToAll: deps.broadcastToAll,
              isProviderPaused: isTaskProviderPaused,
              pauseStartTracker: deps.providerPausedStartTracker,
              // Same liveness + provider-reset seams as hung reclaim so hard
              // TTL does not strand #1896 auto-resume or kill sticky-but-live
              // agents (issue #2079 independent review).
              getLiveness: (task) => hungSuspectSignals(task).liveness,
              recordProviderPause: deps.recordProviderPause,
              isHoldingOpenPr: deps.isTaskHoldingOpenPr,
              metrics: deps.providerPausedOccupancyMetrics,
            },
            {
              ttlMs:
                deps.getProviderPausedHardTtlMs?.()
                ?? DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS,
              softTtlMs:
                deps.getProviderPausedSoftTtlMs?.()
                ?? DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS,
              capacityAllowsEarlyReclaim,
            },
          );
        } catch (err) {
          console.warn(
            '[liveness] provider_paused hard-TTL reclaim threw:',
            err instanceof Error ? err.message : err,
          );
        }

        if (deps.providerPausedOccupancyAlerter && providerPausedTtlResult) {
          try {
            deps.providerPausedOccupancyAlerter.evaluate({
              occupancyCount: providerPausedTtlResult.occupancy.count,
              oldestPauseAgeMs: providerPausedTtlResult.occupancy.oldestPauseAgeMs,
              reclaimedCount: providerPausedTtlResult.reclaimedTaskIds.length,
            });
          } catch (err) {
            console.warn(
              '[liveness] provider_paused occupancy alerter threw:',
              err instanceof Error ? err.message : err,
            );
          }
        }
      }

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

      // Schedule consecutiveFailures (issue #2353): reconcile() uses raw
      // TaskStore terminal transitions and bypasses agent-lifecycle
      // terminateTask/completeTask, so live session-death would never advance
      // the streak without this additive path. Terminated → cancelled (failure);
      // completed → completed (reset). Best-effort — never block the liveness tick.
      if (deps.scheduleService) {
        for (const id of result.tasksCompleted) {
          try {
            await deps.scheduleService.recordTaskTerminalOutcome(id, 'completed');
          } catch (err) {
            console.warn(
              `[liveness] schedule terminal completed notify failed for ${id}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
        for (const id of result.tasksTerminated) {
          try {
            await deps.scheduleService.recordTaskTerminalOutcome(id, 'cancelled');
          } catch (err) {
            console.warn(
              `[liveness] schedule terminal cancelled notify failed for ${id}:`,
              err instanceof Error ? err.message : err,
            );
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
        || finishedAwaitingAckTtlResult.autoCompletedTaskIds.length > 0
        || hungSuspectTtlResult.reclaimedTaskIds.length > 0
        || (providerPausedTtlResult?.reclaimedTaskIds.length ?? 0) > 0
        || orphanLoopsFailed > 0
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
        broadcastDashboardSnapshot(deps);
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
        broadcastDashboardSnapshot(deps);
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

  // --- Mid-process server.log size-cap rotation (issue #1991), ON by default ---
  // Prod launches redirect stdout/stderr to ~/.kookr/server.log; without a
  // mid-process rotate that file grows without bound between restarts. When
  // over threshold we rename generations (same scheme as prod-restart) and
  // freopen stdio onto a fresh file so subsequent writes are not lost.
  // Disable with KOOKR_SERVER_LOG_MAX_BYTES=0, KOOKR_LOG_GENERATIONS=0, or
  // KOOKR_SERVER_LOG_ROTATE_INTERVAL_MS=0.
  let serverLogRotationInterval: ReturnType<typeof setInterval> | null = null;
  const serverLogRotation = deps.serverLogRotation;
  if (
    serverLogRotation
    && serverLogRotation.intervalMs > 0
    && serverLogRotation.maxBytes > 0
    && serverLogRotation.generations > 0
  ) {
    const intervalMs = serverLogRotation.intervalMs;
    console.log(
      `[server-log-rotation] size-cap check every ${intervalMs}ms ` +
        `(maxBytes=${serverLogRotation.maxBytes}, generations=${serverLogRotation.generations}, ` +
        `path=${serverLogRotation.logPath})`,
    );
    timerHealth?.register('serverLogRotation', intervalMs);
    serverLogRotationInterval = setInterval(() => {
      // Disk-growth control is operational hygiene, not a critical control loop
      // — skip under event-loop pressure like the other non-critical timers.
      if (shouldSkipNonCriticalLifecycleTick(nonCriticalTickPause, 'serverLogRotation')) return;
      timerHealth?.recordFire('serverLogRotation', intervalMs);
      const run = serverLogRotation.run ?? runServerLogRotationTick;
      run(serverLogRotation);
    }, intervalMs);
  }

  // --- Relay-orphan sweep (issue #1723 / #1885), ON by default ---
  // Reaps leaked `relay/server.ts` processes whose task worktree no longer
  // exists OR which carry the test-spawn marker (#1885) — the always-on backstop
  // for the die-with-parent watchdog. Enabled by default (1h); set
  // KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS=0 to disable. Production-safe: a live
  // relay is never worktree-gone nor test-spawned, so it is never selected.
  let relayOrphanSweepInterval: ReturnType<typeof setInterval> | null = null;
  let relayOrphanSweepStartupTimer: ReturnType<typeof setTimeout> | null = null;
  const relayOrphanSweep = deps.relayOrphanSweep;
  if (relayOrphanSweep && relayOrphanSweep.intervalHours > 0) {
    const intervalMs = relayOrphanSweep.intervalHours * 60 * 60 * 1000;
    console.log(
      `[relay-orphan-sweep] scheduled sweep enabled every ${relayOrphanSweep.intervalHours}h`,
    );
    timerHealth?.register('relayOrphanSweep', intervalMs);
    // Startup reclaim: a long-lived daemon may already be carrying a night's
    // worth of orphans (#1885 was found at 29 / ~1.5 GB). Run one sweep shortly
    // after boot — deferred off the startup I/O spike — so the accumulated leak
    // is cleared without waiting a full interval or a restart.
    relayOrphanSweepStartupTimer = setTimeout(() => {
      if (shouldSkipNonCriticalLifecycleTick(nonCriticalTickPause, 'relayOrphanSweep')) return;
      void runScheduledRelayOrphanSweep(relayOrphanSweep);
    }, RELAY_ORPHAN_SWEEP_STARTUP_DELAY_MS);
    relayOrphanSweepStartupTimer.unref?.();
    relayOrphanSweepInterval = setInterval(() => {
      if (shouldSkipNonCriticalLifecycleTick(nonCriticalTickPause, 'relayOrphanSweep')) return;
      timerHealth?.recordFire('relayOrphanSweep', intervalMs);
      void runScheduledRelayOrphanSweep(relayOrphanSweep);
    }, intervalMs);
  }

  // --- Host-stale dtach reaper (issues #2356, #2384), ON by default (5m) ---
  // Reclaims process-table kookr-dtach masters outside the session reaper
  // (missing_socket_aged always selects, rate-limited). Fail-closed selection;
  // dry-run/rate-limit via env.
  let hostStaleDtachReapInterval: ReturnType<typeof setInterval> | null = null;
  let hostStaleDtachReapStartupTimer: ReturnType<typeof setTimeout> | null = null;
  const hostStaleDtachReaper = deps.hostStaleDtachReaper;
  if (hostStaleDtachReaper && hostStaleDtachReaper.intervalMinutes > 0) {
    const intervalMs = hostStaleDtachReaper.intervalMinutes * 60 * 1000;
    console.log(
      `[host-stale-dtach-reaper] scheduled sweep enabled every ${hostStaleDtachReaper.intervalMinutes}m`,
    );
    timerHealth?.register('hostStaleDtachReap', intervalMs);
    hostStaleDtachReapStartupTimer = setTimeout(() => {
      if (shouldSkipNonCriticalLifecycleTick(nonCriticalTickPause, 'hostStaleDtachReap')) return;
      void runScheduledHostStaleDtachReap(hostStaleDtachReaper.service);
    }, HOST_STALE_DTACH_REAP_STARTUP_DELAY_MS);
    hostStaleDtachReapStartupTimer.unref?.();
    hostStaleDtachReapInterval = setInterval(() => {
      if (shouldSkipNonCriticalLifecycleTick(nonCriticalTickPause, 'hostStaleDtachReap')) return;
      timerHealth?.recordFire('hostStaleDtachReap', intervalMs);
      void runScheduledHostStaleDtachReap(hostStaleDtachReaper.service);
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

  // --- Deploy-convergence controller (issue #2226), optional ---
  // In-process auto-advance + residual page so merge→prod does not depend on
  // a manually registered agent schedule (the 2026-08-11 stall: schedule
  // missing, behindCount≥1, deploying=false, health green). maybeRun() never
  // throws and self-gates pile-up/cadence.
  let deployConvergenceInterval: ReturnType<typeof setInterval> | null = null;
  const deployConvergenceController = deps.deployConvergenceController;
  if (deployConvergenceController) {
    const intervalMs = deployConvergenceController.hostIntervalMs;
    console.log(
      `[deploy-convergence] controller enabled (every ${Math.round(intervalMs / 60_000)}m; ` +
        'act on DIVERGENT past grace + residual page when behind+idle)',
    );
    timerHealth?.register('deployConvergence', intervalMs);
    deployConvergenceInterval = setInterval(() => {
      if (shouldSkipNonCriticalLifecycleTick(nonCriticalTickPause, 'deployConvergence')) return;
      timerHealth?.recordFire('deployConvergence', intervalMs);
      void deployConvergenceController.maybeRun();
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
    serverLogRotationInterval,
    prodSmokeTickInterval,
    deployLagDetectorInterval,
    deployConvergenceInterval,
    relayOrphanSweepInterval,
    relayOrphanSweepStartupTimer,
    hostStaleDtachReapInterval,
    hostStaleDtachReapStartupTimer,
    reflectWorktreeSweepInterval,
  };
}

/** Thin adapter so the timer config shape maps cleanly onto the rotation module. */
export function runServerLogRotationTick(config: ServerLogRotationScheduleConfig): void {
  const rotationConfig: ServerLogRotationConfig = {
    logPath: config.logPath,
    maxBytes: config.maxBytes,
    generations: config.generations,
  };
  runScheduledServerLogRotation(rotationConfig);
}


export function clearAllTimers(handles: TimerHandles): void {
  clearInterval(handles.watchdogInterval);
  clearInterval(handles.tokenScanInterval);
  clearInterval(handles.livenessInterval);
  clearInterval(handles.snoozeExpiryInterval);
  clearInterval(handles.saveInterval);
  if (handles.quotaPollTimeout) clearTimeout(handles.quotaPollTimeout);
  if (handles.maintenancePruneInterval) clearInterval(handles.maintenancePruneInterval);
  if (handles.serverLogRotationInterval) clearInterval(handles.serverLogRotationInterval);
  if (handles.prodSmokeTickInterval) clearInterval(handles.prodSmokeTickInterval);
  if (handles.deployLagDetectorInterval) clearInterval(handles.deployLagDetectorInterval);
  if (handles.deployConvergenceInterval) clearInterval(handles.deployConvergenceInterval);
  if (handles.relayOrphanSweepInterval) clearInterval(handles.relayOrphanSweepInterval);
  if (handles.relayOrphanSweepStartupTimer) clearTimeout(handles.relayOrphanSweepStartupTimer);
  if (handles.hostStaleDtachReapInterval) clearInterval(handles.hostStaleDtachReapInterval);
  if (handles.hostStaleDtachReapStartupTimer) clearTimeout(handles.hostStaleDtachReapStartupTimer);
  if (handles.reflectWorktreeSweepInterval) clearInterval(handles.reflectWorktreeSweepInterval);
}
