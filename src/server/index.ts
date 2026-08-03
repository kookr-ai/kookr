import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import {
  openTaskStateStore,
  persistTaskState,
  serializeSnoozed,
} from '../core/task-persistence.js';
import type { TaskSqliteStore } from '../core/task-sqlite-store.js';
import { reconcile, reconcileStaleOpenLaunches, type ReconciliationResult } from './reconciliation.js';
import { SessionReaperService } from './session-reaper.js';
import { readSessionReapConfigFromEnv, readResourceWatchdogConfigFromEnv } from './config.js';
import { createResourceWatchdogService } from './resource-watchdog-service.js';
import { createResourceWatchdogHostSampler } from './resource-watchdog-sampler.js';
import { readTrailingFileBytes } from './resource-watchdog-log-tail.js';
import { FileResourceWatchdogStateStore } from '../core/resource-watchdog-state.js';
import {
  JsonlResourceWatchdogAuditSink,
  defaultResourceWatchdogAuditPath,
} from '../core/resource-watchdog-audit.js';
import type { ResourceWatchdogConfig } from '../core/resource-watchdog-types.js';
import { type AgentPreflightSnapshot, type PreflightLogger } from './agent-preflight.js';
import type { ServerMessage, SnapshotMessage, SystemResourceStatus } from '../shared/contracts/messages.js';
import type { TelegramTaskOutcome } from '../shared/contracts/telegram.js';
import type { Scope } from './viewer-data-policy.js';
import { createTerminalScopeChecker } from './terminal-scope.js';
import { ContactShareReadModel } from '../core/contact-share.js';
import { deterministicTaskName, generateTaskName } from '../core/task-naming.js';
import type { BackendError, TerminalBackend } from '../adapters/terminal-backend.js';
import type { TerminalSessionDiagnosticsSource } from '../adapters/terminal-session-diagnostics.js';
import {
  readSnapshotShedConfigFromEnv,
  wireEventPipeline,
} from './event-pipeline.js';
import { drainLifecycles } from '../core/suggestion-telemetry.js';
import { createRoutes } from './routes.js';
import { PipelineStarvationService } from './pipeline-starvation-service.js';
import { cancelTask, completeTask, type AgentLifecycleDeps, type TerminalInputDeps } from './agent-lifecycle.js';
import { FinishedAwaitingAckTtlReclaimMetrics } from './finished-awaiting-ack-ttl-sweep.js';
import { HungSuspectTtlReclaimMetrics } from './hung-suspect-ttl-sweep.js';
import type { Task } from '../core/tasks.js';
import { selectDeliveredMergedPr, type MergedPrAttribution } from '../core/completion/index.js';
import {
  countDeliveredPullRequests,
  createLoopDeliveryWatchdogRegistry,
  readLoopDeliveryWatchdogConfigFromEnv,
  type DeliverySnapshot,
} from '../core/loop-delivery-watchdog.js';
import { gitIn } from '../core/git-helpers.js';
import { launchFreshTaskSession, launchTask, type LaunchServiceDeps } from './launch-service.js';
import { PlanQuotaBindingCache } from '../core/plan-quota-binding-cache.js';
import { buildCapacityLedger } from '../core/capacity-ledger.js';
import { SpawnRateLimiter } from '../core/spawn-rate-limiter.js';
import { resolveTaskAttentionSignals } from './task-attention-signals.js';
import { IdempotencyLedger } from '../core/idempotency-ledger.js';
import { LaunchOutcomeMetrics } from '../core/launch-outcome-metrics.js';
import { AgentBootLatencyMonitor } from '../core/agent-boot-latency.js';
import { DrainController } from './drain-state.js';
import { handleWsConnection, type WsConnectionDeps } from './ws-connection-handler.js';
import { QuotaAdapter } from '../adapters/quota-adapter.js';
import { saveSettings, type KookrSettings } from '../core/settings-store.js';
import { AVAILABLE_AGENT_TYPES } from '../core/agent-types.js';
import { applySettingsSideEffects } from './settings-side-effects.js';
import { applyKillSwitchTransition, resolveSafeModeStatus } from '../core/automation-kill-switch.js';
import { OpsStatusWriter, opsStatusPath } from '../core/ops-status.js';
import { DiagnosticRunner } from './diagnostic-runner.js';
import { getDetectionStats, hydrateDetectionStats } from '../core/detection-stats.js';
import { DetectionStatsStore } from './detection-stats-store.js';
import {
  promotePendingStartupTasks,
  runStartupRecoveryPhase,
} from './startup-recovery.js';
import { StartupReadiness } from './startup-readiness.js';
import type { CrashRecoveryResult } from './crash-recovery.js';
import type { KookrServerInternal } from './server-test-helpers.js';
import {
  computeSnapshotBaseAgents as computeSnapshotBaseAgentsFn,
  createSnapshotMessage,
  getSnapshotAgentsForClient,
  type SnapshotMessageDeps,
} from './use-cases/get-snapshot.js';
import { SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS } from './use-cases/snapshot-projection.js';
import { type AgentState, UNOWNED_MONITOR_AGENT_SWEEP_GRACE_MS } from '../core/monitor.js';
import { collectBootTranscriptRegistrations } from './boot-transcript-registration.js';
import {
  resolveReflectWorktreeSweepIntervalHours,
  sweepReflectWorktrees,
} from './use-cases/request-task-reflect.js';
import { startBackgroundServices } from './bootstrap/start-background-services.js';
import { resolveWorkspaceContext } from './use-cases/workspace-context.js';
import {
  ScheduledWorktreeReclaimRunner,
  resolveReclaimScheduleConfig,
} from './scheduled-worktree-reclaim-runner.js';
import {
  formatPayloadDietLogLine,
  resolveMaintenancePruneIntervalHours,
  type PayloadDietStats,
} from './maintenance-prune-schedule.js';
import { resolveRelayOrphanSweepIntervalHours } from './relay-orphan-sweep.js';
import { pruneAgedTaskRecords } from './use-cases/prune-aged-task-records.js';
import { createProdSmokeTickFromEnv } from './prod-smoke-tick.js';
import { createDeployLagDetectorFromEnv } from './deploy-lag-detector.js';
import { isTerminalStatus } from '../core/task-status.js';
import { RelaunchArbiter } from './relaunch-arbiter.js';
import { ProviderResetScheduler, resolveProviderResetMs, buildProviderResumeLaunch } from './provider-reset-scheduler.js';
import { RalphLoopService } from './ralph-loop-service.js';
import { createSystemResourceSampler, RESOURCE_STATUS_INTERVAL_MS } from './system-resource-sampler.js';
import { createMemoryLedger, readMemoryLedgerConfigFromEnv } from './memory-ledger.js';
import {
  createResourceStatusService,
  type ResourceStatusSampler,
} from './resource-status-service.js';
import { createOperationalAlertEvaluator } from './operational-alert-rules.js';
import { bindOperationalAlertSink } from './operational-alert-sink.js';
import { ProviderHealthTracker } from '../core/provider-health.js';
import { loadavg, cpus } from 'node:os';
import { readMaxHostLoadPerCpuFromEnv } from './config.js';
import { LessonSpoolService } from './lesson-spool-service.js';
import { defaultSpoolDir } from '../core/lesson-write-spool.js';
import { SignalOutboxService } from './signal-outbox-service.js';
import {
  createProviderTransientRetryHandler,
  createProviderTransientAlertHandler,
} from './provider-transient-retry.js';
import { defaultSignalOutboxDir } from '../core/signal-outbox.js';
import {
  SignalDeliveryService,
  readSignalDeliveryConfigFromEnv,
  defaultOperatorSignalDir,
  operationalAlertToSignal,
  writeOperatorSignal,
  type OperationalAlertLike,
} from '../observability/signal-delivery/index.js';
import { PersistenceHealthTracker } from '../core/persistence-health.js';
import { TimerHealthTracker } from '../core/timer-health.js';
import { TaskStateSaveScheduler } from './task-state-save-scheduler.js';
import { createIssueClaimServices, createUpstreamOfResolver, isIssueClaimsEnabled, type IssueClaimServices } from './issue-claim-wiring.js';
import { EnvironmentBlockerRegistry } from '../core/environment-blocker-registry.js';
import {
  createOwnerEscalationNotifier,
  controlRoomLogChannel,
} from '../core/escalation-owner-channel.js';
import {
  defaultRetroVerifyQueueDir,
  readPendingRetroVerify,
} from '../core/retro-verify-queue.js';
import { decorateClaim } from './issue-claim-decorator.js';
import { resolveClaimRepo } from './use-cases/resolve-claim-repo.js';
import { getProjectId } from '../core/project-identity.js';
import { acquireSingleWriterLock } from './single-writer-lock.js';
import {
  getOperationalAlertConfig,
  resetOperationalAlertConfig,
} from './operational-alert-config.js';
import { readAdmissionControlConfigFromEnv } from './task-admission.js';
import { readLoadShedConfigFromEnv } from './websocket-load-shed.js';
import {
  createNonCriticalTimerPauseGate,
  readNonCriticalTimerPauseConfigFromEnv,
} from './non-critical-timer-pause.js';
import { readDashboardFanoutConfigFromEnv } from './websocket-backpressure-config.js';
import { readWsDeltaEnabledFromEnv } from './snapshot-delta.js';
import {
  FindingEvidenceReviewQueueStore,
  FindingEvidenceReviewSampler,
  readFindingEvidenceReviewSamplerConfigFromEnv,
} from './finding-evidence-review-sampler.js';
import {
  getOrCreateFindingEvidenceReviewHmacKey,
  readFindingEvidenceReviewConfigFromEnv,
} from './finding-evidence-review-service.js';
import { ReviewLogStore } from './review-log-store.js';
import { SupervisorFeedbackCaseStore } from './supervisor-feedback-case-store.js';
import { UserInputDeliveryService } from './user-input-delivery-service.js';
import { type OssSourceWatcherFs } from './oss-source-watcher.js';
import { migrateLegacyProtectedWorktree } from '../adapters/worktree-marker.js';
import { cleanupReconciledTaskWorktrees } from '../adapters/git-worktree.js';
import { createContributionWorkspaceServices } from './bootstrap/create-contribution-workspace-services.js';
import { createAgentRuntime } from './bootstrap/create-agent-runtime.js';
import { createCoreStores } from './bootstrap/create-core-stores.js';
import { createSessionLivenessProbe } from './session-liveness-probe.js';
import { createGitHubRuntime } from './bootstrap/create-github-runtime.js';
import { createHookRuntime } from './bootstrap/create-hook-runtime.js';
import { createOssServices, createOssSourceWatchers } from './bootstrap/create-oss-services.js';
import { createRealtimeServices, DEFAULT_SNAPSHOT_PAYLOAD_SIZE_LIMITS } from './bootstrap/create-realtime-services.js';
import { createScheduleRuntime } from './bootstrap/create-schedule-runtime.js';
import { startHttpAndWebSockets } from './bootstrap/start-http-and-websockets.js';
import { startRemoteChatTrigger } from './bootstrap/start-remote-chat-trigger.js';
import {
  TaskTailStore,
  readTaskTailConfigFromEnv,
} from '../core/task-tail-store.js';
import {
  buildCollaborationDiagnostics,
  startConfiguredPrivateNetworkCollaborationListener,
  type CollaborationListenerHandle,
} from './collaboration-listener.js';
import { startPrivateNetworkSharedTaskUpdatePoller } from './collaboration-update-poller.js';
import { readPrivateNetworkCollaborationConfig } from './collaboration-config.js';
import { projectTaskForRemoteShare } from './share-projection.js';
import { CollaborationAuditLog } from './collaboration-audit-log.js';
import { ViewerGrantStore } from '../core/viewer-grants.js';
import { ContactIdentityStore } from './contact-identity-store.js';
import { CollaborationShareStore } from './collaboration-share-store.js';
import type { CollaborationAuthFailureDiagnostic } from '../shared/contracts/collaboration-profile.js';
import type { NodeId } from '../remote/ids.js';
import { createRemoteRelayRuntime, type RemoteRelayRuntime } from './remote-relay-runtime.js';
import { RuntimeAttentionMissSampler } from './attention-miss-runtime-sampler.js';
import { CoordinatorSuppressionStore } from './coordinator/suppression-store.js';
import { TerminalInputCoordinator } from './terminal-input-coordinator.js';
import { TerminalInputRttMetrics } from './terminal-input-rtt-metrics.js';
import { DashboardSelectionController } from './dashboard-selection-controller.js';
import { DeliveryTraceBuffer } from '../core/delivery-trace.js';
import { SessionHealthTracker } from '../core/session-health.js';
import { SessionHealthService } from './session-health-service.js';
import type { ApiAuthConfig } from './auth.js';
import type { SessionAuthConfig } from './auth-session.js';
import {
  WebhookNotifier,
  buildDashboardBaseUrl,
  readWebhookConfigFromEnv,
  resolveWebhookRouting,
} from '../integrations/webhook/index.js';

// --- Exported types ---

export interface KookrConfig {
  port: number;
  host: string;
  kookrDir: string;
  tasksFile: string;
  hooksDir: string;
  settingsDir: string;
  serverCwd: string;
  frontendDir: string;
  saveIntervalMs: number;
  livenessIntervalMs: number;
  /**
   * Session I/O backend. V8 made this the single transport — all session
   * lifecycle, writes, captures, and WebSocket attaches go through it.
   *
   * See docs/rfc/rfc-v8-tmux-removal.md and docs/adr/014-local-dtach-backend.md.
   *
   * The `Partial<TerminalSessionDiagnosticsSource>` is a deliberate, explicit
   * opt-in for raw per-session transport diagnostics — that capability lives
   * off the generic `TerminalBackend` port so plain port handles cannot reach
   * adapter internals (issue #1828). Concrete backends (LocalDtachBackend)
   * provide it; the fake test backend does not.
   */
  terminalBackend: TerminalBackend & Partial<TerminalSessionDiagnosticsSource>;
  /**
   * Absolute path to `terminalBackend`'s dtach socket/manifest directory
   * (`LocalDtachBackend.getInstanceDir()`), when the backend is dtach-backed.
   * Used by the boot-only stale-attach-client sweep (issue #1720) to scope its
   * process-table scan to sessions this instance owns. Absent (e.g. in tests
   * using a non-dtach fake backend) simply skips that sweep.
   */
  terminalInstanceDir?: string;
  /** Optional STT service WebSocket URL (e.g. ws://localhost:8003). Enables speech-to-text when set. */
  sttUrl?: string;
  /** Optional TTS service HTTP URL (e.g. http://localhost:8004). Advertised as a Phase 6 speech capability when set. */
  ttsUrl?: string;
  /** Pocket TTS voice. Defaults to the bundled Matilda voice. */
  ttsVoice?: string;
  /** Surgical kill-switch for the speak-finding feature. Default true; set via `KOOKR_SPEAK=false`. */
  speakFindingEnabled?: boolean;
  /** Use FakeTerminalBridge instead of a real session attach. For E2E tests and demo mode. */
  useFakeTerminalBridge?: boolean;
  /** Path or command name for the Claude Code binary. Defaults to 'claude'. */
  agentBin?: string;
  /** Path or command name for the Codex binary. Defaults to 'codex'. */
  codexBin?: string;
  /** Path or command name for the experimental Grok Build binary. Defaults to 'grok'. */
  grokBin?: string;
  /**
   * Opt-in: bypass ALL permission prompts in spawned agents. When true,
   * Claude Code launches with --dangerously-skip-permissions and Codex
   * launches with --dangerously-bypass-approvals-and-sandbox (instead of
   * --full-auto). Defaults to false.
   */
  bypassAllPermissions?: boolean;
  /**
   * Root of the user's Claude config (scanned for `*-recon/recon-report.md`
   * to discover skill-tracked OSS repos). Defaults to `~/.claude`.
   */
  claudeDir?: string;
  /**
   * Test seam for the startup adapter-binary preflight. Production calls
   * `process.exit(1)` when an env-configured agent binary is unreachable;
   * tests pass a throwing fake to assert the policy without exiting the
   * test runner. Defaults to `process.exit`.
   */
  preflightOnFatal?: (snapshot: AgentPreflightSnapshot & { status: 'absent' }) => never;
  /** Test seam for capturing preflight log lines. */
  preflightLogger?: PreflightLogger;
  /** Test seam for OSS source fs.watch wiring. */
  ossSourceWatcherFs?: Partial<OssSourceWatcherFs>;
  /** Test seam for OSS source watcher debounce. Defaults to 250 ms. */
  ossSourceWatcherDebounceMs?: number;
  /** Server-lifecycle abort signal — see `VoiceWarmupOpts.lifecycleSignal` and issue #188. */
  lifecycleSignal?: AbortSignal;
  /** Test seam for deterministic resource-status samples. Production uses the host sampler. */
  resourceStatusSampler?: ResourceStatusSampler;
  /** Test seam for faster resource-status polling. Production uses RESOURCE_STATUS_INTERVAL_MS. */
  resourceStatusIntervalMs?: number;
  /**
   * Resolved API-token auth posture (issue #708). When `required` is true (a
   * non-loopback bind), state-changing routes and the WebSocket upgrade require
   * a bearer token. Absent defaults to no auth (loopback flow). Resolved in
   * `src/server/start.ts` via `resolveApiAuth`.
   */
  apiAuth?: ApiAuthConfig;
  /**
   * Browser cookie-exchange + CSRF posture (issue #804). Resolved in
   * `src/server/start.ts` on a non-loopback bind; threaded into the routes layer
   * to enable `POST /api/auth/session` and the owner-mutation CSRF guard.
   */
  sessionAuth?: SessionAuthConfig;
  /**
   * Test seam for the launch cwd existence check (RFC F12). The E2E test
   * server passes a no-op because its specs launch into the fictional
   * `/test/project` against FakeTerminalBackend. Production omits this and
   * gets the real check. See `LaunchServiceDeps.validateLaunchCwd`.
   */
  validateLaunchCwd?: (cwd: string) => Promise<void>;
}

