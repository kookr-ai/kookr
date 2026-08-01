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
import type { AdmissionControlConfig } from '../task-admission.js';
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
import type { CircuitBreakerRegistry } from '../../core/circuit-breaker.js';
import type { SnoozeSuppressionTracker } from '../../core/snooze-suppression.js';
import type { ScheduleRunner } from '../schedule-runner.js';
import type { ScheduleService } from '../schedule-service.js';
import type { LaunchServiceDeps } from '../launch-service.js';
import type { DiagnosticRunner } from '../diagnostic-runner.js';
import type { CrashRecoveryResult } from '../crash-recovery.js';
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
   * Latest already-sampled host/server resource snapshot (issue #1590). The
   * `POST /api/tasks` admission gate reads
   * `server.eventLoopDelayP95Ms` from it to fast-fail with 503 when the event
   * loop is saturated. Flows through from the full RouteDeps; tests may omit it
   * (absence fails open — admission proceeds).
   */
  getLatestResourceStatus?: () => SystemResourceStatus | null;
  /**
   * Load-based admission thresholds (issue #1590). Falls back to
   * {@link readAdmissionControlConfigFromEnv} at route registration when
   * absent, so production picks up env config without explicit threading.
   */
  admissionControlConfig?: AdmissionControlConfig;
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
 * (`/api/deploy/*`, issue #1072). These routes never touch task, monitor, or messaging
 * state — they only need to locate the production worktree, run plugin
 * maintenance, and report the running port. Keeping the slice exact prevents
 * the deploy module from reaching across unrelated server subsystems.
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
  frontendDir: string;
  broadcastToAll: (msg: ServerMessage) => void;
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
    update: (settings: KookrSettings) => Promise<string[]>;
  };
  /**
   * Shared `audit.jsonl` path (issue #1710 settings-mutation trail; also used
   * by task-lifecycle rows). Optional so lightweight test harnesses can omit it.
   */
  auditLogPath?: string;
  /** Live getter for the configured concurrency cap (settings.maxActiveTasks). */
  getMaxActiveTasks?: () => number;
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
   * Non-critical timer pause gate (issue #1785). `/api/health` and `/metrics`
   * read only `getSnapshot()` — in-memory pause counter + last sample; never
   * a fresh event-loop measurement on the request path.
   */
  nonCriticalTimerPause?: Pick<
    import('../non-critical-timer-pause.js').NonCriticalTimerPauseGate,
    'getSnapshot'
  >;
  /**
   * Resource watchdog (issue #1724). `/api/health` reads only
   * `getHealthSnapshot()` — last sample, last trigger, throttle state,
   * spawns-in-24h — never a fresh `/proc` scan on the request path
   * (issue #1553 lesson).
   */
  resourceWatchdog?: Pick<
    import('../resource-watchdog-service.js').ResourceWatchdogService,
    'getHealthSnapshot'
  >;
  /** Cross-signal terminal/session diagnostics for the dashboard and support capture. */
  sessionHealthService?: Pick<SessionHealthService, 'getDiagnostics'>;
  /**
   * Lifecycle-timer health (issue #1771). Cheap in-memory last-fired stamps
   * for each startLifecycleTimers loop. Absent ⇒ GET /api/diagnostics/timer-health
   * returns an empty loops list (tests / partial harnesses).
   */
  timerHealth?: Pick<import('../../core/timer-health.js').TimerHealthRecorder, 'snapshot'>;
  /** Result of the crash-recovery startup phase; fetched once by the frontend on mount. */
  startupRecoverySummary?: CrashRecoveryResult | null;
  /**
   * Live getter for the crash-recovery summary (issue #1721). Preferred over the
   * static `startupRecoverySummary` field when recovery runs *after* the HTTP
   * listener binds — the summary is null until recovery finishes, then fills in.
   */
  getStartupRecoverySummary?: () => CrashRecoveryResult | null | undefined;
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
   * Latest already-sampled resource snapshot (issue #1590). Threaded to
   * task-routes so the `POST /api/tasks` admission gate can read the sampled
   * event-loop delay p95 without standing up a second monitor.
   */
  getLatestResourceStatus?: () => SystemResourceStatus | null;
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
