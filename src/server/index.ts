import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { loadTasksWithRecovery, saveTasks, saveTasksWithSnapshotPolicy, serializeSnoozed } from '../core/task-persistence.js';
import { reconcile, reconcileStaleOpenLaunches, type ReconciliationResult } from './reconciliation.js';
import { type AgentPreflightSnapshot, type PreflightLogger } from './agent-preflight.js';
import type { ServerMessage, SnapshotMessage } from '../shared/contracts/messages.js';
import type { TelegramTaskOutcome } from '../shared/contracts/telegram.js';
import type { Scope } from './viewer-data-policy.js';
import { createTerminalScopeChecker } from './terminal-scope.js';
import { ContactShareReadModel } from '../core/contact-share.js';
import { deterministicTaskName, generateTaskName } from '../core/task-naming.js';
import type { BackendError, TerminalBackend } from '../adapters/terminal-backend.js';
import { wireEventPipeline } from './event-pipeline.js';
import { drainLifecycles } from '../core/suggestion-telemetry.js';
import { createRoutes } from './routes.js';
import { completeTask, type AgentLifecycleDeps, type TerminalInputDeps } from './agent-lifecycle.js';
import { launchFreshTaskSession, launchTask, type LaunchServiceDeps } from './launch-service.js';
import { buildCapacityLedger } from '../core/capacity-ledger.js';
import { SpawnRateLimiter } from '../core/spawn-rate-limiter.js';
import { resolveTaskAttentionSignals } from './task-attention-signals.js';
import { IdempotencyLedger } from '../core/idempotency-ledger.js';
import { DrainController } from './drain-state.js';
import { handleWsConnection, type WsConnectionDeps } from './ws-connection-handler.js';
import { QuotaAdapter } from '../adapters/quota-adapter.js';
import { saveSettings, type KookrSettings } from '../core/settings-store.js';
import { AVAILABLE_AGENT_TYPES } from '../core/agent-types.js';
import { applySettingsSideEffects } from './settings-side-effects.js';
import { DiagnosticRunner } from './diagnostic-runner.js';
import { getDetectionStats, hydrateDetectionStats } from '../core/detection-stats.js';
import { DetectionStatsStore } from './detection-stats-store.js';
import {
  promotePendingStartupTasks,
  runStartupRecoveryPhase,
} from './startup-recovery.js';
import type { KookrServerInternal } from './server-test-helpers.js';
import { createSnapshotMessage, getSnapshotAgentsForClient } from './use-cases/get-snapshot.js';
import { sweepReflectWorktrees } from './use-cases/request-task-reflect.js';
import { startBackgroundServices } from './bootstrap/start-background-services.js';
import {
  formatPayloadDietLogLine,
  resolveMaintenancePruneIntervalHours,
  type PayloadDietStats,
} from './lifecycle-timers.js';
import { pruneAgedTaskRecords } from './use-cases/prune-aged-task-records.js';
import { isTerminalStatus } from '../core/task-status.js';
import { RalphLoopService } from './ralph-loop-service.js';
import { createSystemResourceSampler, RESOURCE_STATUS_INTERVAL_MS } from './system-resource-sampler.js';
import {
  createResourceStatusService,
  type ResourceStatusSampler,
} from './resource-status-service.js';
import { createOperationalAlertEvaluator } from './operational-alert-rules.js';
import { LessonSpoolService } from './lesson-spool-service.js';
import { defaultSpoolDir } from '../core/lesson-write-spool.js';
import { SignalOutboxService } from './signal-outbox-service.js';
import { defaultSignalOutboxDir } from '../core/signal-outbox.js';
import { PersistenceHealthTracker } from '../core/persistence-health.js';
import { TaskStateSaveScheduler } from './task-state-save-scheduler.js';
import { createIssueClaimServices, createUpstreamOfResolver, isIssueClaimsEnabled, type IssueClaimServices } from './issue-claim-wiring.js';
import { decorateClaim } from './issue-claim-decorator.js';
import { resolveClaimRepo } from './use-cases/resolve-claim-repo.js';
import { getProjectId } from '../core/project-identity.js';
import { acquireSingleWriterLock } from './single-writer-lock.js';
import {
  getOperationalAlertConfig,
  resetOperationalAlertConfig,
} from './operational-alert-config.js';
import { readAdmissionControlConfigFromEnv } from './task-admission.js';
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
   */
  terminalBackend: TerminalBackend;
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
    terminalBackend, sttUrl, ttsUrl, useFakeTerminalBridge, agentBin, codexBin, grokBin, bypassAllPermissions,
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
  // Live getter for the adapter-launch hard timeout (issue #1526 Phase C /
  // #1528). Same live-binding pattern — applies to the next launch.
  const getLaunchTimeoutMs = () => currentSettings.launchTimeoutSeconds * 1000;
  // Live getter for the scheduled-task starvation dead-man window (issue
  // #1526 Phase C). Read on every scheduler tick.
  const getDeadManScheduleMs = () => currentSettings.deadManScheduleMinutes * 60_000;
  // Honest server-side backpressure (issue #1526 Phase C / C3). All read the
  // live `currentSettings` binding, so a settings PUT applies to the next
  // launch / liveness tick without a restart.
  const getMaxPendingTasks = () => currentSettings.maxPendingTasks;
  const getPendingTaskTtlMs = () => currentSettings.pendingTaskTtlMinutes * 60_000;
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
  const terminalInputCoordinator = new TerminalInputCoordinator(terminalBackend);
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
  // this to build the snapshot a `projects` viewer receives; for an `all` scope
  // the broadcaster reuses the already-enriched owner snapshot, so this factory
  // is only ever invoked for a `projects` scope. Only scope-relevant deps are
  // threaded in — whole-world aggregates, speech endpoints, and owner-config
  // capabilities are neither passed here NOR (independently) emitted by
  // `createSnapshotMessage` for a `projects` scope, which is the real authority.
  const buildScopedSnapshot = (scope: Scope): SnapshotMessage =>
    createSnapshotMessage({
      monitor,
      serverCwd,
      scope,
      bypassAllPermissions,
      relationTaskStore: taskStore,
      drainStatus: drainController.status(),
      terminalInputSnapshots: terminalInputCoordinator,
      userInputDeliveryProvider: userInputDeliveries,
    });

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

  const realtime = await createRealtimeServices({
    kookrDir,
    taskStore,
    queue,
    monitor,
    adapterRegistry,
    serverCwd,
    sttUrl,
    buildScopedSnapshot,
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
    coordinatorSuppressions,
    resolveGrantLiveness: (grantId) => viewerGrantStore.liveness(grantId),
    isActorAllowedTerminalSession,
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
  });
  realtime.setProjectSummaryGitHubDeps({
    getRepoHealthSnapshot: () => githubScanner.getRepoHealthSnapshot(),
    getTaskGithubReferences: (taskId) => githubStateStore.getReferences(taskId),
    getGithubRefOpenState: (ref) => githubStateStore.isRefOpen(ref),
    setTrackedGithubRepos: (repos) => githubScanner.setTrackedGithubRepos(repos),
  });
  broadcastProjectSummariesRef = broadcastProjectSummaries;

  // Load persisted tasks
  const persisted = await loadTasksWithRecovery(tasksFile);
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
    console.log(`Loaded ${persisted.tasks.length} task(s) from ${tasksFile} (lifetime spend: $${taskStore.getLifetimeSpendUsd().toFixed(2)})`);
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

  // Reconcile with live backend sessions
  const reconcileResult = await reconcile(taskStore, terminalBackend, worktreeRegistry);
  // Boot-only sweep (issue #1526 Phase C / #1528): launches that died with
  // the previous process leave open/zero-session tasks that reconcile()'s
  // dead-session logic never touches. Terminate them here and merge into
  // tasksTerminated so claim release / onTaskOutcome below treat them like
  // any other boot-terminated task. Runs BEFORE createScheduleRuntime so
  // scheduleService.reconcileOnStartup sees their terminal status.
  reconcileResult.tasksTerminated.push(...reconcileStaleOpenLaunches(taskStore));
  if (reconcileResult.resumed.length > 0) {
    console.log(`Resumed monitoring: ${reconcileResult.resumed.join(', ')}`);
  }
  if (reconcileResult.markedCompleted.length > 0) {
    console.log(`Marked completed (session dead): ${reconcileResult.markedCompleted.join(', ')}`);
  }
  if (reconcileResult.orphans.length > 0) {
    console.warn(`Orphan sessions (not in tasks): ${reconcileResult.orphans.join(', ')}`);
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

  // Register transcripts for resumed sessions so token tracker picks up existing data
  for (const task of taskStore.getAllTasks()) {
    for (const session of task.sessions) {
      if (session.transcriptPath) {
        tokenTracker.register(session.transcriptPath, task.id);
      }
    }
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

  // Launch service deps — shared by WS handler, REST routes, and the Ralph
  // cycler's fresh-runtime launcher inside wireEventPipeline.
  const launchServiceDeps: LaunchServiceDeps = {
    taskStore,
    adapterRegistry,
    lifecycleDeps,
    getMaxActiveTasks,
    getDefaultAgentType,
    roundRobinCursor,
    interactionLog,
    terminalBackend,
    isAccepting: () => drainController.isAccepting(),
    validateLaunchCwd: config.validateLaunchCwd,
    bypassAllPermissions,
    idempotencyLedger,
    getLaunchTimeoutMs,
    // issue #1526 Phase C / C3: pending-queue depth limit + per-source spawn
    // budget, with the SAME watchdog-aware capacity-ledger builder /api/health
    // uses so a 429 body and the health endpoint tell one story.
    getMaxPendingTasks,
    spawnRateLimiter,
    getCapacityLedger: () => {
      const now = Date.now();
      return buildCapacityLedger(taskStore.listTasks(), {
        now,
        maxActiveTasks: getMaxActiveTasks(),
        isHungSuspect: (task) => resolveTaskAttentionSignals(task, { queue, watchdog }, now).hungSuspect,
        isLaunching: (task) => taskStore.hasFreshLaunchReservation(task.id),
      });
    },
  };

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
        allowCollaboratorGrants: true,
      });
      console.log('[remote] launch broker enabled');
    }
  }

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

  const { abortPendingSuggestion } = wireEventPipeline({
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
  });

  // Terminal input deps — used by terminal bridge handlers
  const terminalDeps: TerminalInputDeps = {
    monitor, watchdog, abortPendingSuggestion, broadcastToAll, serverCwd, taskStore,
  };

  const startupRecoverySummary = await runStartupRecoveryPhase({
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
  });
  await promotePendingStartupTasks({
    taskStore,
    adapterRegistry,
    lifecycleDeps,
    broadcastToAll,
    serverCwd,
  });

  // Reclaim reflect worktrees orphaned by a crash between `git worktree add`
  // and reflect-task completion (plus a 7-day TTL backstop). Best-effort —
  // a sweep failure must never block startup.
  try {
    const { removed, kept } = await sweepReflectWorktrees({ reflectWorktreesDir, taskStore });
    if (removed > 0) {
      console.log(`[reflect-sweep] removed ${removed} orphaned reflect worktree(s), kept ${kept}`);
    }
  } catch (err) {
    console.warn('[reflect-sweep] startup sweep failed:', err instanceof Error ? err.message : err);
  }

  const { scheduleStore, scheduleService, scheduleRunner } = await createScheduleRuntime({
    kookrDir,
    taskStore,
    launchServiceDeps,
    getMaxActiveTasks,
    broadcastToAll,
    isAccepting: () => drainController.isAccepting(),
    getDeadManScheduleMs,
  });
  realtime.setScheduleStore(scheduleStore);
  realtime.setSnapshotAchievementsReady(true);
  const persistenceHealth = new PersistenceHealthTracker();
  const taskStateSaveScheduler = new TaskStateSaveScheduler({
    taskStore,
    tasksFile,
    queue,
    suppressionTracker,
    persistenceHealth,
  });

  // --- Self-diagnostic runner ---
  const serverStartMs = Date.now();
  const diagnosticRunner = new DiagnosticRunner({
    getDetectionStats,
    getAgentCount: () => taskStore.listTasks().length,
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
  const app = createRoutes({
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
    taskTailStore,
    githubScanner, githubStateStore, buildInfo, serverStartedAt,
    serverCwd, serverPort: port, pluginUpdateBin: agentBin, kookrDir, frontendDir, broadcastToAll,
    getOperationalAlertHistory: () => resourceStatusService.getOperationalAlertHistory(),
    // issue #1590: feed the load-based POST /api/tasks admission gate the same
    // already-sampled event-loop p95 the health snapshot exposes.
    getLatestResourceStatus: () => resourceStatusService.getLatest(),
    llmClient,
    sessionHealthService,
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
    startupRecoverySummary,
    ralphCycler,
    tokenTracker,
    tasksFile,
    ralphLoopService,
    worktreeRegistry,
    getMaxActiveTasks,
    getAutoCloseCompletionReadyDelayMs,
    getCompletionReadyTtlMs,
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
        const merged: KookrSettings = {
          ...newSettings,
          roundRobinIndex: currentSettings.roundRobinIndex,
        };
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
        currentSettings = { ...newSettings, roundRobinIndex: currentSettings.roundRobinIndex };
        settingsLoadedFromDefaults = false;
        settingsLoadWarnings = [];
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
    const snoozes = serializeSnoozed(queue, taskStore);
    const suppressionState = suppressionTracker?.export();
    try {
      await saveTasksWithSnapshotPolicy(
        taskStore.getAllTasks(),
        tasksFile,
        'predelete',
        taskStore.getLifetimeSpendUsd(),
        snoozes,
        suppressionState,
        taskStore.listRelations(),
      );
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
  const operationalAlertEvaluator = createOperationalAlertEvaluator(
    getOperationalAlertConfig,
    () => persistenceHealth.snapshot(),
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
        `circuitBreakerOpen=${operationalAlertConfig.circuitBreakerOpenMs || 'off'}ms`,
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
    getCircuitBreakerSnapshots: () => circuitBreakerRegistry.getAllSnapshots(),
    intervalMs: resourceStatusIntervalMs,
  });

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

  // --- Quota monitoring (polls Anthropic OAuth usage endpoint) ---
  const quotaAdapter = new QuotaAdapter(120_000); // 120s interval

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
  };

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
    findingEvidenceReviewSampler,
    timerDeps: {
      monitor, taskStore, queue, adapter, adapterRegistry, tokenTracker, watchdog,
      hookWatcher, terminalBackend, hooksDir, tasksFile, serverCwd,
      saveIntervalMs, livenessIntervalMs, broadcastToAll,
      shadowRegistry, agentLifecycleDeps: lifecycleDeps, taskTailStore,
      quotaAdapter, getMaxActiveTasks, getAutoCloseCompletionReadyDelayMs, suppressionTracker,
      getCompletionReadyTtlMs,
      getPendingTaskTtlMs,
      auditLogPath: join(kookrDir, 'audit.jsonl'),
      reportsDir: join(kookrDir, 'reports'),
      getHungTaskReapEnabled, getHungTaskReapMs,
      budgetChecker, projectConfigStore, progressBudgetBurnDiagnostics,
      detectionStatsStore,
      persistenceHealth,
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
  onTaskOutcomeHolder = remoteChatTrigger.onTaskOutcome;
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

    lessonSpoolService.stop();
    signalOutboxService.stop();
    await backgroundServices.stop();
    try {
      await taskStateSaveScheduler.close();
    } catch (err) {
      console.error('Error flushing pending task-state save on shutdown:', err);
    }
    stopWebhookObserver?.();
    stopDeliveryTraceObserver();

    // Final task-state save
    try {
      const snoozedFindings = serializeSnoozed(queue, taskStore);
      await saveTasks(
        taskStore.getAllTasks(),
        tasksFile,
        taskStore.getLifetimeSpendUsd(),
        snoozedFindings,
        undefined,
        taskStore.listRelations(),
      );
      persistenceHealth.recordSuccess('task_state');
    } catch (err) {
      persistenceHealth.recordFailure('task_state', err);
      console.error('Error saving tasks on shutdown:', err);
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