function getOrCreatePrivateNetworkNodeId(kookrDir: string): NodeId {
  const nodeIdPath = join(kookrDir, 'private-network-node-id');
  try {
    const existing = readFileSync(nodeIdPath, 'utf-8').trim();
    if (existing) return existing as NodeId;
  } catch {
    // Created below.
  }
  mkdirSync(kookrDir, { recursive: true });
  const nodeId = `kookr-private-node-${randomBytes(16).toString('hex')}`;
  writeFileSync(nodeIdPath, `${nodeId}\n`, { encoding: 'utf-8', mode: 0o600 });
  return nodeId as NodeId;
}

/** Narrow public interface — only what production consumers need. */
export interface KookrServer {
  close(): Promise<void>;
  broadcastToAll(msg: ServerMessage): void;
}

// --- Helpers ---

/** Single-line human-readable rendering of a BackendError for log output. */
function formatBackendErrorLine(err: BackendError): string {
  switch (err.kind) {
    case 'dtach-unavailable':
      return `[terminal-backend] dtach binary unavailable: ${err.binary}`;
    case 'session-attach-failed':
      return `[terminal-backend] session ${err.id} attach failed after ${err.retries} retries`;
    case 'session-gone':
      return `[terminal-backend] session ${err.id} is gone`;
    case 'session-attach-recovered':
      return `[terminal-backend] session ${err.id} attach recovered (attempt ${err.attempt})`;
    case 'write-timed-out':
      return `[terminal-backend] write to session ${err.id} timed out after ${err.durationMs}ms`;
    case 'manifest-corrupt':
      return `[terminal-backend] manifest corrupt; recovered ${err.recoveredCount} entries from socket dir`;
    case 'session-recovery-repaired':
      return `[terminal-backend] session ${err.id} attach transport repaired after restart (${err.attempts} attempt(s))`;
    case 'session-recovery-unverified':
      return `[terminal-backend] session ${err.id} could not be verified live after restart `
        + `(${err.attempts} repair attempt(s); ${err.failureReason}) — agent preserved, attach transport unrevived`;
  }
}

// --- Server factory ---

export function notifyBootReconciledTaskOutcomes(
  onTaskOutcome: ((taskId: string, outcome: TelegramTaskOutcome) => void) | undefined,
  reconcileResult: Pick<ReconciliationResult, 'tasksCompleted' | 'tasksTerminated'>,
): void {
  if (!onTaskOutcome) return;
  for (const id of reconcileResult.tasksCompleted) {
    try {
      onTaskOutcome(id, { kind: 'completed' });
    } catch (err) {
      console.warn('[telegram] boot reconcile outcome notification failed:', err);
    }
  }
  for (const id of reconcileResult.tasksTerminated) {
    try {
      onTaskOutcome(id, { kind: 'failed' });
    } catch (err) {
      console.warn('[telegram] boot reconcile outcome notification failed:', err);
    }
  }
}

export async function createKookrServer(config: KookrConfig): Promise<KookrServer> {
  return createKookrServerInternal(config);
}

