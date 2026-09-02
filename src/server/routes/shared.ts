import type { TaskStore } from '../../core/tasks.js';
import type { Monitor } from '../../core/monitor.js';
import type { AttentionQueue } from '../../core/attention-queue.js';
import type { AgentAdapter } from '../../adapters/agent-adapter.js';
import type { TerminalBackend } from '../../adapters/terminal-backend.js';
import type { HookFileWatcher } from '../hook-watcher.js';
import type { HookIngestion } from '../hook-ingestion.js';
import type { ActivityLedger } from '../../core/activity-ledger.js';
import type { Watchdog } from '../../core/watchdog.js';
import type { DeferredInteractionLogWriter } from '../../core/interaction-log.js';
import type { GitHubScannerService } from '../../core/github-scanner-service.js';
import type { GitHubStateStore } from '../../core/github-state-store.js';
import type { BuildInfo } from '../../core/build-info.js';
import type { ServerMessage, SystemResourceStatus } from '../../shared/contracts/messages.js';
import type {
  AdmissionControlConfig,
  DataDirectoryDiskAdmissionTracker,
  DiskAdmissionConfig,
} from '../task-admission.js';
import type { ShadowDetectorRegistry } from '../../core/shadow-detector.js';
import type { HttpPushTracker } from '../../core/http-push-tracker.js';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { ProjectSidebarStore } from '../../core/project-sidebar-store.js';
import type { OssAttemptStore } from '../../core/oss-attempt-store.js';
import type { LedgerAnalytics } from '../../core/ledger-analytics.js';
import type { OssRefresher } from '../oss-refresh.js';
import type { SkillDiscoveryStateHolder } from '../../core/skill-tracked-repo-discovery.js';
import type { PrLessonsStateHolder } from '../../core/pr-lessons-discovery.js';
import type { KookrSettings } from '../../core/settings-store.js';
import type { IdempotencyLedger } from '../../core/idempotency-ledger.js';
import type { CircuitBreakerRegistry } from '../../core/circuit-breaker.js';
import type { SnoozeSuppressionTracker } from '../../core/snooze-suppression.js';
import type { ScheduleRunner } from '../schedule-runner.js';
import type { ScheduleService } from '../schedule-service.js';
import type { LaunchServiceDeps } from '../launch-service.js';
import type { DiagnosticRunner } from '../diagnostic-runner.js';
import type { StartupRecoverySummary } from '../startup-recovery.js';
import type { RalphCycler } from '../../core/ralph-cycler.js';
import type { TokenTracker } from '../../core/token-tracker.js';
import type { RalphLoopService } from '../ralph-loop-service.js';
import type { WorktreeRegistry } from '../../adapters/git-worktree-registry.js';
import type { RemoteShareDeps } from '../remote-share-deps.js';
import type { RelayConnectionManager } from '../relay-connection-manager.js';
import type { ContactShareReadModel } from '../../core/contact-share.js';
import type { LlmClient } from '../../core/llm-client.js';
import type { FindingEvidenceReviewSampler } from '../finding-evidence-review-sampler.js';
import type { CollaborationDiagnostics } from '../../shared/contracts/collaboration-profile.js';
import type { CoordinatorSuppressionRegistry } from '../coordinator/suppression-store.js';
import type { DrainController } from '../drain-state.js';
import type { OperationalAlertHistorySnapshot } from '../resource-status-service.js';
import type { ApiAuthConfig } from '../auth.js';
import type { ViewerGrantStore } from '../../core/viewer-grants.js';
import type { ViewerConnectionRegistry } from '../viewer-connection-registry.js';
import type { CollaborationAuditLog } from '../collaboration-audit-log.js';
import type { AuditSinkMetricsSnapshot } from '../prometheus-exposition.js';
import type { SessionAuthConfig } from '../auth-session.js';
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import type { RequestDurationMetrics } from '../request-duration-metrics.js';
import type { ControlPlaneLatencyMetrics } from '../control-plane-latency-metrics.js';
import type { HotPathSampler } from '../../core/hot-path-sampler.js';
import type { TerminalInputRttMetrics } from '../terminal-input-rtt-metrics.js';
import type { TaskSaveMetricsRecorder } from '../../core/task-save-metrics.js';
import type { TaskStateSaveSchedulerLike } from '../task-state-save-scheduler.js';
import type { TerminalInputCoordinator } from '../terminal-input-coordinator.js';
import type { UserInputDeliveryService } from '../user-input-delivery-service.js';
import type { SessionHealthService } from '../session-health-service.js';
import type { DeliveryTraceReader } from '../../core/delivery-trace.js';
import type { TelegramTaskOutcome } from '../../shared/contracts/telegram.js';
import type { EnvironmentBlockerRegistry } from '../../core/environment-blocker-registry.js';
import type { LessonYieldHealthCache } from '../lesson-yield-health-cache.js';
import type { HealthBodyCacheStats } from '../health-body-cache-stats.js';
export type { RemoteShareDeps } from '../remote-share-deps.js';

/**
 * Narrower dependency surface for task CRUD/lifecycle routes (GET/POST/DELETE
 * /api/tasks, PATCH /api/tasks/:id/{name,edges}, GET /api/playbooks). The
 * PATCH /edges handler rebroadcasts the snapshot with coordinator state, so
 * `coordinatorSuppressions` + `kookrDir` appear here too.
 */
