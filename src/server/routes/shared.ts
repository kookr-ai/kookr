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
import type { ServerMessage } from '../../shared/contracts/messages.js';
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
import type { ApiAuthConfig } from '../auth.js';
import type { ViewerGrantStore } from '../../core/viewer-grants.js';
import type { ViewerConnectionRegistry } from '../viewer-connection-registry.js';
import type { CollaborationAuditLog } from '../collaboration-audit-log.js';
import type { SessionAuthConfig } from '../auth-session.js';
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import type { RequestDurationMetrics } from '../request-duration-metrics.js';
import type { TaskStateSaveSchedulerLike } from '../task-state-save-scheduler.js';
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
  suppressionTracker?: SnoozeSuppressionTracker;
  tasksFile?: string;
  /** Coalesced task-state saver for bursty mutation paths. */
  taskStateSaveScheduler?: TaskStateSaveSchedulerLike;
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

/** Narrower deps for the read-only /api/cost-comparison telemetry route. */
export interface CostComparisonRouteDeps {
  taskStore: TaskStore;
  serverCwd: string;
  tokenTracker?: TokenTracker;
  tasksFile?: string;
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

export interface RouteDeps {
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
  /** Live getter for the configured concurrency cap (settings.maxActiveTasks). */
  getMaxActiveTasks?: () => number;
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
  /** Result of the crash-recovery startup phase; fetched once by the frontend on mount. */
  startupRecoverySummary?: CrashRecoveryResult | null;
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
  /** Operator drain / resume state (issue #659). Absent disables the admin drain routes. */
  drainController?: DrainController;
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