/** Returns the full internal server — use in tests that need direct access to subsystems. */
export async function createKookrServerInternal(config: KookrConfig): Promise<KookrServerInternal> {
  const {
    port, host, kookrDir, tasksFile, hooksDir, settingsDir,
    serverCwd, frontendDir, saveIntervalMs, livenessIntervalMs,
    terminalBackend, terminalInstanceDir, sttUrl, ttsUrl, useFakeTerminalBridge, agentBin, codexBin, grokBin, bypassAllPermissions,
    claudeDir, preflightOnFatal, preflightLogger,
    ossSourceWatcherFs, ossSourceWatcherDebounceMs,
    resourceStatusSampler,
    resourceStatusIntervalMs,
    lifecycleSignal,
  } = config;
  const apiAuth: ApiAuthConfig = config.apiAuth ?? { required: false };

  // R27 (rfc-issue-ownership-lock): assert exactly one server process owns
  // this data dir BEFORE any boot-time task mutation (reconcile, claim
  // rebuild) touches it — the port bind only enforces exclusivity later.
  const releaseSingleWriterLock = acquireSingleWriterLock(kookrDir);

  // Durable terminal tails for completed tasks (rfc-task-tail-retrieval).
  const taskTailConfig = readTaskTailConfigFromEnv(process.env, kookrDir);
  const taskTailStore = new TaskTailStore({
    dir: taskTailConfig.dir,
    retentionDays: taskTailConfig.retentionDays,
    maxBytes: taskTailConfig.maxBytes,
  });
  let taskTailPurgeTimer: ReturnType<typeof setInterval> | undefined;
  if (taskTailConfig.purgeIntervalMs > 0) {
    // First sweep after one interval (not at boot) so startup stays light.
    taskTailPurgeTimer = setInterval(() => {
      void taskTailStore.purgeExpired().then((removed) => {
        if (removed > 0) {
          console.log(`[task-tail] purged ${removed} expired terminal tail(s)`);
        }
      }).catch((err) => {
        console.warn(
          '[task-tail] purge failed:',
          err instanceof Error ? err.message : err,
        );
      });
    }, taskTailConfig.purgeIntervalMs);
    // Don't keep the process alive solely for purge ticks.
    taskTailPurgeTimer.unref?.();
  }

  const coreStores = await createCoreStores({
    kookrDir,
    hooksDir,
    settingsDir,
    frontendDir,
    processLivenessProbe: createSessionLivenessProbe(terminalBackend),
  });
  const coordinatorSuppressions = new CoordinatorSuppressionStore(kookrDir);
  let currentSettings = coreStores.currentSettings;
  let settingsLoadedFromDefaults = coreStores.settingsLoadedFromDefaults;
  let settingsLoadWarnings = coreStores.settingsLoadWarnings;
  const {
    interactionLog,
    telemetryLog,
    buildInfo,
    serverStartedAt,
    settingsFile,
    circuitBreakerRegistry,
    githubBreaker,
    permissionAlertBreaker,
    taskStore,
    worktreeRegistry,
    queue,
    suppressionTracker,
    monitor,
    watchdog,
    ralphCycler,
    tokenTracker,
    budgetChecker,
    progressBudgetBurnDiagnostics,
    projectConfigStore,
    projectSidebarStore,
    shadowRegistry,
    httpPushTracker,
    llmClient,
  } = coreStores;
  const getMaxActiveTasks = () => currentSettings.maxActiveTasks;
  const getCleanupWorktreeOnComplete = () => currentSettings.cleanupWorktreeOnComplete;
  // Live getter for the completion-ready auto-close delay. Reads the live
  // `currentSettings` binding (reassigned by the settings PUT path) so an
  // operator's change takes effect on the next liveness tick without a restart.
  const getAutoCloseCompletionReadyDelayMs = () => currentSettings.autoCloseCompletionReadyDelayMin * 60_000;
  // Live getter for the completion-ready TTL escalation threshold (issue
  // #1526 Phase A / FM5). Same live-binding pattern as the delay above.
  const getCompletionReadyTtlMs = () => currentSettings.completionReadyTtlMinutes * 60_000;
  // Live getters for the hung-task reaper (issue #1526 Phase A / FM6).
  const getHungTaskReapEnabled = () => currentSettings.hungTaskReapEnabled;
  const getHungTaskReapMs = () => currentSettings.hungTaskReapMinutes * 60_000;
  // Live getter for the post-merge cleanup budget (issue #1560). Same
  // live-binding pattern — applies on the next liveness tick.
  const getPostMergeCleanupBudgetMs = () => currentSettings.postMergeCleanupBudgetMinutes * 60_000;
  // Live getter for the adapter-launch hard timeout (issue #1526 Phase C /
  // #1528). Same live-binding pattern — applies to the next launch.
  const getLaunchTimeoutMs = () => currentSettings.launchTimeoutSeconds * 1000;
  // Live getter for the scheduled-task starvation dead-man window (issue
  // #1526 Phase C). Read on every scheduler tick.
  const getDeadManScheduleMs = () => currentSettings.deadManScheduleMinutes * 60_000;
  // Live getter for the per-schedule consecutive-failure alert threshold (issue
  // #1665). Read on every recorded terminal run so a settings PUT applies next.
  const getScheduleFailureAlertThreshold = () => currentSettings.scheduleFailureAlertThreshold;
  // Honest server-side backpressure (issue #1526 Phase C / C3). All read the
  // live `currentSettings` binding, so a settings PUT applies to the next
  // launch / liveness tick without a restart.
  const getMaxPendingTasks = () => currentSettings.maxPendingTasks;
  const getPendingTaskTtlMs = () => currentSettings.pendingTaskTtlMinutes * 60_000;
  // Live getter for the finishedAwaitingAck TTL reclaim (issue #1884). Same
  // live-binding pattern — applies to the next liveness tick without a restart.
  const getFinishedAwaitingAckTtlMs = () => currentSettings.finishedAwaitingAckTtlMinutes * 60_000;
  // Live getter for the hungSuspect TTL reclaim (issue #1935). Same pattern.
  const getHungSuspectTtlMs = () => currentSettings.hungSuspectTtlMinutes * 60_000;
  // Reserved self-maintenance capacity (issue #1564). Same live-binding
  // pattern — applies to the next launch without a restart.
  const getReservedActiveSlots = () => currentSettings.reservedActiveSlots;
  const getReservedSlotSources = () => currentSettings.reservedSlotSources;
  // Per-source spawn budget — one limiter instance per server so window state
  // is shared across REST, WS, and internal launch paths.
  const spawnRateLimiter = new SpawnRateLimiter({
    getLimit: () => currentSettings.spawnBurstLimit,
    getWindowMs: () => currentSettings.spawnBurstWindowMinutes * 60_000,
  });
  // #681: live getter for the per-agent-type effort defaults. Reads the live
  // `currentSettings` binding so an operator's settings PUT takes effect on the
  // next launch without a restart (the PUT path reassigns `currentSettings`).
  const getAgentEffort = () => currentSettings.agentEffort;
  // Issue #1773: keystroke → write-ack RTT histogram. Owned here so the same
  // instance both records (via the coordinator) and reports (via route deps).
  const terminalInputRttMetrics = new TerminalInputRttMetrics();
  const terminalInputCoordinator = new TerminalInputCoordinator(
    terminalBackend,
    undefined,
    terminalInputRttMetrics,
  );
  const reflectWorktreesDir = join(kookrDir, 'reflect-worktrees');
  const sessionHealthTracker = new SessionHealthTracker();
  const restartEpoch = Number.isFinite(Date.parse(serverStartedAt)) ? Date.parse(serverStartedAt) : Date.now();
  const sessionHealthService = new SessionHealthService({
    listSessions: () => taskStore.getAllTasks().flatMap((task) => task.sessions.map((session) => ({
      sessionId: session.tmuxSession,
      taskStatus: task.status,
      ...(session.lastTurnState ? { turnState: session.lastTurnState } : {}),
      ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
    }))),
    getTurnState: (sessionId) => monitor.getLiveTurnState(sessionId),
    getWatchdogState: (sessionId) => watchdog.getState(sessionId),
    getBackendDiagnostics: (sessionId) => terminalBackend.getSessionDiagnostics?.(sessionId),
    browser: sessionHealthTracker,
    restartEpoch,
  });
  monitor.setSessionHealthProvider((sessionId, turnState) => sessionHealthService.getSessionHealth(sessionId, turnState));
  const deliveryTrace = new DeliveryTraceBuffer();
  const stopDeliveryTraceObserver = queue.addObserver({
    admitted: (event) => deliveryTrace.recordAdmitted(event),
    suppressed: (event) => deliveryTrace.recordSuppressed(event, event.reason),
  });

  const webhookConfig = readWebhookConfigFromEnv(process.env, {
    dashboardBaseUrl: buildDashboardBaseUrl({ host, port, env: process.env }),
    logger: console,
  });
  let stopWebhookObserver: (() => void) | undefined;
  let webhookNotifier: WebhookNotifier | undefined;
  if (webhookConfig) {
    webhookNotifier = new WebhookNotifier({ config: webhookConfig, taskStore, deliveryTrace, logger: console });
    console.log(`[webhook] Outbound finding webhook enabled (minSeverity=${webhookConfig.minSeverity})`);
    stopWebhookObserver = queue.addObserver({
      admitted: (event) => {
        const task = taskStore.findTaskBySession(event.agentId);
        const projectWebhook = task?.projectId
          ? projectConfigStore.getConfig(task.projectId)?.webhook
          : undefined;
        void webhookNotifier?.notifyFinding(event, resolveWebhookRouting({
          globalMinSeverity: webhookConfig.minSeverity,
          projectWebhook,
        }));
      },
      resolved: (event) => {
        webhookNotifier?.clearFingerprint(event);
      },
    });
  }

  const { adapterRegistry, adapter, agentPreflight } = await createAgentRuntime({
    terminalBackend,
    terminalInputWriter: terminalInputCoordinator,
    taskStore,
    hooksDir,
    settingsDir,
    serverPort: port,
    agentBin,
    codexBin,
    grokBin,
    bypassAllPermissions,
    preflightOnFatal,
    preflightLogger,
    getAgentEffort,
  });
  const userInputDeliveries = new UserInputDeliveryService({
    adapter,
    interactionLog,
    retry: {
      sendEnter: (sessionId) => adapter.sendKeystroke(sessionId, 'Enter'),
      capturePane: (sessionId) => adapter.captureDisplay(sessionId),
    },
  });

  const ossServices = await createOssServices({ kookrDir, claudeDir });
  const {
    ossAttemptStore,
    ledgerAnalytics,
    skillDiscoveryState,
    prLessonsState,
    ossRefresher,
    getRegistryActiveProjects,
    getRegistryActiveRepos,
  } = ossServices;

  // STT feature (opt-in via KOOKR_STT_URL)
  if (sttUrl) {
    console.log(`[stt] Speech-to-text enabled (${sttUrl})`);
  } else {
    console.log('[stt] Speech-to-text disabled (no KOOKR_STT_URL)');
  }

  const getDefaultAgentType = () => currentSettings.defaultAgentType;
  /**
   * Serialized writer for `settings.json`. Each scheduled write serializes the
   * *live* `currentSettings` when its turn in the chain comes, so the last
   * write always reflects the freshest state: a per-launch round-robin cursor
   * bump and an operator settings PUT cannot clobber each other's fields, and
   * concurrent cursor bumps cannot land their `rename()`s out of order. A
   * failed write is swallowed so it never stalls the chain.
   */
  let settingsWriteChain: Promise<void> = Promise.resolve();
  const persistSettings = (): Promise<void> => {
    settingsWriteChain = settingsWriteChain
      .catch(() => {})
      .then(() => saveSettings(settingsFile, currentSettings));
    return settingsWriteChain;
  };
  /**
   * Round-robin rotation cursor. `peek` reads the index for the next launch;
   * `advance` moves the cursor forward and persists it. `launchTask` advances
   * only once a task record is committed, so deduplicated or failed launches
   * never consume a rotation slot. The persist is fire-and-forget — a lost
   * write costs at most a rotation step after a crash, and the next launch
   * rewrites the cursor regardless.
   */
  const roundRobinCursor = {
    peek: (): number => currentSettings.roundRobinIndex,
    advance: (): void => {
      currentSettings = {
        ...currentSettings,
        roundRobinIndex: currentSettings.roundRobinIndex + 1,
      };
      void persistSettings().catch((err) => {
        console.warn(
          '[round-robin] failed to persist rotation cursor:',
          err instanceof Error ? err.message : err,
        );
      });
    },
  };
  // #808: read-only shared-view viewer grants. The store is loaded before the
  // realtime services so the revocation sweep can resolve grant liveness by id.
  // `resolveViewer` is deliberately NOT wired into `config.apiAuth` here — that
  // would admit viewer cookies onto `/ws` ahead of the scoped fan-out (#809) and
  // terminal scope check (#810), a fail-open — so today only the owner connects
  // and the sweep evicts nothing.
  const viewerGrantStore = new ViewerGrantStore(kookrDir);
  await viewerGrantStore.load();
  // The collaboration audit log is constructed here (ahead of the realtime
  // services) so the sweep's `onViewerEvicted` audit hook is wired *before* the
  // connection registry's sweep timer can run — no window where an eviction
  // drops its audit row. (It is also reused below for the private-network
  // collaboration stack and the share routes.)
  let privateNetworkNodeId: NodeId | null = null;
  const privateNetworkAuditLog = new CollaborationAuditLog({
    kookrDir,
    ownerNodeId: () => {
      privateNetworkNodeId ??= getOrCreatePrivateNetworkNodeId(kookrDir);
      return privateNetworkNodeId;
    },
  });

  // Operator drain / resume state (issue #659). In-memory only: a restarted
  // node always comes back accepting. Shared by snapshots, launch gates,
  // schedule skips, and admin drain routes.
  const drainController = new DrainController();

  // Single owner of WS scope filtering (#809, RFC §"Outbound scope filtering").
  // The broadcaster (#805) and the viewer initial-connection burst both call
  // `buildScopedSnapshot` to build the snapshot a `projects` viewer receives;
  // for an `all` scope the broadcaster reuses the already-enriched owner
  // snapshot, so that factory is only ever invoked for a `projects` scope. Only
  // scope-relevant deps are threaded in — whole-world aggregates, speech
  // endpoints, and owner-config capabilities are neither passed here NOR
  // (independently) emitted by `createSnapshotMessage` for a `projects` scope,
  // which is the real authority.
  //
  // Shared deps for every per-scope snapshot build in a flush. `scope` and the
  // optional reusable `precomputedClientAgents` (#1398) are the only per-call
  // differences; keeping one factory guarantees the base computed by
  // `computeSnapshotBaseAgents` uses byte-identical agent-affecting deps.
  const getSafeModeStatus = () => resolveSafeModeStatus({
    automationKillSwitch: currentSettings.automationKillSwitch,
    safeModeSince: currentSettings.safeModeSince,
  });
  const scopedSnapshotDeps = (scope: Scope, precomputedClientAgents?: AgentState[]): SnapshotMessageDeps => ({
    monitor,
    serverCwd,
    scope,
    bypassAllPermissions,
    relationTaskStore: taskStore,
    drainStatus: drainController.status(),
    safeMode: getSafeModeStatus(),
    terminalInputSnapshots: terminalInputCoordinator,
    userInputDeliveryProvider: userInputDeliveries,
    ...(precomputedClientAgents ? { precomputedClientAgents } : {}),
  });
  const buildScopedSnapshot = (scope: Scope, precomputedClientAgents?: AgentState[]): SnapshotMessage =>
    createSnapshotMessage(scopedSnapshotDeps(scope, precomputedClientAgents));
  // Full-fleet projection base, computed once per broadcast flush and reused
  // across every distinct viewer scope so the fleet projection
  // (`Monitor.getSnapshot()` + `buildSnapshotProjection()`) runs once regardless
  // of scope count (#1398).
  const computeSnapshotBaseAgents = (): AgentState[] =>
    computeSnapshotBaseAgentsFn(scopedSnapshotDeps({ kind: 'all' }));

  // Single owner of the terminal-stream scope decision (#810, RFC §"Terminal
  // stream fan-out"). Owns the session→task→projectId lookup AND the scope
  // comparison, so both enforcement loci — the terminal WS upgrade gate
  // (`start-http-and-websockets.ts`, 403) and the revocation sweep's per-tick
  // re-check (`viewer-connection-registry.ts`, eviction on reassignment, RFC
  // F8) — call this one predicate. Owners always pass; a `projects` viewer
  // passes only for sessions whose task is in scope. Wiring the predicate is
  // safe ahead of live viewer admission: with `resolveTerminalActor` still
  // deferred every terminal actor is the owner, so it is inert until viewers
  // land — but it makes the gate real the moment they do.
  const isActorAllowedTerminalSession = createTerminalScopeChecker(
    (sessionName) => taskStore.findTaskBySession(sessionName)?.projectId,
  );

  // Payload-diet observability (issue #1526 Phase C / C2): remember the size
  // of the most recent `all`-scope snapshot broadcast so the boot / maintenance
  // stats line can report it alongside the tracked-record count.
  let lastSnapshotPayloadBytes: number | null = null;

  // Dashboard WS fan-out death-spiral guards (issue #1725). Read here (before
  // `createRealtimeServices`) so both the load-shed gate and the per-client
  // backpressure/liveness knobs are wired into the same broadcaster/registry
  // instances the rest of the server uses.
  const wsLoadShedConfig = readLoadShedConfigFromEnv();
  console.log(
    wsLoadShedConfig.eventLoopDelayThresholdMs > 0
      ? `[ws-load-shed] dashboard snapshot fan-out sheds to degraded frames at event-loop p95 >= ` +
          `${wsLoadShedConfig.eventLoopDelayThresholdMs}ms for ${wsLoadShedConfig.sustainTicks} consecutive ticks ` +
          `(recovers after ${wsLoadShedConfig.recoverTicks} consecutive ticks back under threshold)`
      : '[ws-load-shed] Event-loop-delay load-shed disabled (set KOOKR_WS_LOAD_SHED_EVENT_LOOP_DELAY_MS to enable)',
  );
  const dashboardFanoutConfig = readDashboardFanoutConfigFromEnv();
  const wsDeltaEnabled = readWsDeltaEnabledFromEnv();
  console.log(
    `[ws-fanout] dashboard client sustained soft-backpressure disconnect after ` +
      `${dashboardFanoutConfig.backpressureDisconnectAfterSkips} consecutive skips; ` +
      `dead-socket liveness sweep ${dashboardFanoutConfig.livenessSweepEnabled ? 'enabled' : 'disabled'}; ` +
      `delta protocol ${wsDeltaEnabled ? 'enabled' : 'disabled (full snapshots)'} (KOOKR_WS_DELTA)`,
  );

  const realtime = await createRealtimeServices({
    kookrDir,
    taskStore,
    queue,
    monitor,
    adapterRegistry,
    serverCwd,
    sttUrl,
    // #1754: the server-lifetime-stable epoch for the delta stream is
    // `serverStartedAt` — restart changes it, resetting the client's seq baseline.
    serverEpoch: serverStartedAt,
    // #1754 Stage 2: steady-state coalesced deltas (kill-switch KOOKR_WS_DELTA=0).
    enableWsDelta: wsDeltaEnabled,
    buildScopedSnapshot,
    computeSnapshotBaseAgents,
    observeSnapshotPayloadSize: (observation) => {
      if (observation.payloadType === 'snapshot' && observation.scopeKey === 'all' && observation.action !== 'dropped') {
        lastSnapshotPayloadBytes = observation.bytes;
      }
    },
    ledgerAnalytics,
    projectConfigStore,
    projectSidebarStore,
    skillDiscoveryState,
    prLessonsState,
    getRegistryActiveProjects,
    getRegistryActiveRepos,
    ossAttemptStore,
    getDefaultAgentType,
    bypassAllPermissions,
    getDrainStatus: () => drainController.status(),
    getSafeModeStatus,
    coordinatorSuppressions,
    resolveGrantLiveness: (grantId) => viewerGrantStore.liveness(grantId),
    isActorAllowedTerminalSession,
    loadShedConfig: wsLoadShedConfig,
    backpressureDisconnectAfterSkips: dashboardFanoutConfig.backpressureDisconnectAfterSkips,
    livenessSweepEnabled: dashboardFanoutConfig.livenessSweepEnabled,
    // #808 / R10: a sweep evicting a live viewer socket is an audit event
    // (fire-and-forget so a slow audit write never stalls the sweep tick).
    onViewerEvicted: (eviction) => {
      void privateNetworkAuditLog
        .append({
          actor: { kind: 'viewer', grantId: eviction.grantId },
          event: 'viewer-grant.sweep-evicted',
          grantId: eviction.grantId,
          reason: eviction.reason,
        })
        .catch((err) => {
          console.warn('[viewer-share] failed to write sweep-evicted audit event', err);
        });
    },
  });
  const {
    registry: connectionRegistry,
    achievementWatcher,
    broadcastToAll,
    broadcastProjectSummaries,
    broadcastOssAttempts,
  } = realtime;
  const selectionController = new DashboardSelectionController({
    getAgents: () => getSnapshotAgentsForClient({ monitor }),
  });

  // Issue #1785: pause non-critical background timers when event-loop delay p95
  // is elevated. Created early so the GitHub scanner (below) and lifecycle
  // timers can share one gate; samples are fed later via ResourceStatusService.
  const nonCriticalTimerPauseConfig = readNonCriticalTimerPauseConfigFromEnv();
  const nonCriticalTimerPauseGate = createNonCriticalTimerPauseGate(nonCriticalTimerPauseConfig);
  console.log(
    nonCriticalTimerPauseConfig.eventLoopDelayThresholdMs > 0
      ? `[timer-pause] non-critical ticks skip when event-loop p95 > ` +
          `${nonCriticalTimerPauseConfig.eventLoopDelayThresholdMs}ms`
      : '[timer-pause] Non-critical timer pause disabled (set KOOKR_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS to enable)',
  );

  // Forward-declared so onRepoHealthChanged can call back into the broadcast
  // function which references githubScanner.getRepoHealthSnapshot().
  let broadcastProjectSummariesRef: (() => void) | null = null;
  const { githubStateStore, githubScanner } = createGitHubRuntime({
    taskStore,
    githubBreaker,
    githubPollingIntervalSec: currentSettings.githubPollingIntervalSec,
    broadcastToAll,
    onRepoHealthChanged: () => {
      broadcastProjectSummariesRef?.();
    },
    nonCriticalTickPause: nonCriticalTimerPauseGate,
  });
  realtime.setProjectSummaryGitHubDeps({
    getRepoHealthSnapshot: () => githubScanner.getRepoHealthSnapshot(),
    getTaskGithubReferences: (taskId) => githubStateStore.getReferences(taskId),
    getGithubRefOpenState: (ref) => githubStateStore.isRefOpen(ref),
    setTrackedGithubRepos: (repos) => githubScanner.setTrackedGithubRepos(repos),
  });

  // Delivery attribution for the delivered-completion sweep (issue #1560): the
  // task's own merged PR. `selectDeliveredMergedPr` excludes PRs merely
  // referenced in the task prompt (`detectedFrom === 'prompt'`) so a live task
  // that mentions an already-merged PR is never force-completed — only PRs
  // discovered from the agent's own activity count as delivery.
  const resolveMergedPr = (task: Task): MergedPrAttribution | null =>
    selectDeliveredMergedPr(
      githubStateStore.getTaskState(task.id).prs.map((pr) => ({
        status: pr.status,
        number: pr.ref.number,
        url: pr.ref.url,
        owner: pr.ref.owner,
        repo: pr.ref.repo,
        detectedFrom: pr.ref.detectedFrom,
      })),
    );

  // Delivery-aware loop watchdog (issue #1902, WS2.4 of #1699). Judges a Ralph
  // loop on POSITIVE delivery progress with hysteresis: sampled once per
  // iteration (in ralph-loop-service) with the loop's cumulative delivery
  // counters, it flags a loop that stops delivering for N consecutive
  // iterations while never flagging a quiet-but-progressing loop.
  const loopDeliveryWatchdog = createLoopDeliveryWatchdogRegistry(
    readLoopDeliveryWatchdogConfigFromEnv(process.env),
  );
  const resolveDeliverySnapshot = async (task: Task): Promise<DeliverySnapshot | null> => {
    // Commit count on the loop's branch is the delivery signal that advances
    // through the dominant phase of a real loop — open one PR, then iterate
    // many times pushing commits until it merges. PR/merge COUNTS are coarse
    // milestones that stay flat across those iterations, so PR counts alone
    // would flag a healthy mid-PR loop as hung. Prompt-cited PRs are excluded
    // (mirrors delivered-completion #1560) so a loop that merely mentions an
    // external PR is never counted as its own delivery.
    const { prsOpened, prsMerged } = countDeliveredPullRequests(
      githubStateStore.getTaskState(task.id).prs.map((pr) => ({
        status: pr.status,
        detectedFrom: pr.ref.detectedFrom,
      })),
    );
    const commitOut = await gitIn(task.cwd, 'rev-list', '--count', 'HEAD');
    const commits = commitOut === null ? NaN : Number.parseInt(commitOut, 10);
    if (!Number.isFinite(commits)) {
      // Couldn't read the commit count this iteration (transient git failure /
      // not a worktree). Skip the sample rather than judge on PR milestones
      // alone — missing delivery data must never flag a loop.
      return null;
    }
    return { commits, prsOpened, prsMerged };
  };

  // Stranded-PR / merge_required exemption for the finishedAwaitingAck TTL
  // reclaim (issue #1884). Fail-safe: only a task with zero PR references, or
  // with every referenced PR CONFIRMED closed/merged, returns `false` (safe
  // to reclaim). Any reference GitHub has not yet fetched an open/closed
  // verdict for returns `undefined` — treated the same as `true` by the
  // selector, so an unfetched ref never lets a possibly-open PR get clobbered.
  const isTaskHoldingOpenPr = (task: Task): boolean | undefined => {
    const prRefs = githubStateStore.getReferences(task.id).filter((ref) => ref.type === 'pr');
    if (prRefs.length === 0) return false;
    let sawUnknown = false;
    for (const ref of prRefs) {
      const open = githubStateStore.isRefOpen(ref);
      if (open === true) return true;
      if (open === undefined) sawUnknown = true;
    }
    return sawUnknown ? undefined : false;
  };
  const finishedAwaitingAckTtlReclaimMetrics = new FinishedAwaitingAckTtlReclaimMetrics();
  const hungSuspectTtlReclaimMetrics = new HungSuspectTtlReclaimMetrics();
  broadcastProjectSummariesRef = broadcastProjectSummaries;

  // Load persisted tasks — SQLite by default (#1755), with one-shot migration
  // from tasks.json when the DB is absent. KOOKR_TASK_STORE=json forces legacy.
  const openedTaskState = await openTaskStateStore(tasksFile);
  const taskSqliteStore: TaskSqliteStore | null = openedTaskState.sqliteStore;
  const persisted = openedTaskState.load;
  const startupAlerts: ServerMessage[] = [];
  if (persisted.recovery) {
    const details = persisted.recovery.restoredFrom
      ? `Quarantined corrupt file at ${persisted.recovery.quarantinedPath}; restored tasks from ${persisted.recovery.restoredFrom}.`
      : `Quarantined corrupt file at ${persisted.recovery.quarantinedPath}; no valid daily snapshot was available, so Kookr started with an empty task store.`;
    console.warn(`[tasks-recovery] ${details}`);
    startupAlerts.push({
      type: 'alert',
      agentId: '',
      summary: 'Recovered from corrupt tasks.json',
      details,
      severity: 'critical',
    });
  }
  if (persisted.tasks.length > 0) {
    taskStore.loadTasks(persisted.tasks, persisted.lifetimeSpendUsd);
    console.log(
      `Loaded ${persisted.tasks.length} task(s) from ${openedTaskState.loadedFrom} `
      + `(mode=${openedTaskState.mode}, lifetime spend: $${taskStore.getLifetimeSpendUsd().toFixed(2)})`,
    );
  } else {
    console.log(`Task store ready (${openedTaskState.mode}): ${openedTaskState.loadedFrom}`);
  }
  if (persisted.relations && persisted.relations.length > 0) {
    taskStore.loadRelations(persisted.relations);
  }

  await worktreeRegistry.refresh(serverCwd);

  // One-time idempotent migration: any worktree whose basename still matches
  // the legacy `kookr-prod` convention gets a `.kookr-protected` marker so
  // the marker-aware protection check is authoritative going forward.
  for (const entry of worktreeRegistry.all()) {
    try {
      if (migrateLegacyProtectedWorktree(entry.path)) {
        console.log(
          `[worktree-protection] wrote .kookr-protected marker on ${entry.path} (legacy migration)`,
        );
      }
    } catch (err) {
      console.warn(
        `[worktree-protection] failed to write marker on ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Issue-ownership claim registry (RFC rfc-issue-ownership-lock, PR 1a).
  // Constructed and rebuilt BEFORE the boot reconcile and the HTTP listener,
  // so no claim ever runs against an unpopulated map and the boot release
  // below is holder-checked against real state (§8 boot-ordering invariant).
  const issueClaimsEnabled = isIssueClaimsEnabled();
  console.log(`[issue-claims] KOOKR_ISSUE_CLAIMS=${issueClaimsEnabled ? 'on' : 'off'}`);
  const issueClaimServices: IssueClaimServices | undefined = issueClaimsEnabled
    ? createIssueClaimServices({ taskStore, kookrDir })
    : undefined;
  if (issueClaimServices) {
    const rebuilt = issueClaimServices.registry.rebuildFromTasks();
    console.log(
      `[issue-claims] ${rebuilt.owners} owner(s) rebuilt from ${rebuilt.activeTasks} task(s)`
      + ` (${rebuilt.ignoredTerminalFields} terminal field(s) ignored)`,
    );
  }

  // Environment-blocker registry (issue #1690). A durable, shared record of
  // active external blockers (e.g. a GitHub Actions billing limit) so the first
  // detector registers a blocker once, other agents consult it instead of
  // re-diagnosing, and the owner is escalated. Constructed and loaded from disk
  // BEFORE the HTTP listener so the `/api/environment-blockers` routes never
  // serve an unpopulated registry after a restart.
  //
  // Escalation (issue #1702): escalations route to an owner-read control-room
  // feed carrying the *quantified running cost* of the blocker (CI-blind merge
  // count + retro-verify queue depth from the durable spool, plus the
  // blocked-capability list the registry computes itself). Blockers tagged
  // `requiresHuman` re-escalate on the staleness TTL via the heartbeat sweep
  // below, instead of firing a single buried notification.
  const environmentBlockerRegistry = new EnvironmentBlockerRegistry(kookrDir, {
    notify: createOwnerEscalationNotifier([controlRoomLogChannel()]),
    costProvider: async () => {
      try {
        const pending = await readPendingRetroVerify(defaultRetroVerifyQueueDir(process.env));
        return { ciBlindMergeCount: pending.length, retroVerifyQueueDepth: pending.length };
      } catch {
        // Fail-open: a missing/unreadable spool is zero debt, never a blocked
        // escalation (same posture as the emission CLI's cost read).
        return { ciBlindMergeCount: 0, retroVerifyQueueDepth: 0 };
      }
    },
  });
  await environmentBlockerRegistry.load();
  if (environmentBlockerRegistry.size() > 0) {
    console.log(
      `[environment-blocker] ${environmentBlockerRegistry.size()} active blocker(s) restored from disk`,
    );
  }
  // Re-escalation heartbeat (issue #1702): periodically sweep active blockers so
  // a `requiresHuman` blocker that stays open re-escalates once its staleness
  // TTL elapses. Runs on an interval (default hourly; the TTL, not the tick,
  // controls re-escalation cadence) and never keeps the process alive on its
  // own. Disabled by setting KOOKR_ENV_BLOCKER_HEARTBEAT_MS=0.
  const envBlockerHeartbeatMs = (() => {
    const raw = process.env.KOOKR_ENV_BLOCKER_HEARTBEAT_MS;
    if (raw === undefined) return 60 * 60 * 1000;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 60 * 60 * 1000;
  })();
  let envBlockerHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  if (envBlockerHeartbeatMs > 0) {
    envBlockerHeartbeatTimer = setInterval(() => {
      void environmentBlockerRegistry.heartbeat().then((fired) => {
        if (fired.length > 0) {
          console.log(
            `[environment-blocker] heartbeat re-escalated ${fired.length} stale blocker(s)`,
          );
        }
      }).catch((err) => {
        console.warn(
          '[environment-blocker] heartbeat sweep failed:',
          err instanceof Error ? err.message : err,
        );
      });
    }, envBlockerHeartbeatMs);
    envBlockerHeartbeatTimer.unref?.();
  }

  // Orphan / terminal-task session reaper (issue #1720). Config is a live
  // getter (re-read on every sweep) so KOOKR_REAP_ORPHAN_SESSIONS can be
  // toggled without a restart, matching the `getCleanupWorktreeOnComplete`
  // convention. Wired here (rather than constructed inline at each call site)
  // so start.ts, the boot sweep below, and the periodic liveness tick in
  // lifecycle-timers.ts all share one instance's audit trail + health counters.
  const sessionReaper = new SessionReaperService({
    taskStore,
    backend: terminalBackend,
    auditLogPath: join(kookrDir, 'audit.jsonl'),
    getConfig: () => readSessionReapConfigFromEnv(process.env),
    // Clear stale Monitor state on every sweep (boot + periodic). Two classes:
    //  - #1761: agents of aged terminal tasks. Same age cutoff as the snapshot
    //    payload diet — recent terminal tasks keep their monitor state and
    //    attention findings.
    //  - #1763: agents whose session is owned by NO task and is not live —
    //    the residual leak the aged-terminal sweep cannot reach (startup hook
    //    replay re-registers entries for sessions whose task was deleted).
    // Live sessions are excluded from both so an in-flight session is never
    // darkened. Returns the combined count for the reaper's log line.
    sweepMonitorAgedAgents: (liveSessionIds) => monitor.sweepStaleAgents({
      liveSessionIds,
      agedTerminalCutoffMs: Date.now() - SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS,
      unownedGraceMs: UNOWNED_MONITOR_AGENT_SWEEP_GRACE_MS,
    }),
  });

  // Reconcile with live backend sessions
  const reconcileResult = await reconcile(taskStore, terminalBackend, worktreeRegistry);
  // Boot-only sweep (issue #1526 Phase C / #1528): launches that died with
  // the previous process leave open/zero-session tasks that reconcile()'s
  // dead-session logic never touches. Terminate them here and merge into
  // tasksTerminated so claim release / onTaskOutcome below treat them like
  // any other boot-terminated task. Runs BEFORE createScheduleRuntime so
  // scheduleService.reconcileOnStartup sees their terminal status.
  //
  // Pass the disposition ledger path (issue #1540 review fix — this was
  // previously omitted, so no stale-open termination ever recorded a
  // disposition; see reconciliation.ts's `obsolete` entry for the rationale).
  // The returned id list is also threaded into `runStartupRecoveryPhase` so
  // its post-recovery audit knows exactly which terminations this sweep is
  // contractually covering.
  const staleOpenLaunchTaskIds = reconcileStaleOpenLaunches(taskStore, join(kookrDir, 'disposition.jsonl'));
  reconcileResult.tasksTerminated.push(...staleOpenLaunchTaskIds);
  if (reconcileResult.resumed.length > 0) {
    console.log(`Resumed monitoring: ${reconcileResult.resumed.join(', ')}`);
  }
  if (reconcileResult.markedCompleted.length > 0) {
    console.log(`Marked completed (session dead): ${reconcileResult.markedCompleted.join(', ')}`);
  }
  if (reconcileResult.orphans.length > 0) {
    console.warn(`Orphan sessions (not in tasks): ${reconcileResult.orphans.join(', ')}`);
  }

  // Boot-only: stale `dtach -a` attach clients from dead server generations
  // (issue #1720 leak class 3) — run BEFORE the orphan/terminal-task sweep so
  // a leftover attach process never confuses process-table bookkeeping for
  // the sweep below (the two act on disjoint process kinds, but ordering
  // keeps the boot log easy to read top-to-bottom by leak class).
  if (terminalInstanceDir) {
    try {
      await sessionReaper.runStaleAttacherSweep(terminalInstanceDir);
    } catch (err) {
      console.warn('[session-reaper] stale-attacher boot sweep failed:', err instanceof Error ? err.message : err);
    }
  }
  // Boot: reap true orphans (leak class 1) and terminal-task session leaks
  // (leak class 2) already computed above by `reconcile()`'s orphan detection
  // plus this service's own ownership cross-reference. Also runs periodically
  // from the liveness tick in lifecycle-timers.ts.
  try {
    await sessionReaper.runSweep();
  } catch (err) {
    console.warn('[session-reaper] boot sweep failed:', err instanceof Error ? err.message : err);
  }

  if (issueClaimServices) {
    // Additive reconcile release (R9): reconcile() calls the raw TaskStore
    // terminal methods, bypassing the agent-lifecycle wrappers, so claims for
    // boot-detected dead tasks free up here.
    let bootClaimsReleased = 0;
    for (const id of reconcileResult.tasksCompleted) {
      bootClaimsReleased += issueClaimServices.registry.safeReleaseAllFor(id, 'released').length;
    }
    for (const id of reconcileResult.tasksTerminated) {
      bootClaimsReleased += issueClaimServices.registry.safeReleaseAllFor(id, 'dead_reclaim').length;
    }
    if (bootClaimsReleased > 0) {
      console.log(`[issue-claims] boot reconcile released ${bootClaimsReleased} claim(s)`);
    }

    // Boot backfill (RFC PR 1b / R23): for in-flight tasks that have no
    // issueClaim projection yet, attempt a high-confidence grant through the
    // CAS when GitHubStateStore has exactly one live issue reference for the
    // task. Never invent from playbookParameterValues (stale/re-targeted).
    // Underivable tasks stay a bounded fail-open window and are logged with
    // their ids so operators can see who is unprotected.
    let backfilled = 0;
    const unprotected: string[] = [];
    for (const task of taskStore.getAllTasks()) {
      if (isTerminalStatus(task.status)) continue;
      if (task.issueClaim) continue;
      const issueRefs = githubStateStore
        .getReferences(task.id)
        .filter((r) => r.type === 'issue');
      if (issueRefs.length === 0) {
        unprotected.push(task.id);
        continue;
      }
      // Collapse to unique (owner/repo, number). Multiple distinct issues →
      // underivable (do not guess which one the task "owns").
      const unique = new Map<string, { repo: string; number: number }>();
      for (const ref of issueRefs) {
        const repo = `github.com/${ref.owner}/${ref.repo}`;
        unique.set(`${repo}\t${ref.number}`, { repo, number: ref.number });
      }
      if (unique.size !== 1) {
        unprotected.push(task.id);
        continue;
      }
      const key = [...unique.values()][0]!;
      const sessionId = task.sessions.find(
        (s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted',
      )?.tmuxSession;
      const result = issueClaimServices.registry.claim(
        key,
        { taskId: task.id, ...(sessionId ? { sessionId } : {}) },
      );
      if (result.ok) {
        backfilled++;
      } else {
        // Another live owner already holds it — this task stays unprotected.
        unprotected.push(task.id);
      }
    }
    if (backfilled > 0) {
      console.log(`[issue-claims] boot backfill granted ${backfilled} claim(s)`);
    }
    if (unprotected.length > 0) {
      console.log(
        `[issue-claims] ${unprotected.length} unprotected: ${unprotected.join(', ')}`,
      );
    }
  }
  for (const task of taskStore.getAllTasks()) {
    for (const session of task.sessions) {
      if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted' && !session.crashRecovered) {
        terminalInputCoordinator.registerSession(session.tmuxSession);
      }
    }
  }

  const { activityLedger, hookIngestion, hookWatcher } = createHookRuntime({
    kookrDir,
    hooksDir,
    adapter,
    httpPushTracker,
    taskStore,
    onParseDegradation: ({ event, evaluation, hookIngestion }) => {
      queue.enqueue(event.kookrSessionId, evaluation.anomaly);
      broadcastToAll(evaluation.alert);
      broadcastToAll(createSnapshotMessage({
        monitor,
        serverCwd,
        sttUrl,
        ttsUrl,
        activityMetaProvider: hookIngestion,
        coordinator: { taskStore, auditTailProvider: hookIngestion, suppressions: coordinatorSuppressions },
        getMaxActiveTasks,
        relationTaskStore: taskStore,
        terminalInputSnapshots: terminalInputCoordinator,
        userInputDeliveryProvider: userInputDeliveries,
      }));
    },
  });
  realtime.setCoordinatorAuditTailProvider(hookIngestion);

  // Register transcripts for resumed sessions so token tracker picks up existing
  // data. Filtered to non-terminal Claude Code sessions (issue #1620, change a):
  // terminal tasks never grow again, and non-Claude rollout files are metered
  // elsewhere — registering them was the dominant RSS allocation-churn driver.
  for (const { transcriptPath, taskId } of collectBootTranscriptRegistrations(taskStore.getAllTasks())) {
    tokenTracker.register(transcriptPath, taskId);
  }

  // Late-bound R16 block-alert callback. The Telegram integration is started
  // later in bootstrap (after launchServiceDeps is fully built); this holder
  // lets wireEventPipeline take a stable callback shape now and the integration
  // installs the real implementation when it's ready.
  let onPermissionBlockedHolder: ((taskId: string, promptText: string) => void) | undefined;
  let onTaskOutcomeHolder: ((taskId: string, outcome: TelegramTaskOutcome) => void) | undefined;

  // Broadcast circuit breaker state changes to all connected clients
  circuitBreakerRegistry.onChange(() => {
    broadcastToAll({ type: 'circuitBreakerStatus', breakers: circuitBreakerRegistry.getAllSnapshots() });
  });

  // V8: wire backend transport errors to the log + anomaly queue. The backend
  // itself does not import supervisor types — it emits structured BackendError
  // events and we decide here whether to page, broadcast, or rely on
  // /api/health for passive reporting.
  terminalBackend.onBackendError((err: BackendError) => {
    const line = formatBackendErrorLine(err);
    switch (err.kind) {
      case 'session-attach-recovered':
        // Already logged at WARN inside the backend; additional surface is
        // not needed per the RFC's "silent recovery except for a log line".
        break;
      case 'session-recovery-repaired':
        // Successful post-restart self-heal — informational only. The backend
        // already emitted a structured audit line (kookr-ai/kookr#1345).
        console.log(line);
        break;
      case 'dtach-unavailable':
      case 'manifest-corrupt':
      case 'session-recovery-unverified':
        // A recovered session whose attach transport could not be revived is an
        // actionable operator finding, distinct from the watchdog's stale_agent.
        console.error(line);
        break;
      default:
        console.warn(line);
        break;
    }
  });

  // Register achievement watcher as adapter event handler (separate from event pipeline)
  adapter.onEvent((_tmuxName: string, event) => {
    try {
      achievementWatcher.check({ type: 'agent', event, taskStore, serverCwd });
    } catch (err) {
      console.warn('[achievements] Agent event check failed, continuing', err);
    }
  });

  // Metadata-only refresh (e.g. git info captured) — broadcast snapshot without injecting events
  adapter.onRefreshNeeded(() => {
    broadcastToAll(createSnapshotMessage({
      monitor,
      serverCwd,
      sttUrl,
      ttsUrl,
      activityMetaProvider: hookIngestion,
      coordinator: { taskStore, auditTailProvider: hookIngestion, suppressions: coordinatorSuppressions },
      getMaxActiveTasks,
      relationTaskStore: taskStore,
      terminalInputSnapshots: terminalInputCoordinator,
      userInputDeliveryProvider: userInputDeliveries,
    }));
    broadcastProjectSummaries();
  });

  const { ossRegistryWatcher, reconReportWatcher } = createOssSourceWatchers({
    services: ossServices,
    settings: () => currentSettings,
    debounceMs: ossSourceWatcherDebounceMs,
    runFs: ossSourceWatcherFs,
    broadcastProjectSummaries,
    broadcastOssAttempts,
  });

  // --- Auto-naming helper ---

  /**
   * Fire-and-forget: generate a short AI name for a task. NEVER leaves a task
   * unnamed (issue #1526 Phase C4): when the LLM is unavailable, returns an
   * empty name, or fails outright, the deterministic prompt-derived fallback
   * is applied instead — during the 2026-07-24 grok burst every naming call
   * logged "LLM returned empty name", leaving whole batches unnamed and
   * degrading incident triage.
   */
  function autoNameTask(taskId: string, prompt: string, cwd: string, criteria?: string): void {
    const applyName = (name: string): void => {
      const current = taskStore.getTask(taskId);
      // Upgrade a still-unnamed task or one carrying the deterministic
      // creation-time placeholder (issue #1554: `autoNamed`); never overwrite
      // an authoritative name (explicit playbook/user name, or a prior upgrade).
      if (!current || (current.name && !current.autoNamed)) return;
      taskStore.renameTask(taskId, name);
      console.log(`[task-naming] Named task ${taskId}: "${name}"`);
      broadcastToAll(createSnapshotMessage({
        monitor,
        serverCwd,
        sttUrl,
        ttsUrl,
        activityMetaProvider: hookIngestion,
        coordinator: { taskStore, auditTailProvider: hookIngestion, suppressions: coordinatorSuppressions },
        getMaxActiveTasks,
        relationTaskStore: taskStore,
        terminalInputSnapshots: terminalInputCoordinator,
        userInputDeliveryProvider: userInputDeliveries,
      }));
    };

    if (!llmClient) {
      applyName(deterministicTaskName(prompt, cwd));
      return;
    }
    generateTaskName(llmClient, prompt, cwd, criteria)
      .then((name) => {
        if (!name) {
          console.warn(`[task-naming] LLM returned empty name for task ${taskId}; using deterministic fallback`);
          applyName(deterministicTaskName(prompt, cwd));
          return;
        }
        applyName(name);
      })
      .catch((err) => {
        console.warn(`[task-naming] Failed to name task ${taskId}:`, err instanceof Error ? err.message : err);
        applyName(deterministicTaskName(prompt, cwd));
      });
  }

  // --- HTTP (Hono) ---

  // Shared post-launch registration deps — used by both WS handler and REST routes
  const lifecycleDeps: AgentLifecycleDeps = {
    monitor, watchdog, hookWatcher, interactionLog, githubScanner, autoNameTask, taskStore,
    projectConfigStore,
    terminalInputCoordinator,
    getCleanupWorktreeOnComplete,
    reflectWorktreesDir,
    onTaskOutcome: (taskId, outcome) => {
      onTaskOutcomeHolder?.(taskId, outcome);
    },
    ...(issueClaimServices ? { issueClaimRegistry: issueClaimServices.registry } : {}),
  };

  // Durable idempotency ledger (issue #1526 Phase B / FM2, FM3): protects
  // POST /api/tasks retries (e.g. a client timeout against an overloaded
  // server that had already created the task) from creating a duplicate.
  // Loaded before the launch service deps are built so the first launch
  // served can already see replay state from a prior process.
  const idempotencyLedger = new IdempotencyLedger(kookrDir);
  await idempotencyLedger.load();

  // CPU-aware admission threshold (issue #1630). Read once at boot — this is an
  // operational env knob, not a live-tunable setting; 0 (the default) disables
  // the gate so behavior is unchanged unless an operator opts in.
  const hostLoadAdmissionThreshold = readMaxHostLoadPerCpuFromEnv();
  if (hostLoadAdmissionThreshold > 0) {
    console.log(
      `[backpressure] CPU-aware admission enabled: rejecting launches while host load ` +
      `exceeds ${hostLoadAdmissionThreshold.toFixed(2)}/core (KOOKR_MAX_HOST_LOAD_PER_CPU)`,
    );
  }

  // Holder filled after TaskStateSaveScheduler is constructed below — R5
  // force-flush on claim grant must go through the same scheduler the routes
  // use. Until then flush is a no-op (no launch can complete before serve).
  let flushTasksForClaims: (() => Promise<void>) | undefined;

  // Claim-repo resolver for the launch-path CAS (RFC PR 1b). Built once so
  // fork/upstream lookups share the process-lifetime cache with the HTTP
  // claim routes (createUpstreamOfResolver is invoked again later for routes;
  // each instance has its own cache, which is fine — lookups are rare).
  const launchPathUpstreamOf = createUpstreamOfResolver();

  // Lease-gated relaunch arbiter (issue #1711 / #1699 WS0.5): single mutual-
  // exclusion + post-release backoff for claimIssue launches. Always wired so
  // claimIssue paths cannot bypass the gate when the durable registry is off;
  // dead holders are reclaimed via task-store liveness (orphan → backoff).
  const relaunchArbiter = new RelaunchArbiter({
    isHolderLive: (holderId) => {
      const task = taskStore.getTask(holderId);
      return task !== undefined && !isTerminalStatus(task.status);
    },
  });

  // Per-agent launch success/failure counters (issue #1808) — shared by the
  // launch service (writers) and diagnostics routes (readers).
  const launchOutcomeMetrics = new LaunchOutcomeMetrics();

  // Boot-reliability (launch-latency) signal (issue #1898, WS1.6) — fed one
  // `agent-boot` sample per finalized launch from the #1589 phase timings, and
  // read at round-robin resolution to deprioritize an agent (the motivating
  // case: grok-build's >90s boot hang, #1642) whose recent boots are unhealthy
  // instead of selecting it and relying on the fire() wall-clock cap (#1708).
  const agentBootLatency = new AgentBootLatencyMonitor();

  // Provider-pool health tracker (#1897, WS1.5 of #1699). Created before the
  // schedule runtime so WS1.3 (#1895) can feed substitution events into the
  // same counter the operational-alert evaluator thresholds on.
  const providerHealthTracker = new ProviderHealthTracker();

  // Launch service deps — shared by WS handler, REST routes, and the Ralph
  // cycler's fresh-runtime launcher inside wireEventPipeline.
  const launchServiceDeps: LaunchServiceDeps = {
    taskStore,
    adapterRegistry,
    lifecycleDeps,
    getMaxActiveTasks,
    getDefaultAgentType,
    roundRobinCursor,
    getDeprioritizedAgentTypes: (available) => agentBootLatency.deprioritizedTypes(available),
    recordLaunchBootLatency: (agentType, timings) => agentBootLatency.record(agentType, timings),
    interactionLog,
    terminalBackend,
    isAccepting: () => drainController.isAccepting(),
    isAutomationEnabled: () => !currentSettings.automationKillSwitch,
    validateLaunchCwd: config.validateLaunchCwd,
    bypassAllPermissions,
    idempotencyLedger,
    getLaunchTimeoutMs,
    launchOutcomeMetrics,
    // issue #1526 Phase C / C3: pending-queue depth limit + per-source spawn
    // budget, with the SAME watchdog-aware capacity-ledger builder /api/health
    // uses so a 429 body and the health endpoint tell one story.
    getMaxPendingTasks,
    spawnRateLimiter,
    getReservedActiveSlots,
    getReservedSlotSources,
    getCapacityLedger: () => {
      const now = Date.now();
      return buildCapacityLedger(taskStore.listTasks(), {
        now,
        maxActiveTasks: getMaxActiveTasks(),
        isHungSuspect: (task) => resolveTaskAttentionSignals(task, { queue, watchdog }, now).hungSuspect,
        isLaunching: (task) => taskStore.hasFreshLaunchReservation(task.id),
        reservedActiveSlots: getReservedActiveSlots(),
        reservedSlotSources: getReservedSlotSources(),
      });
    },
    // CPU-aware admission (issue #1630): reject new launches while the host is
    // CPU-saturated so a burst of compile/test-heavy tasks cannot starve the
    // supervisor event loop. Opt-in via KOOKR_MAX_HOST_LOAD_PER_CPU (0 = off,
    // the default), read at boot; the sample is read live per launch.
    getMaxHostLoadPerCpu: () => hostLoadAdmissionThreshold,
    getHostLoadSample: () => ({ load1m: loadavg()[0], cpuCount: cpus().length }),
    // issue #1711: relaunch arbiter is always on. claimIssue launches that
    // also have resolveClaimRepo + registry (flag on) go through the hard
    // lease gate; flag-off keeps R7 claimIssue no-op (no resolveClaimRepo).
    relaunchArbiter,
    // RFC PR 1b: hot-path claim CAS. Flag-off leaves these undefined →
    // claimIssue on LaunchOpts is a strict no-op (R7). When on, the arbiter
    // and the durable registry both admit the launch (mutex + claim).
    ...(issueClaimServices ? {
      issueClaimRegistry: issueClaimServices.registry,
      resolveClaimRepo: (input: { cwd: string; repoFlag?: string }) => resolveClaimRepo(
        input,
        {
          getProjectId,
          activeProjectIds: () => taskStore.getProjectIds(),
          upstreamOf: launchPathUpstreamOf,
        },
      ),
      flushTasks: () => flushTasksForClaims?.() ?? Promise.resolve(),
    } : {}),
  };

  // Re-queue-after-reset scheduler (issue #1896 / #1699 WS1.4): auto-resume a
  // provider-paused issue at its reset time — jittered + token-bucket-bounded,
  // with dedup keyed on the issue-claim relaunch lease (NOT the 24h launch
  // ledger, which cannot span a multi-day pause). The reaper's provider_paused
  // branch records the held issue (TimerDeps.recordProviderPause, below) and the
  // schedule-runner sweeps it once per tick.
  const providerResetScheduler = new ProviderResetScheduler({
    arbiter: relaunchArbiter,
    launch: (opts) => launchTask(launchServiceDeps, opts),
    // Drop a queued resume only when the recorder was DELIVERED (completed) or
    // deliberately cancelled — re-dispatching those would duplicate work the
    // lease alone cannot rule out. A `terminated` recorder is the expected
    // post-reset reap (see lifecycle-timers), so it stays resume-eligible; the
    // sweep's lease check then decides timing.
    shouldResume: (entry) => {
      if (entry.recordedTaskId === undefined) return true;
      const recorder = taskStore.getTask(entry.recordedTaskId);
      if (recorder === undefined) return true;
      return recorder.status !== 'completed' && recorder.status !== 'cancelled';
    },
    onEvent: (event) => {
      if (event.type === 'resume') {
        console.log(
          `[provider-reset] resuming ${event.key.repo}#${event.key.number} `
          + `(resumeAt=${new Date(event.resumeAt).toISOString()})`,
        );
      } else if (event.type === 'resume_failed') {
        console.warn(
          `[provider-reset] resume launch failed for ${event.key.repo}#${event.key.number}: ${event.error}`,
        );
      }
    },
  });

  // Resource watchdog (issue #1724): host-pressure actuator that spawns a
  // briefed, throttled investigation task. OFF by default
  // (`KOOKR_RESOURCE_WATCHDOG=1` to enable). Spawns go through launchTask so
  // capacity/backpressure and reserved-slot posture apply unchanged.
  const resourceWatchdogEnv = readResourceWatchdogConfigFromEnv(process.env);
  const resourceWatchdogStatePath = join(kookrDir, 'resource-watchdog.state.json');
  const resourceWatchdogAuditPath = defaultResourceWatchdogAuditPath(kookrDir);
  const buildResourceWatchdogConfig = (): ResourceWatchdogConfig => ({
    ...readResourceWatchdogConfigFromEnv(process.env),
    taskCwd: process.env.KOOKR_RESOURCE_WATCHDOG_CWD?.trim() || serverCwd,
    stateFilePath: resourceWatchdogStatePath,
    auditLogPath: resourceWatchdogAuditPath,
  });
  const resourceWatchdogService = createResourceWatchdogService({
    getConfig: buildResourceWatchdogConfig,
    sampler: createResourceWatchdogHostSampler({
      getSessionPressure: () => {
        const snap = sessionReaper.getHealthSnapshot();
        return {
          orphanSessionCount: snap.lastOrphanCount,
          terminalLeakCount: snap.lastTerminalLeakCount,
        };
      },
    }),
    stateStore: new FileResourceWatchdogStateStore(resourceWatchdogStatePath),
    auditSink: new JsonlResourceWatchdogAuditSink(resourceWatchdogAuditPath),
    launchTask: (opts) => launchTask(launchServiceDeps, opts),
    // Byte-capped tail only — never readFileSync the whole server.log under
    // pressure (issue #1553 lesson; prod logs can be multi-GB).
    readServerLogTail: () => readTrailingFileBytes(join(kookrDir, 'server.log'), 32 * 1024),
  });

  let remoteLaunchBroker: import('../remote/launch-broker.js').RemoteLaunchBroker | undefined;
  if (process.env.KOOKR_RELAY_URL?.trim()) {
    const { createRemoteLaunchBrokerFromEnv, remoteLaunchFeatureEnabled } = await import('../remote/launch-broker.js');
    if (remoteLaunchFeatureEnabled()) {
      remoteLaunchBroker = createRemoteLaunchBrokerFromEnv({
        launchTask: (opts) => launchTask(launchServiceDeps, opts),
        getActiveLaunchCount: ({ projectId, agentType }) => taskStore.listTasks().filter((task) => (
          (task.status === 'open' || task.status === 'pending' || task.status === 'inProgress')
          && task.projectId === projectId
          && task.agentType === agentType
        )).length,
        getDefaultAgentType,
        allowCollaboratorGrants: true,
      });
      console.log('[remote] launch broker enabled');
    }
  }

  // Terminal-relaunch cap (issue #1901): a non-negative integer bounds runaway
  // relaunch; `0` disables the cap. Invalid/blank values fall back to the
  // service default. Left undefined so the service applies its own default.
  const terminalRelaunchMaxRaw = process.env.KOOKR_LOOP_TERMINAL_RELAUNCH_MAX;
  const terminalRelaunchMaxParsed =
    terminalRelaunchMaxRaw !== undefined ? Number.parseInt(terminalRelaunchMaxRaw, 10) : NaN;
  const terminalRelaunchMax =
    Number.isInteger(terminalRelaunchMaxParsed) && terminalRelaunchMaxParsed >= 0
      ? terminalRelaunchMaxParsed
      : undefined;

  const ralphLoopService = new RalphLoopService({
    taskStore,
    monitor,
    serverCwd,
    broadcastToAll,
    interactionLog,
    ralphCycler,
    terminalBackend,
    tokenTracker,
    launchFreshTaskSession: (task, prompt, opts) => launchFreshTaskSession(launchServiceDeps, task, prompt, opts),
    loopDeliveryWatchdog,
    resolveDeliverySnapshot,
    // Terminal-loop relaunch policy (issue #1901 / WS2.3): re-arm capped/stalled
    // loops through the same WS0.5 arbiter that gates every other relaunch
    // actuator. Disable auto-relaunch with KOOKR_LOOP_TERMINAL_RELAUNCH=false
    // (needs-human escalation on budget exhaustion still fires).
    relaunchArbiter,
    terminalRelaunchEnabled: process.env.KOOKR_LOOP_TERMINAL_RELAUNCH !== 'false',
    ...(terminalRelaunchMax !== undefined ? { terminalRelaunchMax } : {}),
    completeTask: (taskId) => completeTask(taskId, {
      adapter,
      monitor,
      taskStore,
      interactionLog,
      hookWatcher,
      watchdog,
      shadowRegistry,
      tokenTracker,
      onTaskOutcome: (taskId, outcome) => {
        onTaskOutcomeHolder?.(taskId, outcome);
      },
      suppressionTracker,
      terminalInputCoordinator,
      getCleanupWorktreeOnComplete,
      reflectWorktreesDir,
    }),
  });

  // --- Event pipeline ---

  let remoteRelayRuntime: RemoteRelayRuntime | null = null;

  // #1775: shed non-critical full-snapshot rebuilds when event-loop p95 is
  // already saturated. The resource-status service is constructed later, so
  // this holder is filled in once sampling starts (fail-open until then).
  const snapshotShedConfig = readSnapshotShedConfigFromEnv();
  console.log(
    snapshotShedConfig.eventLoopDelayThresholdMs > 0
      ? `[snapshot-shed] non-critical full-snapshot rebuilds skip when event-loop p95 > ` +
          `${snapshotShedConfig.eventLoopDelayThresholdMs}ms`
      : '[snapshot-shed] Snapshot rebuild shed disabled (set KOOKR_SNAPSHOT_SHED_EVENT_LOOP_DELAY_MS to enable)',
  );
  let getEventLoopDelayP95MsForSnapshotShed: () => number | null | undefined = () => null;

  const { abortPendingSuggestion, getSnapshotShedMetrics } = wireEventPipeline({
    adapter, monitor, taskStore, tokenTracker, watchdog,
    githubScanner, llmClient, serverCwd, broadcastToAll,
    telemetryLog,
    ralphCycler,
    ralphLoopService,
    hookIngestion,
    terminalInputCoordinator,
    userInputDeliveries,
    taskShareService: {
      publishTaskProjectionForTask: (taskId) => remoteRelayRuntime?.publishTaskProjectionForTask(taskId),
    },
    onPermissionBlocked: (taskId, promptText) => {
      onPermissionBlockedHolder?.(taskId, promptText);
      remoteRelayRuntime?.publishPermissionBlocked(taskId);
    },
    permissionAlertBreaker,
    getEventLoopDelayP95Ms: () => getEventLoopDelayP95MsForSnapshotShed(),
    snapshotShedEventLoopDelayThresholdMs: snapshotShedConfig.eventLoopDelayThresholdMs,
  });

  // Terminal input deps — used by terminal bridge handlers
  const terminalDeps: TerminalInputDeps = {
    monitor, watchdog, abortPendingSuggestion, broadcastToAll, serverCwd, taskStore,
  };

  // Issue #1721: defer heavy recovery (session reattach + hook replay) until
  // AFTER the HTTP listener binds so /api/health and /api/ready are reachable
  // during the multi-minute recovery window. The gate starts `initializing`
  // and flips to ready only after post-listen recovery completes.
  const startupReadiness = new StartupReadiness(serverStartedAt);
  let startupRecoverySummary: CrashRecoveryResult | null = null;

  // Reap worktrees for tasks reconcile drove to a terminal state at boot
  // (#1727). Prior-process crashes leave dead-session tasks whose worktrees
  // were never reaped — the dominant disk leak in the incident. Mirrors the
  // boot claim-release additive call and honors cleanupWorktreeOnComplete for
  // the completed subset.
  //
  // Ordering is load-bearing: this runs AFTER runStartupRecoveryPhase, which
  // relaunches recoverable dead-session tasks back into their worktree. By
  // now those tasks have been reopened (open/inProgress), so the helper's
  // terminal-status re-check skips them — cleanup only touches tasks that are
  // still terminal, never a worktree recovery just re-adopted.
  //
  // Awaited (not fire-and-forget) so a slow reap cannot outlive boot and race
  // later startup phases; inspectWorktreeCleanup preserves dirty/unmerged/
  // shared worktrees, and per-task errors are swallowed inside the helper.
  try {
    const reaped = await cleanupReconciledTaskWorktrees(
      taskStore,
      reconcileResult,
      interactionLog,
      { cleanupCompleted: getCleanupWorktreeOnComplete() },
    );
    if (reaped.length > 0) {
      console.log(`[worktree-cleanup] boot reconcile reaped worktrees for ${reaped.length} task(s)`);
    }
  } catch (err) {
    console.warn('[worktree-cleanup] boot reap failed:', err instanceof Error ? err.message : err);
  }

  // Reclaim reflect worktrees orphaned by a crash between `git worktree add`
  // and reflect-task completion (plus a 7-day TTL backstop). Best-effort —
  // a sweep failure must never block startup. Independent of session recovery.
  try {
    const { removed, kept } = await sweepReflectWorktrees({ reflectWorktreesDir, taskStore });
    if (removed > 0) {
      console.log(`[reflect-sweep] removed ${removed} orphaned reflect worktree(s), kept ${kept}`);
    }
  } catch (err) {
    console.warn('[reflect-sweep] startup sweep failed:', err instanceof Error ? err.message : err);
  }

  // Durable ops-status card (issue #1995): last-known-good digest on disk for
  // when Discord is down. Live fields are sampled at each edge write; the
  // resource-status service is bound later (TDZ-safe — only called at edge time).
  let getLatestResourceStatusForOps: () => SystemResourceStatus | null = () => null;
  const opsStatusWriter = new OpsStatusWriter({
    filePath: opsStatusPath(kookrDir),
    getLiveFields: () => {
      const capacity = launchServiceDeps.getCapacityLedger?.() ?? null;
      const latest = getLatestResourceStatusForOps();
      const disk = latest?.host?.dataDirectory;
      const sha =
        buildInfo.commitHash && buildInfo.commitHash !== 'dev' ? buildInfo.commitHash : null;
      return {
        sha,
        hungSuspectCount: capacity?.byClass.hungSuspect ?? null,
        dataDirectoryFreePercent: disk?.diskFreePercent ?? null,
        dataDirectoryFreeBytes: disk?.diskFreeBytes ?? null,
        safeMode: getSafeModeStatus(),
      };
    },
  });
  const noteOpsStatusAlert = (
    alert: Extract<ServerMessage, { type: 'alert' }>,
  ): void => {
    void opsStatusWriter.noteFromAlert(alert);
  };

  const { scheduleStore, scheduleService, scheduleRunner, operationalAlertSink } = await createScheduleRuntime({
    kookrDir,
    taskStore,
    launchServiceDeps,
    getMaxActiveTasks,
    broadcastToAll,
    isAccepting: () => drainController.isAccepting(),
    isAutomationEnabled: () => !currentSettings.automationKillSwitch,
    getDeadManScheduleMs,
    getScheduleFailureAlertThreshold,
    getDefaultAgentType,
    // issue #1995: dead-man fire also refreshes the on-disk ops-status card.
    onOperationalAlert: noteOpsStatusAlert,
    // issue #1895 / #1699 WS1.3: feed schedule-level agent substitutions into
    // the WS1.5 provider-health counter.
    recordAgentSubstitution: () => providerHealthTracker.recordSubstitution(),
    // issue #1896: sweep provider-paused resumes on the runner's existing tick.
    resetScheduler: providerResetScheduler,
    // issue #1899 / #1699 WS2.1: arm always-running Ralph loops from schedules
    // that carry a loop config (gated behind the WS0.5 relaunch arbiter).
    ralphLoopService,
    cleanupFailedTask: (taskId) => cancelTask(taskId, {
      adapter,
      monitor,
      taskStore,
      interactionLog,
      hookWatcher,
      watchdog,
      shadowRegistry,
      tokenTracker,
      suppressionTracker,
      terminalInputCoordinator,
      onTaskOutcome: (id, outcome) => {
        onTaskOutcomeHolder?.(id, outcome);
      },
      getCleanupWorktreeOnComplete,
      reflectWorktreesDir,
      ...(issueClaimServices ? { issueClaimRegistry: issueClaimServices.registry } : {}),
    }),
  });
  realtime.setScheduleStore(scheduleStore);
  realtime.setSnapshotAchievementsReady(true);
  const persistenceHealth = new PersistenceHealthTracker();
  // Lifecycle-timer health (issue #1771): per-loop last-fired stamps for
  // GET /api/diagnostics/timer-health — optional on TimerDeps, always wired
  // in production so a wedged save/liveness loop is detectable.
  const timerHealth = new TimerHealthTracker();
  const taskStateSaveScheduler = new TaskStateSaveScheduler({
    taskStore,
    tasksFile,
    sqliteStore: taskSqliteStore,
    queue,
    suppressionTracker,
    persistenceHealth,
  });
  // Wire R5 force-flush for the launch-path claim CAS (holder filled above).
  flushTasksForClaims = () => taskStateSaveScheduler.flush('flush', { force: true });

  // --- Self-diagnostic runner ---
  const serverStartMs = Date.now();
  const diagnosticRunner = new DiagnosticRunner({
    getDetectionStats,
    // Non-cloning view: a count must not pay for a full-store deep clone
    // (issue #1749; same incident class as the #1553 /api/health OOM hotfix).
    getAgentCount: () => taskStore.viewTasks().length,
    getUptimeMs: () => Date.now() - serverStartMs,
    getWsBroadcastCount: () => realtime.getWsBroadcastCount(),
    getEventCounts: () => monitor.getEventCounts(),
    measureSnapshotSizeBytes: () => {
      const msg = createSnapshotMessage({
        monitor,
        serverCwd,
        activityMetaProvider: hookIngestion,
        coordinator: { taskStore, auditTailProvider: hookIngestion, suppressions: coordinatorSuppressions },
        relationTaskStore: taskStore,
        terminalInputSnapshots: terminalInputCoordinator,
        userInputDeliveryProvider: userInputDeliveries,
      });
      return JSON.stringify(msg).length;
    },
    getPersistenceHealthSnapshot: () => persistenceHealth.snapshot(),
  });
  // Diagnostics are on-demand by default; /api/diagnostic/run triggers runNow().

  remoteRelayRuntime = await createRemoteRelayRuntime({
    kookrDir,
    serverCwd,
    serverStartedAt,
    buildInfo,
    terminalBackend,
    terminalInputWriter: terminalInputCoordinator,
    taskStore,
    queue,
    monitor,
    adapter,
    watchdog,
    interactionLog,
    abortPendingSuggestion,
    bypassAllPermissions: config.bypassAllPermissions,
    remoteLaunchBroker,
    markDone: async (taskId) => {
      await completeTask(taskId, {
        adapter,
        monitor,
        taskStore,
        interactionLog,
        hookWatcher,
        watchdog,
        shadowRegistry,
        tokenTracker,
        suppressionTracker,
        terminalInputCoordinator,
        queue,
        getCleanupWorktreeOnComplete,
        reflectWorktreesDir,
      });
    },
  });
  await remoteRelayRuntime.startConfigured();

  const findingEvidenceReviewEnabled = process.env.KOOKR_FINDING_REVIEW_ENABLED === 'true';
  const findingEvidenceReviewHmacKey = findingEvidenceReviewEnabled
    ? getOrCreateFindingEvidenceReviewHmacKey(kookrDir)
    : Buffer.alloc(32, 0);
  const findingEvidenceReviewLogStore = ReviewLogStore.forKookrDir(kookrDir);
  const supervisorFeedbackCaseStore = SupervisorFeedbackCaseStore.forKookrDir(kookrDir);
  const detectionStatsStore = DetectionStatsStore.forKookrDir(kookrDir);
  // Restore cumulative detector telemetry so FP/FN/suppression rates survive
  // the daily restarts; a missing/corrupt file just leaves counters at zero.
  const persistedDetectionStats = await detectionStatsStore.load();
  if (persistedDetectionStats) hydrateDetectionStats(persistedDetectionStats);
  const findingEvidenceReviewConfig = readFindingEvidenceReviewConfigFromEnv(process.env, findingEvidenceReviewHmacKey, buildInfo.commitHash);
  const findingEvidenceReviewSamplerConfig = readFindingEvidenceReviewSamplerConfigFromEnv(process.env);
  const contactShare = new ContactShareReadModel();
  // `privateNetworkNodeId` + `privateNetworkAuditLog` are constructed earlier
  // (alongside the viewer-grant store) so the sweep audit hook is wired before
  // the sweep timer starts; see that block above.
  let collaborationListenerForDiagnostics: CollaborationListenerHandle | null = null;
  let privateNetworkLastAuthFailure: CollaborationAuthFailureDiagnostic | undefined;
  const findingEvidenceReviewSampler = new FindingEvidenceReviewSampler({
    candidateReader: {
      listReviewCandidates: (limit) => monitor.getFindingEvidenceReviewCandidates(limit),
    },
    llmClient: llmClient ?? null,
    serviceConfig: findingEvidenceReviewConfig,
    samplerConfig: findingEvidenceReviewSamplerConfig,
    reviewLogStore: findingEvidenceReviewLogStore,
    queueStore: FindingEvidenceReviewQueueStore.forKookrDir(kookrDir),
    attentionMissSampler: new RuntimeAttentionMissSampler({
      listTasks: () => taskStore.getAllTasks(),
      hasActiveFinding: (agentId) => queue.getActiveAnomaly(agentId) !== null,
      recentFindingStateFor: (agentId) => queue.getSnoozedUntil(agentId) === null ? 'none' : 'recent_snoozed',
    }, {
      maxSamples: findingEvidenceReviewSamplerConfig.candidateReadLimit,
      maxPerStratum: Math.max(1, Math.min(3, findingEvidenceReviewSamplerConfig.maxCandidatesPerInterval)),
    }),
  });

  const upstreamOf = createUpstreamOfResolver();
  // Single #1715 service instance shared by HTTP handle + terminal reconcile (PR2).
  const pipelineStarvation = new PipelineStarvationService({
    taskStore,
    launcher: (opts) => launchTask(launchServiceDeps, opts),
    // issue #1995: starvation fire edges also refresh the on-disk ops-status card.
    broadcast: (msg) => {
      broadcastToAll(msg);
      if (msg.type === 'alert') noteOpsStatusAlert(msg);
    },
    kookrDir,
    log: (line) => console.log(line),
  });
  const app = createRoutes({
    environmentBlockerRegistry,
    pipelineStarvation,
    opsStatusWriter,
    ...(issueClaimServices ? {
      issueClaims: {
        enabled: true,
        registry: issueClaimServices.registry,
        decorate: (record) => decorateClaim(record, {
          getAgentEvents: (sessionId) => monitor.getAgentEvents(sessionId),
        }),
        resolveRepo: (input) => resolveClaimRepo(
          {
            cwd: input.cwd ?? serverCwd,
            ...(input.repoFlag !== undefined ? { repoFlag: input.repoFlag } : {}),
          },
          { getProjectId, activeProjectIds: () => taskStore.getProjectIds(), upstreamOf },
        ),
        // R5: force — the claim setters don't mark the scheduler dirty, and a
        // non-forced flush() early-returns when clean, silently voiding the
        // crash-durability guarantee the RFC requires on grant/release.
        flushTasks: () => taskStateSaveScheduler.flush('flush', { force: true }),
        getTaskStatus: (taskId) => taskStore.getTask(taskId)?.status,
        // #1351: default claim-repo resolution to the CLAIMANT TASK's
        // configured checkout (not serverCwd) when the caller omits an
        // explicit cwd, so a task configured for repo A can claim A even when
        // this server process was bootstrapped from repo B.
        getTaskCwd: (taskId) => taskStore.getTask(taskId)?.cwd,
      },
    } : {}),
    taskStore, monitor, queue, adapter, hookWatcher, watchdog,
    interactionLog,
    launchOutcomeMetrics,
    agentBootLatency,
    taskTailStore,
    githubScanner, githubStateStore, buildInfo, serverStartedAt,
    serverCwd, serverPort: port, pluginUpdateBin: agentBin, kookrDir, frontendDir, broadcastToAll,
    getOperationalAlertHistory: () => resourceStatusService.getOperationalAlertHistory(),
    // issue #1590: feed the load-based POST /api/tasks admission gate the same
    // already-sampled event-loop p95 the health snapshot exposes.
    getLatestResourceStatus: () => resourceStatusService.getLatest(),
    llmClient,
    sessionHealthService,
    timerHealth,
    ...(findingEvidenceReviewEnabled ? { findingEvidenceReviewHmacKey } : {}),
    findingEvidenceReviewSampler,
    remoteShare: remoteRelayRuntime.remoteShare,
    getCleanupWorktreeOnComplete,
    relayConnection: remoteRelayRuntime.relayConnection,
    contactShare,
    collaborationDiagnostics: {
      get: async () => {
        const config = collaborationListenerForDiagnostics?.config ?? readPrivateNetworkCollaborationConfig({
          env: process.env,
          dashboardHost: host,
          dashboardPort: port,
        });
        const identityStore = new ContactIdentityStore({ kookrDir, auditLog: privateNetworkAuditLog });
        const shareStore = new CollaborationShareStore({
          kookrDir,
          auditLog: privateNetworkAuditLog,
          taskExists: (taskId) => Boolean(taskStore.getTask(taskId)),
        });
        await identityStore.load();
        await shareStore.load();
        return buildCollaborationDiagnostics({
          config,
          listenerStatus: collaborationListenerForDiagnostics?.status ?? 'disabled',
          trust: identityStore.diagnostics(),
          shares: shareStore.diagnostics(),
          audit: privateNetworkAuditLog.status(),
          ...(privateNetworkLastAuthFailure ? { lastAuthFailure: privateNetworkLastAuthFailure } : {}),
          now: () => new Date(),
        });
      },
    },
    auditSinks: {
      getAllSnapshots: () => {
        const status = privateNetworkAuditLog.status();
        return [{
          sink: 'private_network_collaboration',
          writable: status.writable,
          appendFailureCount: status.appendFailureCount,
        }];
      },
    },
    ...(webhookNotifier ? {
      webhookNotifier: {
        getDeliveryCounts: () => webhookNotifier.getDeliveryCounts(),
      },
    } : {}),
    shadowRegistry, httpPushTracker, hookIngestion, activityLedger, launchServiceDeps, sttUrl,
    ttsUrl, ttsVoice: config.ttsVoice, speakFindingEnabled: config.speakFindingEnabled,
    projectConfigStore, projectSidebarStore, circuitBreakerRegistry,
    ossAttemptStore, ledgerAnalytics, ossRefresher, broadcastOssAttempts, getRegistryActiveRepos,
    skillDiscoveryState, prLessonsState, getRegistryActiveProjects, broadcastProjectSummaries,
    suppressionTracker, scheduleService, scheduleRunner,
    taskStateSaveScheduler,
    onTaskOutcome: (taskId, outcome) => {
      onTaskOutcomeHolder?.(taskId, outcome);
    },
    diagnosticRunner,
    terminalBackend,
    terminalInputRttMetrics,
    sessionReaper,
    nonCriticalTimerPause: nonCriticalTimerPauseGate,
    snapshotShed: { getSnapshotShedMetrics },
    finishedAwaitingAckTtlReclaimMetrics,
    hungSuspectTtlReclaimMetrics,
    resourceWatchdog: resourceWatchdogService,
    deliveryTrace,
    coordinatorSuppressions,
    drainController,
    apiAuth,
    sessionAuth: config.sessionAuth,
    // #808: owner share control surface + health block. The viewer feature is a
    // non-loopback concern (a viewer must reach the host over the network), so it
    // is exposed only when the API-token gate is active; on a loopback bind the
    // share routes report `share-feature-disabled` and `/api/health` omits the
    // `viewerBroadcaster` block, keeping the default localhost flow untouched (R9).
    ...(apiAuth.required
      ? {
          viewerShare: {
            grantStore: viewerGrantStore,
            registry: connectionRegistry,
            auditLog: privateNetworkAuditLog,
          },
        }
      : {}),
    startupRecoverySummary: null,
    getStartupRecoverySummary: () => startupRecoverySummary,
    startupReadiness,
    ralphCycler,
    tokenTracker,
    tasksFile,
    ralphLoopService,
    worktreeRegistry,
    getMaxActiveTasks,
    getAutoCloseCompletionReadyDelayMs,
    getCompletionReadyTtlMs,
    auditLogPath: join(kookrDir, 'audit.jsonl'),
    settings: {
      get: () => currentSettings,
      getLoadedFromDefaults: () => settingsLoadedFromDefaults,
      getLoadWarnings: () => settingsLoadWarnings,
      update: async (newSettings: KookrSettings) => {
        const prev = currentSettings;
        // `roundRobinIndex` is server-managed — advanced per launch by the
        // round-robin cursor, never edited by an operator. A settings PUT
        // carries whatever cursor the client last read, which may be stale;
        // force the live value so a save never rolls the rotation back.
        // Kill-switch since bookkeeping (issue #1710): engage sets
        // `safeModeSince`; disengage clears it; unrelated saves preserve it.
        const withKillSwitch = applyKillSwitchTransition(
          prev,
          {
            ...newSettings,
            roundRobinIndex: currentSettings.roundRobinIndex,
          },
          new Date().toISOString(),
        );
        const merged: KookrSettings = withKillSwitch;
        // Persist to disk FIRST. If saveSettings (inside applySettingsSideEffects)
        // throws, the in-memory `currentSettings` must not advance — otherwise
        // getMaxActiveTasks and other live getters would diverge from what's
        // on disk and the next snapshot would lie until the next restart.
        const warnings = await applySettingsSideEffects({
          prevSettings: prev,
          newSettings: merged,
          settingsFile,
          githubScanner,
          watchdog,
          monitor,
        });
        currentSettings = merged;
        settingsLoadedFromDefaults = false;
        settingsLoadWarnings = [];
        // Issue #1995: SAFE MODE engage edge writes the durable ops-status card
        // so a kill-switch flip is visible on disk when Discord is down.
        void opsStatusWriter.noteSafeModeEngaged(
          merged.automationKillSwitch,
          merged.safeModeSince ? `since ${merged.safeModeSince}` : undefined,
        );
        // applySettingsSideEffects wrote `merged` to disk, but a launch may
        // have advanced the cursor during the await above — that snapshot's
        // `roundRobinIndex` is then stale. Re-persist the live settings
        // through the serialized writer so the on-disk cursor converges on
        // the freshest value.
        await persistSettings();
        if (prev.autoWatchOssSources !== newSettings.autoWatchOssSources) {
          if (newSettings.autoWatchOssSources) {
            ossRegistryWatcher.start();
            reconReportWatcher.start();
          } else {
            ossRegistryWatcher.close();
            reconReportWatcher.close();
          }
        }
        // The settings PUT route broadcasts a fresh snapshot after this
        // resolves (see settings-routes.ts) and threads `getMaxActiveTasks`
        // via RouteDeps, so the cap indicator updates live — no need to
        // duplicate the broadcast here.
        return warnings;
      },
    },
  });

  const {
    leaseService,
    serverProjectId,
    policyResolver,
    attemptRepository,
  } = await createContributionWorkspaceServices({ kookrDir, serverCwd, taskStore });

  const takePredeleteSnapshot = async (): Promise<void> => {
    // Fail loud, not silent. rfc-task-loss-prevention D3 keeps the snapshot
    // HELPER's internal "copy failed" errors as warn-and-continue (so a failed
    // rotation never blocks the primary save path) — but the caller guarantee
    // of this callback is different: if the snapshot write itself cannot
    // complete, the caller (clearCompleted) MUST abort the destructive op.
    // Letting the delete proceed without a snapshot recreates the exact
    // silent-data-loss pipeline this RFC set out to prevent.
    //
    // Under SQLite (#1755) this force-flushes every row and still materializes
    // a JSON predelete snapshot for recovery tooling.
    const snoozes = serializeSnoozed(queue, taskStore);
    const suppressionState = suppressionTracker?.export();
    try {
      await persistTaskState({
        taskStore,
        tasksFile,
        policy: 'predelete',
        snoozes,
        suppressionState,
        sqliteStore: taskSqliteStore,
        forceFull: true,
      });
      persistenceHealth.recordSuccess('task_state');
    } catch (err) {
      persistenceHealth.recordFailure('task_state', err);
      throw err;
    }
  };

  // Payload-diet stats line (issue #1526 Phase C / C2): logged once at boot
  // and after every scheduled maintenance sweep.
  const getPayloadDietStats = (): PayloadDietStats => {
    const tasks = taskStore.listTasks();
    return {
      trackedTasks: tasks.length,
      terminalTasks: tasks.filter((task) => isTerminalStatus(task.status)).length,
      lastSnapshotBytes: lastSnapshotPayloadBytes,
    };
  };

  const operationalAlertConfig = resetOperationalAlertConfig();
  // providerHealthTracker is constructed earlier (before createScheduleRuntime)
  // so schedule-level substitutions (#1895) and the ops-alert evaluator share
  // one counter. Durable JSONL sink (#1699 WS0.3): every operational-alert
  // fire/clear edge is appended to `operational-alerts.jsonl` so an incident is
  // reconstructable from disk even when no dashboard client was connected
  // during it. Reuse the single sink instance the schedule runtime already owns
  // (rather than minting a second one on the same file) so status()/lastFailure
  // stay unified.
  const recordOperationalAlertToSink = bindOperationalAlertSink(
    operationalAlertSink,
    noteOpsStatusAlert,
  );
  const operationalAlertEvaluator = createOperationalAlertEvaluator(
    getOperationalAlertConfig,
    () => persistenceHealth.snapshot(),
    () => providerHealthTracker.snapshot(),
  );
  if (operationalAlertEvaluator.hasEnabledRules()) {
    const sustainSeconds = (operationalAlertConfig.sustainSamples * RESOURCE_STATUS_INTERVAL_MS) / 1000;
    console.log(
      `[ops-alerts] thresholds: cpu=${operationalAlertConfig.cpuPercent || 'off'}% ` +
        `mem=${operationalAlertConfig.memoryPercent || 'off'}% ` +
        `eventLoopDelay=${operationalAlertConfig.eventLoopDelayMs || 'off'}ms ` +
        `processRss=${operationalAlertConfig.processRssBytes || 'off'}B ` +
        `dataDirFree=${operationalAlertConfig.dataDirectoryFreePercent || 'off'}%/` +
        `${operationalAlertConfig.dataDirectoryFreeBytes || 'off'}B ` +
        `persistence=on ` +
        `(sampled-resource alerts fire after ${operationalAlertConfig.sustainSamples} samples ≈ ${sustainSeconds}s sustained); ` +
        `circuitBreakerOpen=${operationalAlertConfig.circuitBreakerOpenMs || 'off'}ms ` +
        `providerFallback=${operationalAlertConfig.providerFallbackSubstitutions || 'off'}` +
        `/${operationalAlertConfig.providerFallbackWindowMs || 'off'}ms ` +
        `providerPaused=${operationalAlertConfig.providerPausedMs || 'off'}ms`,
    );
  } else {
    console.log('[ops-alerts] Operational alerts disabled (set KOOKR_ALERT_* thresholds to enable)');
  }
  // Load-based admission for POST /api/tasks (issue #1590): shed spawn POSTs
  // with 503 + Retry-After when the sampled event-loop delay p95 is saturated.
  const admissionControlConfig = readAdmissionControlConfigFromEnv();
  console.log(
    admissionControlConfig.eventLoopDelayThresholdMs > 0
      ? `[admission] POST /api/tasks sheds at event-loop p95 >= ` +
          `${admissionControlConfig.eventLoopDelayThresholdMs}ms ` +
          `(503, Retry-After ${admissionControlConfig.retryAfterSeconds}s)`
      : '[admission] Load-based POST /api/tasks admission disabled (set KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS to enable)',
  );
  const resourceStatusService = createResourceStatusService({
    sampler: resourceStatusSampler ?? createSystemResourceSampler({ dataDirectoryPath: kookrDir }),
    broadcastToAll,
    alertEvaluator: operationalAlertEvaluator,
    onOperationalAlert: recordOperationalAlertToSink,
    getCircuitBreakerSnapshots: () => circuitBreakerRegistry.getAllSnapshots(),
    intervalMs: resourceStatusIntervalMs,
    // #1725 / #1785 / #1775: feed the same sampled event-loop delay p95 into
    // the dashboard WS load-shed gate, non-critical timer pause gate, and
    // snapshot rebuild shed — reuses this measurement instead of a second monitor.
    onEventLoopDelaySample: (delayMs) => {
      realtime.noteEventLoopDelaySample(delayMs);
      nonCriticalTimerPauseGate.noteSample(delayMs);
    },
  });
  // Issue #1995: bind the live resource sample for ops-status free-disk fields.
  getLatestResourceStatusForOps = () => resourceStatusService.getLatest();
  getEventLoopDelayP95MsForSnapshotShed = () =>
    resourceStatusService.getLatest()?.server.eventLoopDelayP95Ms ?? null;

  // Periodic memory ledger (issue #1612). Opt-in (KOOKR_MEMORY_LEDGER=1) so it
  // costs nothing by default; when enabled it logs a structured `[mem-ledger]`
  // line with process memory plus per-subsystem retention counts, letting a
  // soak bisect the dominant RSS retainer with evidence rather than a guess.
  const memoryLedgerConfig = readMemoryLedgerConfigFromEnv();
  const memoryLedger = createMemoryLedger({
    intervalMs: memoryLedgerConfig.intervalMs,
    collectSubsystems: () => ({
      monitor: monitor.getRetentionMetrics(),
      hookIngestion: hookIngestion.getRetentionMetrics(),
      hookWatcher: hookWatcher.getRetentionMetrics(),
    }),
  });
  if (memoryLedgerConfig.enabled) {
    memoryLedger.start();
  }

  // Lesson-write spool recovery + prolonged KB degradation alert (issue #1519).
  // Spool lives under ~/.kookr/playbook-state (user-scoped, not per-port dataDir)
  // so lessons survive across prod/dev instances on the same host.
  // Disabled when KOOKR_LESSON_SPOOL=0 (also set in vitest.config.ts so unit
  // tests do not shell out to `kb doctor` every 5 minutes or on the 15s boot tick).
  const lessonSpoolDisabled = process.env.KOOKR_LESSON_SPOOL === '0';
  const lessonSpoolService = new LessonSpoolService({
    spoolDir: defaultSpoolDir(process.env),
    emitAlert: (alert) => broadcastToAll(alert),
  });
  if (!lessonSpoolDisabled) {
    lessonSpoolService.start();
  }

  // Agent signal outbox drain (issue #1541). When agents raised
  // `kookr signal` while this daemon was down, entries sit under
  // ~/.kookr/playbook-state/signal-outbox/; this service applies them on boot
  // and every 30s. Disabled when KOOKR_SIGNAL_OUTBOX=0 (also set in vitest).
  const signalOutboxDisabled = process.env.KOOKR_SIGNAL_OUTBOX === '0';
  const signalOutboxService = new SignalOutboxService({
    taskStore,
    spoolDir: defaultSignalOutboxDir(process.env),
    // Same hooksDir root the HTTP signal route uses so outbox drains cannot
    // bypass the lesson-decision gate (issue #1608).
    kookrDir,
    onTaskOutcome: (taskId, outcome) => {
      try {
        onTaskOutcomeHolder?.(taskId, outcome);
      } catch (err) {
        console.warn('[signal-outbox] onTaskOutcome threw:', err);
      }
    },
    onDelivered: () => {
      try {
        broadcastToAll(createSnapshotMessage({
          monitor,
          serverCwd,
          sttUrl,
          ttsUrl,
          activityMetaProvider: hookIngestion,
          coordinator: {
            taskStore,
            auditTailProvider: hookIngestion,
            suppressions: coordinatorSuppressions,
          },
          getMaxActiveTasks,
          relationTaskStore: taskStore,
          terminalInputSnapshots: terminalInputCoordinator,
          userInputDeliveryProvider: userInputDeliveries,
        }));
      } catch (err) {
        console.warn('[signal-outbox] broadcast threw:', err);
      }
    },
  });
  if (!signalOutboxDisabled) {
    signalOutboxService.start();
  }

  // Operator-signal delivery bridge (issue #1716). Tails the operator-signal
  // outbox and pushes new alert/clear signals to Discord / Telegram. Off unless
  // a channel is configured (KOOKR_DISCORD_WEBHOOK_URL and/or
  // KOOKR_SIGNAL_TELEGRAM_CHAT_ID + KOOKR_TELEGRAM_BOT_TOKEN).
  const operatorSignalDir = defaultOperatorSignalDir(process.env);
  const signalDeliveryConfig = readSignalDeliveryConfigFromEnv(process.env);
  const signalDeliveryService = signalDeliveryConfig
    ? new SignalDeliveryService({ dir: operatorSignalDir, config: signalDeliveryConfig })
    : null;
  signalDeliveryService?.start();

  // Fire-and-forget: spool an operator signal for any operational-alert
  // fire/recover broadcast (deploy-lag, prod-smoke) so the delivery bridge can
  // push it outbound. Only active when a delivery channel is configured, so we
  // never grow a spool nothing drains. Wrap broadcastToAll for the detectors.
  const emitOperationalSignal = (msg: ServerMessage): void => {
    const input = operationalAlertToSignal(msg as OperationalAlertLike);
    if (!input) return;
    void writeOperatorSignal(operatorSignalDir, input).catch((err) => {
      console.warn('[signal-delivery] failed to spool operational signal:', err);
    });
  };
  const detectorBroadcast: (msg: ServerMessage) => void = signalDeliveryConfig
    ? (msg) => { broadcastToAll(msg); emitOperationalSignal(msg); }
    : broadcastToAll;

  // --- Quota monitoring (polls Anthropic OAuth usage endpoint) ---
  const quotaAdapter = new QuotaAdapter(120_000); // 120s interval
  // Live headroom for claude-code launch admission (issue #1894 / #1699 WS1.2)
  // + plan-quota rotation / binding-window cache (issue #1936). Wired after
  // the adapter is constructed; the launch-service deps object is already
  // shared with every launcher, so mutating the optional getter here is
  // enough. getLiveHeadroom() forces a poll — never a stale getLatest().
  //
  // Skip under Vitest: QuotaAdapter reads the real ~/.claude credentials and
  // would hit Anthropic's usage API on every integration launch, making the
  // suite non-hermetic (and fail-closed when the operator's plan is near the
  // exhaustion threshold). Unit tests inject getLiveQuotaHeadroom / the cache
  // directly.
  if (!process.env.VITEST) {
    launchServiceDeps.planQuotaBindingCache = new PlanQuotaBindingCache();
    launchServiceDeps.getLiveQuotaHeadroom = () => quotaAdapter.getLiveHeadroom();
  }

  const wsConnectionDeps: WsConnectionDeps = {
    taskStore, queue, monitor, adapter, adapterRegistry,
    interactionLog, telemetryLog, buildInfo, serverStartedAt,
    serverCwd, sttUrl, ttsUrl, abortPendingSuggestion,
    lifecycleExtras: {
      hookWatcher, watchdog, shadowRegistry, tokenTracker,
      taskTailStore,
      onTaskOutcome: (taskId, outcome) => {
        onTaskOutcomeHolder?.(taskId, outcome);
      },
      // Silent-failure integrity (issue #1712): audit a WS-driven complete that
      // reclassifies to provider_transient.
      auditLogPath: join(kookrDir, 'audit.jsonl'),
      ...(issueClaimServices ? { issueClaimRegistry: issueClaimServices.registry } : {}),
    },
    agentLifecycleDeps: lifecycleDeps, broadcastToAll,
    broadcastProjectSummaries,
    // issue #1526 Phase C / C3: launches arriving over this wiring come from
    // the WS transport (dashboard launch/relaunch/playbook messages) — tag
    // them so the spawn budget buckets them as `websocket`, not anonymous
    // `api`. An opts-level source (none today on WS paths) would still win.
    launchTask: (opts, serverOpts) => launchTask(launchServiceDeps, { launchSource: 'websocket', ...opts }, serverOpts),
    githubStateStore, ledgerAnalytics, projectConfigStore, projectSidebarStore,
    skillDiscoveryState, prLessonsState, getRegistryActiveProjects,
    achievementWatcher,
    getQuotaStatus: () => quotaAdapter.getLatest(),
    circuitBreakerRegistry,
    getMaxActiveTasks, getCleanupWorktreeOnComplete, suppressionTracker,
    availableAgentTypes: AVAILABLE_AGENT_TYPES.filter((item) => adapterRegistry.getTypes().includes(item.type)),
    defaultAgentType: getDefaultAgentType(),
    getDefaultAgentType,
    bypassAllPermissions,
    getDrainStatus: () => drainController.status(),
    getSafeModeStatus,
    activityMetaProvider: hookIngestion,
    coordinatorAuditTailProvider: hookIngestion,
    coordinatorSuppressions,
    scheduleService,
    ralphLoopService,
    getDiagnosticStatus: () => diagnosticRunner.getStatus(),
    getLatestResourceStatus: () => resourceStatusService.getLatest(),
    startupAlerts,
    workspaceEnabled: true,
    attemptRepository,
    policyResolver,
    leaseService,
    serverProjectId,
    takePredeleteSnapshot,
    auditLogPath: join(kookrDir, 'audit.jsonl'),
    supervisorFeedbackCaseStore,
    feedbackDir: join(kookrDir, 'feedback'),
    taskSnapshotDir: join(kookrDir, 'task-snapshots'),
    reflectWorktreesDir,
    hooksDir,
    selectionController,
    terminalInputCoordinator,
    userInputDeliveries,
    buildScopedSnapshot,
    snapshotPayloadSizePolicy: DEFAULT_SNAPSHOT_PAYLOAD_SIZE_LIMITS,
    // #1754 Stage 1: stamp connect-time + resync snapshots with the current
    // `(epoch, seq)` so clients initialize and re-base their stream position.
    getStreamPosition: realtime.getStreamPosition,
  };

  // Unattended worktree-reclaim scheduler (issue #1578). Disabled unless
  // KOOKR_WORKTREE_RECLAIM_CRON is a valid cron expression, so unconfigured
  // servers see no behavior change. Reuses the same workspace deps the
  // interactive sweep uses and the shared audit log.
  const reclaimScheduleConfig = resolveReclaimScheduleConfig(process.env);
  const scheduledWorktreeReclaimRunner = new ScheduledWorktreeReclaimRunner({
    config: reclaimScheduleConfig,
    cleanupDeps: { policyResolver, leaseService, attemptRepository },
    projectConfigStore,
    taskStore,
    resolveRepoPath: async (projectId) => {
      const context = await resolveWorkspaceContext(projectId, {
        taskStore,
        serverCwd,
        serverProjectId,
        projectConfigStore,
      });
      return context.repoPath;
    },
    auditLogPath: join(kookrDir, 'audit.jsonl'),
    logger: console,
  });

  const backgroundServices = startBackgroundServices({
    ossAttemptStore,
    ledgerAnalytics,
    projectConfigStore,
    broadcastProjectSummaries,
    broadcastOssAttempts,
    broadcastToAll,
    githubScanner,
    githubPollingEnabled: currentSettings.githubPollingEnabled,
    scheduleRunner,
    resourceStatusService,
    resourceWatchdogService,
    findingEvidenceReviewSampler,
    scheduledWorktreeReclaimRunner,
    timerDeps: {
      monitor, taskStore, queue, adapter, adapterRegistry, tokenTracker, watchdog,
      hookWatcher, terminalBackend, hooksDir, tasksFile, serverCwd,
      saveIntervalMs, livenessIntervalMs, broadcastToAll,
      shadowRegistry, agentLifecycleDeps: lifecycleDeps, taskTailStore,
      quotaAdapter, getMaxActiveTasks, getAutoCloseCompletionReadyDelayMs, suppressionTracker,
      // issue #1896: when the reaper detects a provider_paused task, register
      // its issue for auto-re-dispatch at the quota reset and tell the reaper
      // whether to keep holding the slot (before reset) or reap it (after reset,
      // freeing the relaunch lease so the scheduled resume can hand off a fresh
      // task). No issue-claim → nothing to dedup a resume on, so keep holding.
      recordProviderPause: (task) => {
        const claim = task.issueClaim;
        if (!claim) return { holdForResume: true };
        const now = Date.now();
        // `record` LATCHES the reset time at first observation and returns it, so
        // this comparison flips to false once the latched reset elapses (unlike a
        // freshly-resolved reset, which is always in the future — see #1896 review).
        const { resetsAt: latchedResetsAt } = providerResetScheduler.record({
          key: { repo: claim.repo, number: claim.number },
          recordedTaskId: task.id,
          resetsAt: resolveProviderResetMs(quotaAdapter.getLatest(), now),
          relaunch: buildProviderResumeLaunch({
            id: task.id,
            prompt: task.prompt,
            cwd: task.cwd,
            criteria: task.criteria,
            name: task.name,
            playbookId: task.playbookId,
            playbookParameterValues: task.playbookParameterValues,
            projectId: task.projectId,
            agentType: task.agentType,
            autoCloseOnSignal: task.autoCloseOnSignal,
            issueClaim: { repo: claim.repo, number: claim.number },
            provenance: task.provenance,
          }),
        });
        return { holdForResume: now < latchedResetsAt };
      },
      getCompletionReadyTtlMs,
      getPendingTaskTtlMs,
      getFinishedAwaitingAckTtlMs,
      isTaskHoldingOpenPr,
      finishedAwaitingAckTtlReclaimMetrics,
      getHungSuspectTtlMs,
      hungSuspectTtlReclaimMetrics,
      getPostMergeCleanupBudgetMs,
      resolveMergedPr,
      loopDeliveryWatchdog,
      signalOutboxSpoolDir: defaultSignalOutboxDir(process.env),
      auditLogPath: join(kookrDir, 'audit.jsonl'),
      // Silent-failure integrity (issue #1712): bounded auto-retry + operator
      // alert for schedule-provenance provider_transient failures the auto-close
      // sweep would otherwise mask as `completed`.
      providerTransientRetry: createProviderTransientRetryHandler({
        taskStore,
        launchTask: (opts) => launchTask(launchServiceDeps, opts),
      }),
      providerTransientAlert: createProviderTransientAlertHandler({
        enqueueAlert: ({ note }) => {
          broadcastToAll({
            type: 'alert',
            agentId: '',
            summary: 'Scheduled task failed (provider-transient) — auto-retries exhausted',
            details: note,
            severity: 'critical',
          });
        },
      }),
      dispositionLedgerPath: join(kookrDir, 'disposition.jsonl'),
      reportsDir: join(kookrDir, 'reports'),
      getHungTaskReapEnabled, getHungTaskReapMs,
      sessionReaper,
      budgetChecker, projectConfigStore, progressBudgetBurnDiagnostics,
      detectionStatsStore,
      persistenceHealth,
      timerHealth,
      nonCriticalTickPause: nonCriticalTimerPauseGate,
      worktreeRegistry,
      worktreeRegistryRepoPath: serverCwd,
      getDashboardClientCount: () => connectionRegistry.dashboardCount(),
      bypassAllPermissions,
      userInputDeliveries,
      taskStateSaveScheduler,
      // Scheduled data-directory prune (idea-scout rank 4). Off unless
      // KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS is set to a positive number.
      maintenancePrune: {
        dataDir: kookrDir,
        intervalHours: resolveMaintenancePruneIntervalHours(process.env),
        // Aged terminal task-record prune (issue #1526 Phase C / C2): runs on
        // the same tick; the shrunken store persists on the next periodic save.
        pruneTaskRecords: () => pruneAgedTaskRecords({
          taskStore,
          monitor,
          takePredeleteSnapshot,
          auditLogPath: join(kookrDir, 'audit.jsonl'),
        }),
        onTaskRecordsPruned: () => {
          // Push a fresh snapshot so dashboards drop the pruned rows now
          // rather than on the next tick broadcast.
          broadcastToAll(createSnapshotMessage({
            monitor,
            serverCwd,
            activityMetaProvider: hookIngestion,
            coordinator: { taskStore, auditTailProvider: hookIngestion, suppressions: coordinatorSuppressions },
            relationTaskStore: taskStore,
          }));
        },
        getPayloadDietStats,
      },
      // Relay-orphan sweep (issue #1723 / #1885). ON by default (1h); set
      // KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS=0 to disable. Reaps leaked
      // relay/server.ts processes whose task worktree is gone OR which carry a
      // test-runner env marker — production-safe (a live relay's cwd always
      // exists and it carries no test marker, so it is never selected).
      relayOrphanSweep: {
        intervalHours: resolveRelayOrphanSweepIntervalHours(process.env),
      },
      // Reflect-worktree orphan sweep (issue #1860). Default 1h so long-lived
      // instances reclaim crash orphans without a restart; set
      // KOOKR_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS=0 to disable. Startup still
      // sweeps once at boot; this is the periodic backstop. Safe: live source
      // tasks' reflect worktrees are never reclaimed.
      reflectWorktreeSweep: {
        reflectWorktreesDir,
        taskStore,
        intervalHours: resolveReflectWorktreeSweepIntervalHours(process.env),
      },
      // Hourly prod smoke tick (issue #1593). Enabled by default only on the
      // canonical prod port (4800) so a fresh deploy is protected with no
      // operational change; dev servers and the test suite stay silent unless
      // KOOKR_PROD_SMOKE_TICK forces it on. Undefined ⇒ no interval started.
      prodSmokeTick: createProdSmokeTickFromEnv({ env: process.env, port, kookrDir, broadcast: detectorBroadcast }),
      // Deploy-lag detector (issue #1594). Compares each monitored prod's
      // running SHA against origin/main and alerts when merged commits sit
      // undeployed past the threshold (default 6h); it never triggers a deploy.
      // The kookr running SHA is the build-info commit hash (the server's own
      // API surface); the lucy target is added only when its status URL + local
      // clone are configured. Enabled by default only on the canonical prod port
      // (4800), like the smoke tick; undefined ⇒ no interval started.
      deployLagDetector: createDeployLagDetectorFromEnv({
        env: process.env,
        port,
        kookrDir,
        kookrRepoPath: serverCwd,
        getRunningSha: () => (buildInfo.commitHash && buildInfo.commitHash !== 'dev' ? buildInfo.commitHash : null),
        broadcast: detectorBroadcast,
        // On a converged tick, flip the per-schedule ROI rollup's live-verified
        // counts for every merged unit the deployed SHA contains (issue #1596).
        // The detector resolves containment via git ancestry; the store owns the
        // ledgers and records the flip with no manual bookkeeping step.
        onDeployVerified: (deployedSha, isContained) =>
          scheduleStore.recordDeployVerification(deployedSha, isContained),
      }),
    },
  });

  const { httpServer, activeBridges, close: closeHttpRuntime } = await startHttpAndWebSockets({
    app,
    port,
    host,
    tasksFile,
    hooksDir,
    terminalBackend,
    terminalInputWriter: terminalInputCoordinator,
    terminalDeps,
    useFakeTerminalBridge,
    apiAuth,
    onLocalTerminalActivity: (sessionId) => remoteRelayRuntime?.recordLocalTerminalActivity(sessionId),
    onDashboardConnection: (ws) => handleWsConnection(ws, connectionRegistry, wsConnectionDeps),
    // Register terminal sockets with the connection registry so the revocation
    // sweep owns the terminal pool too (#805/#807). `resolveTerminalActor` is
    // deliberately left unset: viewer-cookie resolution onto terminal streams is
    // deferred to the resolveViewer security gate (#808/#809/#810), so every live
    // terminal socket resolves to the owner for now.
    terminalRegistrar: connectionRegistry,
    sessionHealthTracker,
    // #810 terminal scope gate: an out-of-scope viewer terminal upgrade is a 403
    // before the handshake. Inert while `resolveTerminalActor` is unset (owners
    // always pass); enforced the moment viewer terminal resolution is wired.
    isActorAllowedTerminalSession,
  });

  // Issue #1721: listener is up — surface liveness immediately, then run the
  // heavy recovery that used to block bind (session reattach, hook replay,
  // crash relaunch). /api/ready stays 503 until markReady().
  startupReadiness.markListening();
  startupReadiness.markRecovering('session reattach + hook replay + crash recovery');
  console.log('[startup] HTTP listener bound; starting deferred recovery phase');
  let deferredRecoveryFailed = false;
  try {
    startupRecoverySummary = await runStartupRecoveryPhase({
      taskStore,
      queue,
      monitor,
      watchdog,
      terminalBackend,
      hookWatcher,
      suppressionTracker,
      interactionLog,
      adapterRegistry,
      reconcileResult,
      persisted,
      lifecycleDeps,
      serverCwd,
      broadcastToAll,
      ralphLoopService,
      hookIngestion,
      activityLedger,
      restartEpoch,
      dispositionLedgerPath: join(kookrDir, 'disposition.jsonl'),
      staleOpenLaunchTaskIds,
    });
    await promotePendingStartupTasks({
      taskStore,
      adapterRegistry,
      lifecycleDeps,
      broadcastToAll,
      serverCwd,
    });
  } catch (err) {
    // Recovery failure must not leave the process forever-unready (deploy gate
    // would wait the full timeout). Still flip ready so /api/ready opens and
    // operators can inspect logs / startup-summary; detail records the miss.
    deferredRecoveryFailed = true;
    console.error(
      '[startup] Deferred recovery phase failed:',
      err instanceof Error ? err.message : err,
    );
  }
  startupReadiness.markReady(
    deferredRecoveryFailed
      ? 'startup complete with recovery errors — inspect server log'
      : 'startup complete',
  );
  console.log(
    deferredRecoveryFailed
      ? '[startup] Deferred recovery phase finished with errors; ready for work (degraded)'
      : '[startup] Deferred recovery phase complete; ready for work',
  );

  const collaborationListener = await startConfiguredPrivateNetworkCollaborationListener({
    env: process.env,
    dashboardHost: host,
    dashboardPort: port,
    kookrDir,
    auditLog: privateNetworkAuditLog,
    recordAuthFailure: (failure) => {
      privateNetworkLastAuthFailure = failure;
    },
    taskExists: (taskId) => Boolean(taskStore.getTask(taskId)),
    projectTaskForShare: (taskId) => {
      const task = taskStore.getTask(taskId);
      if (!task) return null;
      privateNetworkNodeId ??= getOrCreatePrivateNetworkNodeId(kookrDir);
      return projectTaskForRemoteShare(task, {
        nodeId: privateNetworkNodeId,
        queue,
      });
    },
  });
  collaborationListenerForDiagnostics = collaborationListener;
  const collaborationUpdatePoller = startPrivateNetworkSharedTaskUpdatePoller({
    config: collaborationListener.config,
    env: process.env,
    contactShare,
  });
  if (collaborationListener.status === 'disabled') {
    const health = collaborationListener.config.health;
    const detail = health.state === 'disabled'
      ? health.reason
      : health.state === 'unreachable'
        ? health.detail ?? health.state
        : health.state;
    console.log(`[collaboration] private-network listener disabled (${detail})`);
  }

  // Start background services that should wait for the server to be listening.
  backgroundServices.startAfterListen();

  // Payload-diet boot stats (issue #1526 Phase C / C2): one line so operators
  // see the tracked-record count and (once broadcast) the snapshot size.
  console.log(formatPayloadDietLogLine(getPayloadDietStats()));

  const remoteChatTrigger = await startRemoteChatTrigger({
    host,
    port,
    kookrDir,
    launchTask: (opts) => launchTask(launchServiceDeps, opts),
    llmClient,
    lifecycleSignal,
  });
  const telegramHandle = remoteChatTrigger.handle;
  onPermissionBlockedHolder = remoteChatTrigger.onPermissionBlocked;
  // Compose remote-chat notify with pipeline-starvation terminal hooks:
  // - PR2 R6: product blocked-empty outcomes that never POSTed handle
  // - PR4 R5: idea-scout complete → capacity-gated batch kick when episode open
  const remoteChatOnTaskOutcome = remoteChatTrigger.onTaskOutcome;
  onTaskOutcomeHolder = (taskId, outcome) => {
    try {
      void remoteChatOnTaskOutcome?.(taskId, outcome);
    } catch (err) {
      console.warn('[lifecycle] remoteChat onTaskOutcome threw:', err);
    }
    void pipelineStarvation.maybeReconcileBatchTaskTerminal(taskId, outcome).catch((err) => {
      console.warn(
        '[pipeline-starvation] terminal reconcile failed:',
        err instanceof Error ? err.message : err,
      );
    });
    void pipelineStarvation.maybeKickBatchOnScoutTerminal(taskId, outcome).catch((err) => {
      console.warn(
        '[pipeline-starvation] scout-complete batch kick failed:',
        err instanceof Error ? err.message : err,
      );
    });
  };
  notifyBootReconciledTaskOutcomes(onTaskOutcomeHolder, reconcileResult);

  // --- Close ---

  let isClosed = false;

  async function close(): Promise<void> {
    if (isClosed) return;
    isClosed = true;

    if (taskTailPurgeTimer) {
      clearInterval(taskTailPurgeTimer);
      taskTailPurgeTimer = undefined;
    }

    if (envBlockerHeartbeatTimer) {
      clearInterval(envBlockerHeartbeatTimer);
      envBlockerHeartbeatTimer = undefined;
    }

    lessonSpoolService.stop();
    signalOutboxService.stop();
    signalDeliveryService?.stop();
    memoryLedger.stop();
    await backgroundServices.stop();
    try {
      await taskStateSaveScheduler.close();
    } catch (err) {
      console.error('Error flushing pending task-state save on shutdown:', err);
    }
    stopWebhookObserver?.();
    stopDeliveryTraceObserver();

    // Final task-state save (dirty flush under SQLite; full rewrite under JSON)
    try {
      const snoozedFindings = serializeSnoozed(queue, taskStore);
      await persistTaskState({
        taskStore,
        tasksFile,
        policy: 'none',
        snoozes: snoozedFindings,
        sqliteStore: taskSqliteStore,
      });
      persistenceHealth.recordSuccess('task_state');
    } catch (err) {
      persistenceHealth.recordFailure('task_state', err);
      console.error('Error saving tasks on shutdown:', err);
    }

    try {
      taskSqliteStore?.close();
    } catch (err) {
      console.error('Error closing task sqlite store on shutdown:', err);
    }

    try {
      await ossAttemptStore.save();
      await projectConfigStore.save();
      await scheduleStore.persist();
    } catch (err) {
      console.error('Error saving on shutdown:', err);
    }

    // Drain any pending suggestion lifecycles before shutdown
    drainLifecycles(telemetryLog);

    await remoteRelayRuntime?.stop();

    // Stop hook watchers and trackers
    hookWatcher.stopAll();
    ossRegistryWatcher.close();
    reconReportWatcher.close();
    httpPushTracker.dispose();
    circuitBreakerRegistry.dispose();

    // Close terminal bridges
    for (const [ws, bridge] of activeBridges) {
      bridge.dispose();
      ws.close(1001, 'Server shutting down');
    }
    activeBridges.clear();

    // Close WebSocket connections. Order: stop the revocation sweep before
    // closing sockets so a tick can't race the close, then closeAll(); the HTTP
    // server is closed last via closeHttpRuntime() at the end of shutdown.
    connectionRegistry.stopSweep();
    connectionRegistry.closeAll();

    // Telegram integration shutdown (releases lockfile so prod:restart picks up cleanly).
    if (telegramHandle) {
      try { await telegramHandle.stop(); } catch (err) { console.warn('[telegram] stop failed:', err); }
    }

    // Close servers
    collaborationUpdatePoller.stop();
    await collaborationListener.close();

    // Final flush of the terminal backend's ring snapshots before the process
    // exits. The dtach masters survive (spawned with setsid); this only stops
    // backend-owned background work and persists in-flight bytes that the
    // periodic flush hasn't picked up yet. Without this, `pnpm prod:restart`
    // races the 2 s flush cadence and the most-recent bytes are lost on
    // re-attach.
    terminalBackend.close?.();

    await closeHttpRuntime();

    // Release the R27 single-writer pid lock last, after all writes are done.
    releaseSingleWriterLock();
  }

  // Non-blocking startup refresh of the OSS attempts view.
  // Fire-and-forget: failures surface in the UI via lastRefreshAt + error banner.
  ossRefresher
    .refresh()
    .then((result) => {
      if (result.reposTotal > 0) {
        console.log(
          `[oss-tracking] Startup refresh: ${result.reposProcessed}/${result.reposTotal} repos, ${result.ghCalls} gh calls, ${result.errors.length} errors`,
        );
      }
      broadcastOssAttempts();
    })
    .catch((err) => {
      console.warn('[oss-tracking] Startup refresh failed:', err instanceof Error ? err.message : err);
    });

  return {
    httpServer,
    taskStore,
    queue,
    monitor,
    adapter,
    hookWatcher,
    tokenTracker,
    interactionLog,
    telemetryLog,
    githubScanner,
    watchdog,
    ossAttemptStore,
    projectConfigStore,
    projectSidebarStore,
    circuitBreakerRegistry,
    remoteLaunchBroker,
    controllerLeaseManager: remoteRelayRuntime?.controllerLeaseManager ?? null,
    remoteInputAdapter: remoteRelayRuntime?.remoteInputAdapter ?? null,
    app,
    broadcastToAll,
    close,
  };
}