export interface TaskRouteDeps {
  taskStore: TaskStore;
  monitor: Monitor;
  /**
   * Releases issue-ownership claims on REST-driven terminal transitions
   * (RFC rfc-issue-ownership-lock R8). Regression: the field-by-field
   * getLifecycleDeps() below silently dropped claim release on
   * POST /api/tasks/:id/complete — caught by PR-1a dogfooding (the orphan
   * backstop absorbed it, but R8 must fire on every terminal path).
   */
  issueClaimRegistry?: import('../agent-lifecycle.js').LifecycleDeps['issueClaimRegistry'];
  /**
   * In-memory GitHub ref store. Threaded into getLifecycleDeps so REST
   * delete/clear drops finished-task rows (issue #2485). Optional so
   * existing route tests can omit it.
   */
  githubStateStore?: import('../agent-lifecycle.js').LifecycleDeps['githubStateStore'];
  queue?: AttentionQueue;
  adapter: AgentAdapter;
  hookWatcher: HookFileWatcher;
  watchdog: Watchdog;
  serverCwd: string;
  broadcastToAll: (msg: ServerMessage) => void;
  hookIngestion?: HookIngestion;
  shadowRegistry?: ShadowDetectorRegistry;
  activityLedger?: ActivityLedger;
  launchServiceDeps: LaunchServiceDeps;
  /**
   * Terminal backend for live session-liveness probes (RFC:
   * rfc-cross-agent-task-migration). Used by the migrate endpoint to re-check
   * that an interrupted task is not actually running before continuing it under
   * a new agent. Optional; when absent the probe conservatively reports no live
   * session (terminated/cancelled candidates have none anyway).
   */
  terminalBackend?: TerminalBackend;
  /**
   * Latest already-sampled host/server resource snapshot (issue #1590). The
   * `POST /api/tasks` admission gate reads
   * `server.eventLoopDelayP95Ms` from it to fast-fail with 503 when the event
   * loop is saturated, and `host.dataDirectory` for the disk-critical gate
   * (issue #1992). Flows through from the full RouteDeps; tests may omit it
   * (absence fails open — admission proceeds).
   */
  getLatestResourceStatus?: () => SystemResourceStatus | null;
  /**
   * Load-based admission thresholds (issue #1590). Falls back to
   * {@link readAdmissionControlConfigFromEnv} at route registration when
   * absent, so production picks up env config without explicit threading.
   */
  admissionControlConfig?: AdmissionControlConfig;
  /**
   * Data-directory free-space admission floors (issue #1992). Falls back to
   * {@link readDiskAdmissionConfigFromEnv} at route registration when absent.
   */
  diskAdmissionConfig?: DiskAdmissionConfig;
  /**
   * Sustain-sample tracker for the disk-critical gate (issue #1992). Production
   * feeds it from every resource-status tick so consecutive breaches are
   * measured in sampler ticks, not launch attempts. Tests may omit it — the
   * gate then fails closed on a single-sample breach when floors are known.
   */
  diskAdmissionTracker?: DataDirectoryDiskAdmissionTracker;
  suppressionTracker?: SnoozeSuppressionTracker;
  tasksFile?: string;
  /** Coalesced task-state saver for bursty mutation paths. */
  taskStateSaveScheduler?: TaskStateSaveSchedulerLike;
  /** Optional remote-chat back-channel for task signal/lifecycle outcomes. */
  onTaskOutcome?: (taskId: string, outcome: TelegramTaskOutcome) => void;
  /** Live default for task completion worktree cleanup. */
  getCleanupWorktreeOnComplete?: () => boolean;
  /**
   * Live getter for the completion-ready auto-close delay, in milliseconds.
   * Used by `POST /api/tasks/:id/signal` to report an accurate
   * `autoCloseAfterMs` when an opted-in task raises `completion_ready`. Falls
   * back to {@link DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS} when absent.
   */
  getAutoCloseCompletionReadyDelayMs?: () => number;
  /**
   * Live getter for the completion-ready TTL escalation threshold, in
   * milliseconds (issue #1526 Phase A). Used by `GET
   * /api/tasks/completion-ready/stale` so the reported `canAutoClose` reflects
   * TTL-eligible ask-first tasks, not just opted-in ones.
   */
  getCompletionReadyTtlMs?: () => number;
  kookrDir?: string;
  coordinatorSuppressions?: CoordinatorSuppressionRegistry;
  /**
   * Optional lifecycle collaborators consumed by `POST /api/tasks/:id/complete`
   * (issue #691). They flow through from the full RouteDeps at runtime; the
   * lifecycle `completeTask` tolerates their absence, so tests may omit them.
   */
  interactionLog?: DeferredInteractionLogWriter;
  scheduleService?: ScheduleService;
  tokenTracker?: TokenTracker;
  /**
   * Durable terminal-tail store for GET /api/tasks/:id/tail and lifecycle
   * capture (rfc-task-tail-retrieval).
   */
  taskTailStore?: import('../../core/task-tail-store.js').TaskTailStore;
}

/** Narrower deps for coordinator suppression / acknowledgement / mark-prior-done routes. */
export interface CoordinatorRouteDeps {
  taskStore: TaskStore;
  monitor: Monitor;
  queue?: AttentionQueue;
  adapter: AgentAdapter;
  hookWatcher: HookFileWatcher;
  watchdog: Watchdog;
  interactionLog: DeferredInteractionLogWriter;
  githubScanner: GitHubScannerService;
  githubStateStore: GitHubStateStore;
  serverCwd: string;
  kookrDir?: string;
  broadcastToAll: (msg: ServerMessage) => void;
  shadowRegistry?: ShadowDetectorRegistry;
  hookIngestion?: HookIngestion;
  suppressionTracker?: SnoozeSuppressionTracker;
  coordinatorSuppressions?: CoordinatorSuppressionRegistry;
}

/** Narrower deps for direct agent input + edit-event + hook-settings diagnostics routes. */
export interface AgentRouteDeps {
  monitor: Monitor;
  adapter: AgentAdapter;
  interactionLog: DeferredInteractionLogWriter;
  serverCwd: string;
  serverStartedAt: string;
  hookIngestion?: HookIngestion;
  broadcastToAll: (msg: ServerMessage) => void;
  /**
   * Optional task store reference used to populate `taskRelations` on
   * snapshots broadcast from these routes (#601). When absent the relation
   * field is omitted from this broadcast; the next snapshot from any other
   * path will re-populate it.
   */
  taskStore?: TaskStore;
}

/** Deps for the file-viewer routes (GET /api/files/meta, /api/files/raw).
 *  `worktreeRegistry` widens the allow-list beyond `serverCwd` so files inside
 *  active agent worktrees are viewable; absent in tests -> serverCwd only. */
export interface FileRouteDeps {
  serverCwd: string;
  serverStartedAt: string;
  worktreeRegistry?: Pick<WorktreeRegistry, 'all'>;
}

/** Narrower deps for the read-only /api/cost-comparison telemetry route. */
export interface CostComparisonRouteDeps {
  taskStore: TaskStore;
  serverCwd: string;
  tokenTracker?: TokenTracker;
  tasksFile?: string;
}

/** Narrower deps for the read-only /api/outcome-ledger scoreboard route. */
export interface OutcomeLedgerRouteDeps {
  taskStore: TaskStore;
  tokenTracker?: TokenTracker;
  tasksFile?: string;
  interactionLog?: DeferredInteractionLogWriter;
}

/** Narrower deps for the typed task-relation graph routes (issue #599). */
export interface TaskRelationsRouteDeps {
  taskStore: TaskStore;
  queue?: AttentionQueue;
  suppressionTracker?: SnoozeSuppressionTracker;
  tasksFile?: string;
  /** Coalesced task-state saver for bursty mutation paths. */
  taskStateSaveScheduler?: TaskStateSaveSchedulerLike;
}

/**
 * Owner share control-surface dependencies (#808). Bundles the viewer-grant
 * store, the connection registry (for the live viewer roster + the health
 * sweep block), and the collaboration audit log. Present only when the
 * shared-view feature is wired (a non-loopback bind); absent ⇒ the share routes
 * report `share-feature-disabled` and `/api/health` omits the
 * `viewerBroadcaster` block.
 */
export interface ViewerShareDeps {
  grantStore: ViewerGrantStore;
  registry: ViewerConnectionRegistry;
  auditLog: CollaborationAuditLog;
}

/**
 * Narrower deps for the deploy / toolkit / plugin maintenance routes
 * (`/api/deploy/*`, issue #1072). They locate the production worktree, run
 * plugin maintenance, report the running port, and (when wired) fan out a
 * pre-blackout `deployLifecycle` WebSocket notice. They still do not touch
 * task or monitor state. Keeping the slice exact prevents the deploy module
 * from reaching across unrelated server subsystems.
 */
export interface DeployRouteDeps {
  serverCwd: string;
  /** Port this server bound to. Surfaced via `/api/deploy/status` so the dashboard can detect dev (non-prod) instances and avoid silently triggering prod deploys. */
  serverPort: number;
  /** Claude Code binary used for marketplace plugin maintenance. Defaults to KOOKR_AGENT_BIN or `claude`. */
  pluginUpdateBin?: string;
  /**
   * Worktree registry — surfaced to deploy-routes so `resolveProdDir` can
   * locate the production runtime via the `.kookr-protected` marker rather
   * than the legacy `kookr-prod` basename heuristic. Optional so tests and
   * non-server callers can omit it; absent registry falls back to the legacy
   * sibling-path resolver.
   */
  worktreeRegistry?: Pick<WorktreeRegistry, 'all'>;
  /**
   * Test seam for routes that inspect or update user-global Claude assets.
   * Production defaults to os.homedir().
   */
  hookHomeDir?: string;
  /**
   * Stable Kookr state directory (normally `~/.kookr`, or `~/.kookr-<port>`
   * for non-prod ports). Used to read `last-restart-metrics.json` written by
   * `scripts/prod-restart.sh` (issue #1973). Optional — when omitted, the
   * deploy status route derives the path from `serverPort` + `homedir()`.
   */
  kookrDir?: string;
  /**
   * Dashboard WebSocket fan-out (issue #1980). When present, a successful
   * `POST /api/deploy/trigger` broadcasts `deployLifecycle` before spawning
   * `prod-update` so connected clients learn about the intentional blackout
   * while still connected. Optional so unit tests can omit it.
   */
  broadcastToAll?: (msg: ServerMessage) => void;
}

export interface RouteDeps {
  /**
   * Issue-ownership claim route deps (RFC rfc-issue-ownership-lock).
   * Absent when KOOKR_ISSUE_CLAIMS is off — the routes are then not
   * registered, so clients get the same 404-as-pre-lock behavior as an
   * old server (R7/R26).
   */
  issueClaims?: import('./issue-claim-routes.js').IssueClaimRouteDeps;
  /** Threaded to TaskRouteDeps so REST terminal transitions release claims (R8). */
  issueClaimRegistry?: import('../agent-lifecycle.js').LifecycleDeps['issueClaimRegistry'];
  /** Threaded to TaskRouteDeps so REST task signals can notify remote-chat origins. */
  onTaskOutcome?: (taskId: string, outcome: TelegramTaskOutcome) => void;
  /**
   * Optional pre-built pipeline-starvation service (issue #1715 / PR2). When
   * set, routes reuse it so bootstrap can also wire terminal reconcile on the
   * same instance. When absent, createRoutes constructs one from launch deps.
   */
  pipelineStarvation?: import('../pipeline-starvation-service.js').PipelineStarvationService;
  taskStore: TaskStore;
  monitor: Monitor;
  queue: AttentionQueue;
  adapter: AgentAdapter;
  hookWatcher: HookFileWatcher;
  watchdog: Watchdog;
  interactionLog: DeferredInteractionLogWriter;
  githubScanner: GitHubScannerService;
  githubStateStore: GitHubStateStore;
  buildInfo: BuildInfo;
  serverStartedAt: string;
  serverCwd: string;
  /** Port this server bound to. Surfaced via `/api/deploy/status` so the dashboard can detect dev (non-prod) instances and avoid silently triggering prod deploys. */
  serverPort: number;
  /** Claude Code binary used for marketplace plugin maintenance. Defaults to KOOKR_AGENT_BIN or `claude`. */
  pluginUpdateBin?: string;
  /** Stable Kookr state directory, normally `~/.kookr`. */
  kookrDir: string;
  /**
   * Optional clock for the GET `/api/health` body-cache TTL (issue #2429).
   * Production omits this and uses `Date.now()`. Tests inject a controllable
   * clock so expiry assertions do not depend on real time or leaked fake timers.
   */
  nowMs?: () => number;
  frontendDir: string;
  broadcastToAll: (msg: ServerMessage) => void;
  /**
   * Emit an operational alert on every surface the server wires: dashboard
   * broadcast, operator-signal outbox, ops-status card, and the durable
   * `operational-alerts.jsonl`. Optional so lightweight route wirings still
   * work; consumers degrade to `broadcastToAll` and say so.
   */
  emitOperationalAlert?: (alert: Extract<ServerMessage, { type: 'alert' }>) => void;
  /**
   * Coalesced full-snapshot rebuild request from the event pipeline (#704 / #2096).
   * HTTP mutate handlers (Ralph, etc.) should call this instead of building
   * `createSnapshotMessage` + `broadcastToAll` synchronously. Optional so
   * lightweight unit tests can omit it; production bootstrap always wires it.
   */
  requestSnapshotBroadcast?: () => void;
  shadowRegistry?: ShadowDetectorRegistry;
  httpPushTracker?: HttpPushTracker;
  /**
   * Dedup + active-delivery service used by the file watcher and the
   * `/api/hook-event/:sessionId` HTTP route. When present, the HTTP route
   * actively injects payloads into the monitor; otherwise it falls back to
   * timing-only behavior. See rfc-activity-log-reliability §5.
   */
  hookIngestion?: HookIngestion;
  /**
   * Durable per-session activity ledger used by
   * `/api/tasks/:taskId/activity-diagnostics`. Absence collapses the
   * diagnostics endpoint to in-memory counters from HookIngestion.
   * See rfc-activity-log-reliability §7–§8.
   */
  activityLedger?: ActivityLedger;
  /**
   * Durable terminal-tail store (rfc-task-tail-retrieval). Used by
   * GET /api/tasks/:id/tail and as a fallback for GET /api/capture/:sessionId.
   */
  taskTailStore?: import('../../core/task-tail-store.js').TaskTailStore;
  launchServiceDeps: LaunchServiceDeps;
  /** Durable idempotency retention gauges for health and Prometheus. */
  idempotencyLedger?: Pick<IdempotencyLedger, 'getMetrics'>;
  /**
   * Shared Grok session-auth availability cache (issue #2537). Wired so the
   * GET /api/grok-auth-status preflight reads the SAME cached verdict the launch
   * path reads, keeping `launchWouldRefuse` from diverging within the cache TTL.
   */
  grokAuthAvailability?: Pick<
    import('../../adapters/grok-auth-availability.js').GrokAuthAvailabilityCache,
    'ensureFresh'
  >;
  sttUrl?: string;
  /** Optional Pocket TTS HTTP URL — when set, the speak-finding route is reachable. */
  ttsUrl?: string;
  /** Voice argument for Pocket TTS `/synthesize`. Defaults to the bundled Matilda voice. */
  ttsVoice?: string;
  /** Surgical kill-switch for the speak-finding feature. Defaults to true; set false via `KOOKR_SPEAK=false`. */
  speakFindingEnabled?: boolean;
  projectConfigStore?: ProjectConfigStore;
  projectSidebarStore?: ProjectSidebarStore;
  ossAttemptStore?: OssAttemptStore;
  ledgerAnalytics?: LedgerAnalytics;
  ossRefresher?: OssRefresher;
  /** Invoked after a mutation that may change the OSS attempt view. */
  broadcastOssAttempts?: () => void;
  getRegistryActiveRepos?: () => string[];
  skillDiscoveryState?: SkillDiscoveryStateHolder;
  prLessonsState?: PrLessonsStateHolder;
  getRegistryActiveProjects?: () => string[];
  /** Invoked after a mutation that may change project summaries. */
  broadcastProjectSummaries?: () => void;
  settings?: {
    get: () => KookrSettings;
    getLoadedFromDefaults: () => boolean;
    getLoadWarnings?: () => string[];
    /** Issue #2085: settings load failure that forced fail-closed SAFE MODE. */
    getLoadError?: () => string | undefined;
    update: (settings: KookrSettings) => Promise<string[]>;
  };
  /**
   * Shared `audit.jsonl` path (issue #1710 settings-mutation trail; also used
   * by task-lifecycle rows). Optional so lightweight test harnesses can omit it.
   */
  auditLogPath?: string;
  /** Live getter for the configured concurrency cap (settings.maxActiveTasks). */
  getMaxActiveTasks?: () => number;
  /**
   * Latest Anthropic quota snapshot (issue #2672 Phase B). Used to project the
   * default agent's quota utilization onto `/api/health` and the orchestration
   * status surface. Absent in lightweight test harnesses.
   */
  getQuotaStatus?: () => import('../../core/quota-types.js').QuotaStatus | null;
  /** Live getter for the configured default agent selection (issue #2672). */
  getDefaultAgentType?: () => import('../../shared/contracts/agent-types.js').AgentSelection;
  /** Live default for task completion worktree cleanup. */
  getCleanupWorktreeOnComplete?: () => boolean;
  /** Live getter for the completion-ready auto-close delay, in milliseconds. */
  getAutoCloseCompletionReadyDelayMs?: () => number;
  /** Live getter for the completion-ready TTL escalation threshold, in milliseconds (issue #1526 Phase A). */
  getCompletionReadyTtlMs?: () => number;
  circuitBreakerRegistry?: CircuitBreakerRegistry;
  suppressionTracker?: SnoozeSuppressionTracker;
  scheduleService?: ScheduleService;
  scheduleRunner?: ScheduleRunner;
  /** Coalesced task-state saver for bursty mutation paths. */
  taskStateSaveScheduler?: TaskStateSaveSchedulerLike;
  diagnosticRunner?: DiagnosticRunner;
  /**
   * V8 terminal backend — exposed to routes so `/api/health` can report its
   * stats (attached sessions, pending writers, last error, etc.).
   */
  terminalBackend?: TerminalBackend;
  /**
   * Orphan/terminal-task session reaper (issue #1720). `/api/health` reads
   * only `getHealthSnapshot()` — a cheap in-memory read of counters the
   * reaper's own sweeps already computed, never a fresh scan on the request
   * path (issue #1553 lesson).
   */
  sessionReaper?: Pick<import('../session-reaper.js').SessionReaperService, 'getHealthSnapshot'>;
  /**
   * Host-stale dtach reaper (issue #2356). `/api/health` reads only
   * `getHealthSnapshot()` — last-sweep counters (reaped / skip reasons), never
   * a fresh `/proc` walk on the request path (issue #1553).
   */
  hostStaleDtachReaper?: Pick<
    import('../host-stale-dtach-reaper.js').HostStaleDtachReaperService,
    'getHealthSnapshot'
  >;
  /**
   * Payload-diet gauges (issue #2220 / #1526 Phase C). `/api/health` reads
   * only the slim `getPayloadDietStats()` snapshot — tracked/terminal task
   * counts plus last snapshot broadcast bytes. Must be a non-cloning store
   * walk (`viewTasks` / `countTasks`); never `listTasks()` on this path
   * (issue #1749). Absent in partial test harnesses ⇒ health omits the block.
   */
  getPayloadDietStats?: () => import('../maintenance-prune-schedule.js').PayloadDietStats;
  /**
   * Slim helper-LLM pause / storm snapshot for GET `/api/health` (issue #2641).
   * Production omits this and reads the process-wide in-memory pause map.
   * Tests inject a fixture so they do not mutate the global pause table.
   */
  getHelperLlmHealthSnapshot?: () => import('../../shared/contracts/diagnostic.js').HelperLlmHealthSnapshot;
  /**
   * Combined maintenance-prune gauges (issues #2344 emergency + #2345 schedule).
   * `/api/health` reads only the in-memory snapshot (schedule enabled/interval
   * + last-run counters, emergency edge counters) — never starts a prune on
   * the request path. Bootstrap always wires this so operators see
   * `enabled: false` when the interval is off. Absent in partial test
   * harnesses ⇒ health omits the `maintenancePrune` block.
   */
  getMaintenancePruneHealth?: () =>
    import('../maintenance-prune-schedule.js').MaintenancePruneHealthSnapshot | undefined;
  /**
   * Hook replay-checkpoint gauges (issue #2281). `/api/health` reads only the
   * slim `getReplayCheckpointStats()` snapshot — in-memory session count plus
   * `stat().size` for file bytes. Must never parse the (multi-MB) checkpoint
   * JSON on the request path. Absent in partial test harnesses ⇒ health omits
   * the block; returns `null` when checkpoints are disabled on the watcher.
   */
  getHookReplayCheckpointStats?: () => import('../hook-watcher.js').HookReplayCheckpointStats | null;
  /**
   * Non-critical timer pause gate (issue #1785). `/api/health` and `/metrics`
   * read only `getSnapshot()` — in-memory pause counter + last sample; never
   * a fresh event-loop measurement on the request path.
   */
  nonCriticalTimerPause?: Pick<
    import('../non-critical-timer-pause.js').NonCriticalTimerPauseGate,
    'getSnapshot'
  >;
  /**
   * Snapshot rebuild shed metrics (issue #1775). `/api/health` and `/metrics`
   * read only `getSnapshotShedMetrics()` — in-memory counter + last sample.
   */
  snapshotShed?: {
    getSnapshotShedMetrics: () => import('../event-pipeline.js').SnapshotShedMetricsSnapshot;
  };
  /**
   * finishedAwaitingAck TTL reclaim counter (issue #1884). `/metrics` reads
   * only `getSnapshot()` — an in-memory cumulative count the liveness-tick
   * sweep increments; never a fresh scan on the request path.
   */
  finishedAwaitingAckTtlReclaimMetrics?: Pick<
    import('../finished-awaiting-ack-ttl-sweep.js').FinishedAwaitingAckTtlReclaimMetrics,
    'getSnapshot'
  >;
  /**
   * hungSuspect TTL reclaim counter (issues #1935, #1989). `/metrics` and
   * `/api/health` read only `getSnapshot()` — same in-memory cumulative
   * convention as the FAA reclaim; never a fresh reclaim scan on the request path.
   */
  hungSuspectTtlReclaimMetrics?: Pick<
    import('../hung-suspect-ttl-sweep.js').HungSuspectTtlReclaimMetrics,
    'getSnapshot'
  >;
  /**
   * open-PR fail-safe reason breakdown (issue #2225). `/api/health` reads
   * only `getSnapshot()` — cumulative hold reasons + sample taskIds/PR
   * linkage so operators can see *why* open_pr_failsafe dominates.
   */
  openPrFailsafeReasonMetrics?: Pick<
    import('../../core/open-pr-hold.js').OpenPrFailsafeReasonMetrics,
    'getSnapshot'
  >;
  /**
   * provider_paused occupancy + hard-TTL reclaim counters (issue #2079).
   * `/api/health` and `/metrics` read only `getSnapshot()` — live occupancy
   * plus process-lifetime reclaim counters; never a fresh scan on the request path.
   */
  providerPausedOccupancyMetrics?: Pick<
    import('../provider-paused-ttl-sweep.js').ProviderPausedOccupancyMetrics,
    'getSnapshot'
  >;
  /**
   * First-hook miss counter (issue #2036). `/metrics` and `/api/health` read
   * only `getSnapshot()` — process-lifetime cumulative count of post-spawn
   * sessions reaped for never emitting SessionStart / any agent hook.
   */
  firstHookMissMetrics?: Pick<
    import('../first-hook-deadline-sweep.js').FirstHookMissMetrics,
    'getSnapshot'
  >;
  /**
   * Watchdog sweep fairness counters (issue #2770). `/api/health.watchdogSweep`
   * and `/metrics` read only `getSnapshot()` — probe-timeout counters plus
   * last-sweep checked/skipped/duration and oldest-check age; never a fresh
   * sweep on the request path.
   */
  watchdogSweepMetrics?: Pick<
    import('../watchdog-sweep-metrics.js').WatchdogSweepMetrics,
    'getSnapshot'
  >;
  /**
   * Lesson-yield health cache (issues #1538, #1553, #1857). Diagnostics warms
   * it via bounded background scans; `/metrics` only calls `getCached24h()`
   * and never scans hook logs on the scrape path.
   */
  lessonYieldHealth?: LessonYieldHealthCache;
  /**
   * Process-scoped queue-feeder invent-class rollup (issue #2912). The
   * refresher scans on its own boot/timer cadence; `/api/health` calls only the
   * synchronous snapshot getter and never opens the decisions ledger.
   */
  inventPriorityHealth?: Pick<
    import('../invent-priority-health-refresher.js').InventPriorityHealthRefresher,
    'getSnapshot'
  >;
  /**
   * Shared `/api/health` body-cache timing gauges (issue #2497). Diagnostics
   * records the last assembly duration + land time; `/metrics` reads the same
   * instance via `snapshot()`. Absent in partial test harnesses ⇒ diagnostics
   * builds a private fallback (same pattern as lessonYieldHealth) and `/metrics`
   * simply omits the series.
   */
  healthBodyCacheStats?: HealthBodyCacheStats;
  /**
   * Schedules the #2492 stale-while-revalidate background health re-assembly off
   * the request path. Default is `setImmediate` so the refresh runs on a later
   * macrotask — after the expired body is returned and flushed — rather than
   * inline (assembleHealthBody has a large synchronous prefix). Injected in tests
   * for deterministic scheduling; production leaves it unset.
   */
  healthRefreshScheduler?: (task: () => void) => void;
  /**
   * Per-component budget (ms) for the disk-backed reads inside a health
   * assembly (issue #2798). A read slower than this degrades only its own block
   * and is named in `controlPlane.timedOutComponents`. Defaults to
   * HEALTH_COMPONENT_BUDGET_MS; injected in tests to drive a slow collector.
   */
  healthComponentBudgetMs?: number;
  /**
   * Cold-cache request budget (ms) for GET /api/health (issue #2798). If the
   * first assembly does not finish within this deadline, the request serves the
   * on-disk last-good snapshot (counts intact) or a typed `unavailable` body
   * instead of hanging. Defaults to HEALTH_ASSEMBLY_DEADLINE_MS; injected in
   * tests to force the deadline path deterministically.
   */
  healthAssemblyDeadlineMs?: number;
  /**
   * Last-good `/api/health` mirror writer (issue #2495). After each successful
   * assembly, diagnostics drops a redacted, size-capped copy to
   * `<kookrDir>/last-good-health.json` so an offline digest can still quote a
   * recent body when HTTP is dark. Absent ⇒ diagnostics builds a default writer
   * from `kookrDir` (or omits the mirror when `kookrDir` is unwired). Injected in
   * tests for a deterministic clock.
   */
  lastGoodHealthWriter?: import('../last-good-health.js').LastGoodHealthWriter;
  /**
   * Shared stale-process /proc summary cache (issues #1723, #2081, #2350).
   * Health reads via SWR `getSummary()`; session reaper + resource watchdog
   * share the same instance for pressure gauges so only one /proc walk runs
   * per TTL window. Absent in partial test harnesses ⇒ diagnostics builds a
   * private fallback cache (same pattern as lessonYieldHealth).
   */
  staleProcessSummaryCache?: import('../stale-dtach-pressure.js').StaleProcessSummaryCache;
  /**
   * Resource watchdog (issue #1724). `/api/health` reads only
   * `getHealthSnapshot({ staleDtachCount })` — last sample, last trigger,
   * throttle state, spawns-in-24h, cached OOM-baseline provenance, plus
   * `pressureWhileDisabled` from the already-cached staleProcesses.dtach gauge
   * (issue #2039) — never a fresh `/proc` scan on the request path (#1553).
   */
  resourceWatchdog?: Pick<
    import('../resource-watchdog-service.js').ResourceWatchdogService,
    'getHealthSnapshot'
  >;
  /**
   * Post-recovery queue-fill actuator decision (issue #2895). Health reads only
   * the service's bounded process-local snapshot; it never scans kick state,
   * audit files, schedules, or tasks on the request path.
   */
  postRecoveryService?: Pick<
    import('../post-recovery-service.js').PostRecoveryService,
    'getQueueFillHealthSnapshot'
  >;
  /**
   * Post-resume refill actuator (issue #2797). The resume route triggers one
   * bounded, idempotent refill pass on the paused→live edge; diagnostics reads
   * only the bounded process-local snapshot, never scanning state on the
   * request path.
   */
  postResumeRefillService?: Pick<
    import('../post-resume-refill-service.js').PostResumeRefillService,
    'getRefillHealthSnapshot' | 'onResumeTransition'
  >;
  /**
   * Hourly prod smoke tick (issues #1593, #2031). `/api/health` reads only
   * `getHealthSnapshot()` — a cheap artifact read projecting status /
   * consecutiveFailures / failingChecks; never re-runs smoke checks on the
   * request path (issue #1553 lesson). Absent when KOOKR_PROD_SMOKE_TICK is
   * disabled (dev/test, or explicitly off) so the block is omitted.
   */
  prodSmokeTick?: Pick<import('../prod-smoke-tick.js').ProdSmokeTick, 'getHealthSnapshot'>;
  /**
   * Optional systemd readiness/watchdog notifier (issues #2491, #2853).
   * `/api/health` reads only its cheap in-memory arming state (`enabled`,
   * `watchdogEnabled`, `watchdogIntervalMs`) to project the notifier block —
   * never a `systemctl` call or filesystem work on the request path. Absent
   * (tests, non-server hosts) ⇒ the block is omitted.
   */
  systemdNotifier?: Pick<
    import('../systemd-notify.js').SystemdNotifier,
    'enabled' | 'watchdogEnabled' | 'watchdogIntervalMs'
  >;
  /** Cross-signal terminal/session diagnostics for the dashboard and support capture. */
  sessionHealthService?: Pick<SessionHealthService, 'getDiagnostics'>;
  /**
   * Lifecycle-timer health (issue #1771). Cheap in-memory last-fired stamps
   * for each startLifecycleTimers loop. Absent ⇒ GET /api/diagnostics/timer-health
   * returns an empty loops list (tests / partial harnesses). `summary` feeds
   * the four-field GET /api/health block (issue #2636); when omitted the
   * route falls back to summarizing `snapshot()`.
   */
  timerHealth?: Pick<import('../../core/timer-health.js').TimerHealthRecorder, 'snapshot'>
    & Partial<Pick<import('../../core/timer-health.js').TimerHealthRecorder, 'summary'>>;
  /**
   * Result of the startup recovery phase; fetched once by the frontend on mount.
   * Carries the crash-recovery counts plus the optional `postRestartRecovery`
   * transport-verification block (issue #2839). `StartupRecoverySummary` extends
   * `CrashRecoveryResult`, so the health-counts projection still reads it.
   */
  startupRecoverySummary?: StartupRecoverySummary | null;
  /**
   * Live getter for the startup recovery summary (issue #1721). Preferred over
   * the static `startupRecoverySummary` field when recovery runs *after* the HTTP
   * listener binds — the summary is null until recovery finishes, then fills in.
   */
  getStartupRecoverySummary?: () => StartupRecoverySummary | null | undefined;
  /**
   * Startup-phase readiness gate (issue #1721). Critical on `/api/ready` until
   * post-listen recovery completes; also projected on `/api/health.startup`.
   */
  startupReadiness?: {
    toReadinessCheck(): {
      critical: true;
      ready: boolean;
      status: string;
      reason?: string;
      detail?: string;
    };
    getProgress(): {
      phase: string;
      detail: string;
      startedAt: string;
      listeningAt?: string;
      readyAt?: string;
    };
  };
  /**
   * Previous-process exit classification (issue #2790): whether the process
   * before this one shut down cleanly (`clean`), died to a crash / OOM /
   * SIGKILL (`dirty`), or cannot be determined (`unknown`). Computed at boot
   * from the persisted clean-shutdown marker, immutable for the process life,
   * and projected verbatim onto `/api/health.boot`. Absent ⇒ the block is
   * omitted (tests / partial harnesses).
   */
  bootStatus?: import('../boot-marker.js').BootClassification;
  /** Ralph iteration cycler — drives the loop state machine on Stop events. */
  ralphCycler?: RalphCycler;
  /** Token tracker — used by ralph routes to read cumulative cost. */
  tokenTracker?: TokenTracker;
  /**
   * Path to the live `~/.kookr/tasks.json`. Used by the cost-comparison route
   * to read sibling `tasks.json.daily.*` and `tasks.json.predelete.*` snapshots
   * (rfc-cost-comparison-coverage-and-perf.md §Change 1).
   */
  tasksFile?: string;
  /** Singleton Ralph loop orchestration service. */
  ralphLoopService: RalphLoopService;
  /**
   * Worktree registry — surfaced to deploy-routes so `resolveProdDir` can
   * locate the production runtime via the `.kookr-protected` marker rather
   * than the legacy `kookr-prod` basename heuristic. Optional so tests and
   * non-server callers can omit it; absent registry falls back to the legacy
   * sibling-path resolver.
   */
  worktreeRegistry?: Pick<WorktreeRegistry, 'all'>;
  /**
   * Test seam for routes that inspect or update user-global Claude assets.
   * Production defaults to os.homedir().
   */
  hookHomeDir?: string;
  /** Phase A0 easy connection sharing config — see {@link RemoteShareDeps}. */
  remoteShare?: RemoteShareDeps;
  /** Phase 1 Contact Share recipient inbox/read-model. Optional in tests. */
  contactShare?: ContactShareReadModel;
  /** Local-owner diagnostics for the private-network collaboration listener. */
  collaborationDiagnostics?: {
    get: () => Promise<CollaborationDiagnostics>;
  };
  /** Audit sinks surfaced on `/metrics`; intentionally omits raw last-failure reasons. */
  auditSinks?: {
    getAllSnapshots: () => AuditSinkMetricsSnapshot[];
  };
  /** Phase B runtime relay connection manager. */
  relayConnection?: RelayConnectionManager;
  /** Shared LLM client used by optional AI-assisted diagnostics routes. */
  llmClient?: LlmClient | null;
  /** Test seam for deterministic finding-evidence review input hashes. */
  findingEvidenceReviewHmacKey?: Buffer;
  /** Disabled-by-default M2 finding-evidence background sampler. */
  findingEvidenceReviewSampler?: Pick<FindingEvidenceReviewSampler, 'getStatus'>;
  /** Phase-2 umbrella-chain backstop health; spawning is independently mode-gated. */
  umbrellaChainAdvancer?: Pick<
    import('../use-cases/umbrella-chain-advancer.js').UmbrellaChainAdvancer,
    'getHealthSnapshot'
  >;
  /** Shared coordinator recommendation suppressions; routes may write it and snapshots read it. */
  coordinatorSuppressions?: CoordinatorSuppressionRegistry;
  /**
   * Durable environment-blocker registry (issue #1690). Backs the
   * `/api/environment-blockers` routes so a detected external blocker (e.g. a CI
   * billing limit) is registered once, consulted by other agents instead of
   * re-diagnosed, and escalated with exactly one human notification. Absent in
   * tests that build a partial RouteDeps ⇒ the routes are not registered.
   */
  environmentBlockerRegistry?: EnvironmentBlockerRegistry;
  /** Operator drain / resume state (issue #659). Absent disables the admin drain routes. */
  drainController?: DrainController;
  /** Recent operational-alert fire/recovery history for admin introspection. */
  getOperationalAlertHistory?: () => OperationalAlertHistorySnapshot;
  /**
   * Durable ops-status card writer (issue #1995). `/api/ready` records a
   * ready_degrade edge when the verdict flips not-ready so operators have a
   * last-known-good digest on disk when Discord is down. Absent in light tests.
   */
  opsStatusWriter?: {
    noteReadyVerdict(ready: boolean, detail?: string): Promise<unknown>;
  };
  /**
   * Latest already-sampled resource snapshot (issue #1590 / #1992). Threaded to
   * task-routes so the `POST /api/tasks` admission gates can read the sampled
   * event-loop delay p95 and data-directory free space without standing up
   * second monitors.
   */
  getLatestResourceStatus?: () => SystemResourceStatus | null;
  /**
   * Data-directory free-space admission floors (issue #1992). See TaskRouteDeps.
   */
  diskAdmissionConfig?: DiskAdmissionConfig;
  /**
   * Sustain-sample tracker for disk-critical launch admission (issue #1992).
   */
  diskAdmissionTracker?: DataDirectoryDiskAdmissionTracker;
  /** Shared reap-warning coordinator — surfaced read-only via /api/diagnostics/reap-warnings (RFC rfc-reap-grace-warning.md). */
  reapWarningCoordinator?: import('../../core/reap-warning-coordinator.js').ReapWarningCoordinator;
  /** FAA ack-path reap coordinator — surfaced read-only via /api/diagnostics/reap-warnings (issue #2170). */
  faaAckReapWarningCoordinator?: import('../../core/reap-warning-coordinator.js').ReapWarningCoordinator;
  /** FAA ack-path reaper counters — surfaced read-only via /api/diagnostics/reap-warnings (issue #2170). */
  faaAckReaperMetrics?: Pick<
    import('../finished-awaiting-ack-ack-reaper.js').FinishedAwaitingAckAckReaperMetrics,
    'getSnapshot'
  >;
  /** Optional snapshot enrichers used by admin-triggered drain/resume broadcasts. */
  terminalInputCoordinator?: TerminalInputCoordinator;
  userInputDeliveries?: UserInputDeliveryService;
  /**
   * Resolved API-token auth posture (issue #708). When `required` is true (the
   * server bound to a non-loopback host), a global middleware enforces a bearer
   * token on state-changing requests. Absent or `required: false` leaves the
   * loopback flow completely token-free.
  */
  apiAuth?: ApiAuthConfig;
  /**
   * Browser cookie-exchange + CSRF posture (issue #804). Present on a
   * non-loopback bind to enable `POST /api/auth/session` (fragment token →
   * HttpOnly cookie) and the owner-mutation CSRF guard. Absent ⇒ the session
   * route reports `session-feature-disabled` and no CSRF guard is installed.
   */
  sessionAuth?: SessionAuthConfig;
  /** Maximum JSON request body size accepted by the dashboard server API routes. */
  requestBodyLimitBytes?: number;
  /** In-memory per-route request duration aggregation exposed through diagnostics. */
  requestDurationMetrics?: RequestDurationMetrics;
  /**
   * Bounded latency + completion-status histogram for control-plane probe
   * surfaces (`/api/health`, health subroutes, `/api/ready`) that
   * {@link requestDurationMetrics} excludes (issue #2774). Exposed through
   * `GET /api/diagnostics/control-plane-latencies` and `/metrics`.
   */
  controlPlaneLatencyMetrics?: ControlPlaneLatencyMetrics;
  /**
   * Per-agent-type launch outcome counters (issue #1808) for
   * `GET /api/diagnostics/launch-outcomes`. Absent ⇒ empty snapshot.
   */
  launchOutcomeMetrics?: import('../../core/launch-outcome-metrics.js').LaunchOutcomeMetrics;
  /**
   * Per-agent-type boot-latency reliability signal (issue #1898) for
   * `GET /api/diagnostics/agent-boot-latency`, so an operator can see which
   * agents the round-robin failover is deprioritizing and why. Absent ⇒ empty
   * snapshot.
   */
  agentBootLatency?: Pick<import('../../core/agent-boot-latency.js').AgentBootLatencyMonitor, 'snapshot'>;
  /**
   * Hot-path timing sampler (issue #1781) backing GET
   * {@link HOT_PATHS_ROUTE}. Absent ⇒ the route falls back to the process-wide
   * singleton that instrumentation call sites write into; tests inject a
   * dedicated instance for deterministic assertions.
   */
  hotPathSampler?: Pick<HotPathSampler, 'snapshot'>;
  /**
   * Bounded ring histogram of terminal-input write round-trip latency
   * (keystroke enqueue → backend write-ack), exposed on `/metrics` and
   * `/api/diagnostics/terminal-input-rtt` (issue #1773).
   */
  terminalInputRttMetrics?: TerminalInputRttMetrics;
  /**
   * Optional override for the process-wide task-save timing ring (issue #1777).
   * Production leaves this unset and `/metrics` reads the global recorder.
   * Tests inject a private instance to avoid parallel-suite pollution.
   */
  taskSaveMetrics?: Pick<TaskSaveMetricsRecorder, 'snapshot'>;
  /** Bounded in-memory notification delivery trace exposed through diagnostics. */
  deliveryTrace?: DeliveryTraceReader;
  /** Optional outbound finding-webhook notifier; exposes delivery outcome counters on `/metrics`. */
  webhookNotifier?: {
    getDeliveryCounts: () => import('../../integrations/webhook/index.js').WebhookDeliveryCounts;
  };
  /**
   * Owner share control surface (#808): viewer-grant store + connection registry
   * + audit log backing `POST/GET /api/share/viewers`, the revoke route, and the
   * `/api/health` `viewerBroadcaster` block. Absent ⇒ the feature is disabled.
   */
  viewerShare?: ViewerShareDeps;
}

export function createJsonRequestBodyLimitMiddleware(limitBytes: number): MiddlewareHandler {
  return bodyLimit({
    maxSize: limitBytes,
    onError: (c) => c.json({
      error: 'request-body-too-large',
      message: `JSON request body exceeds the ${limitBytes} byte limit`,
      limitBytes,
    }, 413),
  });
}
