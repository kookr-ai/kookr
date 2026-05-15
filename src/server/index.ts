import { join } from 'node:path';

import { loadTasks, saveTasks, saveTasksWithSnapshotPolicy, serializeSnoozed } from '../core/task-persistence.js';
import { GitHubStateStore } from '../core/github-state-store.js';
import { GitHubScannerService } from '../core/github-scanner-service.js';
import { DEFAULT_GITHUB_SCANNER_CONFIG } from '../core/github-types.js';
import { ghCliFetcher, fetchBatchRepoHealth, getGhUserLogin } from '../adapters/github-fetcher.js';
import { CircuitBreakerGitHubFetcher } from '../adapters/circuit-breaker-github-fetcher.js';
import { reconcile } from './reconciliation.js';
import { type AgentPreflightSnapshot, type PreflightLogger } from './agent-preflight.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { HookFileWatcher } from './hook-watcher.js';
import { HookIngestion } from './hook-ingestion.js';
import { ActivityLedger } from '../core/activity-ledger.js';
import { generateTaskName } from '../core/task-naming.js';
import type { BackendError, TerminalBackend } from '../adapters/terminal-backend.js';
import { formatGitHubAlert } from '../core/github-alerts.js';
import { wireEventPipeline } from './event-pipeline.js';
import { drainLifecycles } from '../core/suggestion-telemetry.js';
import { createRoutes } from './routes.js';
import { completeTask, type AgentLifecycleDeps, type TerminalInputDeps } from './agent-lifecycle.js';
import { launchFreshTaskSession, launchTask, type LaunchServiceDeps } from './launch-service.js';
import { handleWsConnection, type WsConnectionDeps } from './ws-connection-handler.js';
import { QuotaAdapter } from '../adapters/quota-adapter.js';
import type { KookrSettings } from '../core/settings-store.js';
import { AVAILABLE_AGENT_TYPES } from '../core/agent-types.js';
import { applySettingsSideEffects } from './settings-side-effects.js';
import { DiagnosticRunner } from './diagnostic-runner.js';
import { getDetectionStats } from '../core/detection-stats.js';
import { WorktreeLeaseService } from '../core/worktree-lease-service.js';
import { RepoPolicyResolver } from '../core/repo-policy-resolver.js';
import { WorkspaceAttemptRepository } from '../core/workspace-attempt-repository.js';
import { getProjectId } from '../core/project-identity.js';
import {
  promotePendingStartupTasks,
  runStartupRecoveryPhase,
} from './startup-recovery.js';
import type { KookrServerInternal } from './server-test-helpers.js';
import { createSnapshotMessage } from './use-cases/get-snapshot.js';
import { startBackgroundServices } from './bootstrap/start-background-services.js';
import { RalphLoopService } from './ralph-loop-service.js';
import { createSystemResourceSampler } from './system-resource-sampler.js';
import { createResourceStatusService } from './resource-status-service.js';
import { type OssSourceWatcherFs } from './oss-source-watcher.js';
import { migrateLegacyProtectedWorktree } from '../adapters/worktree-marker.js';
import { createAgentRuntime } from './bootstrap/create-agent-runtime.js';
import { createCoreStores } from './bootstrap/create-core-stores.js';
import { createOssServices, createOssSourceWatchers } from './bootstrap/create-oss-services.js';
import { createRealtimeServices } from './bootstrap/create-realtime-services.js';
import { createScheduleRuntime } from './bootstrap/create-schedule-runtime.js';
import { startHttpAndWebSockets } from './bootstrap/start-http-and-websockets.js';
import type { RemoteNodeClient } from '../remote/node-client.js';
import type { CommandJournal } from '../remote/command-journal.js';
import { isOwnerLocal } from './auth.js';
import type { SessionStreamPublisher } from '../remote/session-stream-publisher.js';

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
  /** Use FakeTerminalBridge instead of a real session attach. For E2E tests and demo mode. */
  useFakeTerminalBridge?: boolean;
  /** Path or command name for the Claude Code binary. Defaults to 'claude'. */
  agentBin?: string;
  /** Path or command name for the Codex binary. Defaults to 'codex'. */
  codexBin?: string;
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
  }
}

// --- Server factory ---

export async function createKookrServer(config: KookrConfig): Promise<KookrServer> {
  return createKookrServerInternal(config);
}

/** Returns the full internal server — use in tests that need direct access to subsystems. */
export async function createKookrServerInternal(config: KookrConfig): Promise<KookrServerInternal> {
  const {
    port, host, kookrDir, tasksFile, hooksDir, settingsDir,
    serverCwd, frontendDir, saveIntervalMs, livenessIntervalMs,
    terminalBackend, sttUrl, useFakeTerminalBridge, agentBin, codexBin, bypassAllPermissions,
    claudeDir, preflightOnFatal, preflightLogger,
    ossSourceWatcherFs, ossSourceWatcherDebounceMs,
    lifecycleSignal,
  } = config;

  const coreStores = await createCoreStores({ kookrDir, hooksDir, settingsDir, frontendDir });
  let currentSettings = coreStores.currentSettings;
  let settingsLoadedFromDefaults = coreStores.settingsLoadedFromDefaults;
  const {
    interactionLog,
    telemetryLog,
    buildInfo,
    serverStartedAt,
    settingsFile,
    circuitBreakerRegistry,
    githubBreaker,
    taskStore,
    worktreeRegistry,
    queue,
    suppressionTracker,
    monitor,
    watchdog,
    checkpointCycler,
    ralphCycler,
    tokenTracker,
    budgetChecker,
    projectConfigStore,
    projectSidebarStore,
    shadowRegistry,
    httpPushTracker,
    llmClient,
  } = coreStores;
  const getMaxActiveTasks = () => currentSettings.maxActiveTasks;

  // Phase 0a remote-session audit scaffold. This path is intentionally inert
  // unless the operator opts into remote collaboration with KOOKR_RELAY_URL.
  let remoteNodeClient: RemoteNodeClient | null = null;
  let sessionStreamPublisher: SessionStreamPublisher | null = null;
  let commandJournal: CommandJournal | null = null;
  if (process.env.KOOKR_RELAY_URL) {
    const { createRemoteAuditScaffold } = await import('../remote/audit.js');
    const { CommandJournal } = await import('../remote/command-journal.js');
    const { createRemoteNodeClient } = await import('../remote/node-client.js');
    createRemoteAuditScaffold({ relayUrl: process.env.KOOKR_RELAY_URL });
    remoteNodeClient = await createRemoteNodeClient({
      relayUrl: process.env.KOOKR_RELAY_URL,
      token: process.env.KOOKR_RELAY_TOKEN ?? '',
      kookrDir,
      softwareVersion: buildInfo.version,
      displayName: process.env.KOOKR_RELAY_DISPLAY_NAME,
      publicBaseUrl: process.env.KOOKR_PUBLIC_BASE_URL,
    });
    commandJournal = await CommandJournal.open({
      kookrDir,
      nodeId: remoteNodeClient.status.nodeId,
      nodeEpoch: remoteNodeClient.status.nodeEpoch,
    });
  }

  const { adapterRegistry, adapter, agentPreflight } = await createAgentRuntime({
    terminalBackend,
    taskStore,
    hooksDir,
    settingsDir,
    serverPort: port,
    agentBin,
    codexBin,
    bypassAllPermissions,
    kookrDir,
    preflightOnFatal,
    preflightLogger,
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
  const realtime = await createRealtimeServices({
    kookrDir,
    taskStore,
    queue,
    monitor,
    adapterRegistry,
    serverCwd,
    sttUrl,
    ledgerAnalytics,
    projectConfigStore,
    projectSidebarStore,
    skillDiscoveryState,
    prLessonsState,
    getRegistryActiveProjects,
    getRegistryActiveRepos,
    ossAttemptStore,
    getDefaultAgentType,
  });
  const {
    clients,
    achievementWatcher,
    broadcastToAll,
    broadcastProjectSummaries,
    broadcastOssAttempts,
  } = realtime;

  // Create GitHub scanner with user-configured intervals
  const githubStateStore = new GitHubStateStore();
  const githubScannerConfig = {
    ...DEFAULT_GITHUB_SCANNER_CONFIG,
    stateFetchIntervalMs: currentSettings.githubPollingIntervalSec * 1000,
    referenceExtractionIntervalMs: currentSettings.githubPollingIntervalSec * 1000,
  };
  // Forward-declared so onRepoHealthChanged can call back into the broadcast
  // function which references githubScanner.getRepoHealthSnapshot().
  let broadcastProjectSummariesRef: (() => void) | null = null;
  const githubScanner = new GitHubScannerService({
    taskStore,
    stateStore: githubStateStore,
    fetcher: new CircuitBreakerGitHubFetcher(ghCliFetcher, githubBreaker),
    config: githubScannerConfig,
    repoHealthFetcher: fetchBatchRepoHealth,
    ghUserLoginResolver: getGhUserLogin,
    onRepoHealthChanged: () => {
      broadcastProjectSummariesRef?.();
    },
    onStateUpdate: (taskId) => {
      // Broadcast initial state when first fetched (no changes yet)
      const state = githubStateStore.getTaskState(taskId);
      broadcastToAll({
        type: 'githubUpdate',
        taskId,
        prs: state.prs,
        issues: state.issues,
        changes: [],
      });
    },
    onChanges: (taskId, changes) => {
      // Broadcast GitHub state update to all clients
      const state = githubStateStore.getTaskState(taskId);
      broadcastToAll({
        type: 'githubUpdate',
        taskId,
        prs: state.prs,
        issues: state.issues,
        changes,
      });

      // Raise alerts for actionable changes
      for (const change of changes) {
        const ref = change.ref;
        const label = `${ref.owner}/${ref.repo}#${ref.number}`;
        const alert = formatGitHubAlert(change, label);

        if (alert) {
          broadcastToAll({
            type: 'alert',
            agentId: ref.detectedFrom,
            summary: alert.summary,
            details: '',
            severity: alert.severity,
          });
        }
      }
    },
  });
  realtime.setProjectSummaryGitHubDeps({
    getRepoHealthSnapshot: () => githubScanner.getRepoHealthSnapshot(),
    getTaskGithubReferences: (taskId) => githubStateStore.getReferences(taskId),
    setTrackedGithubRepos: (repos) => githubScanner.setTrackedGithubRepos(repos),
  });
  broadcastProjectSummariesRef = broadcastProjectSummaries;

  // Load persisted tasks
  const persisted = await loadTasks(tasksFile);
  if (persisted.tasks.length > 0) {
    taskStore.loadTasks(persisted.tasks, persisted.lifetimeSpendUsd);
    console.log(`Loaded ${persisted.tasks.length} task(s) from ${tasksFile} (lifetime spend: $${taskStore.getLifetimeSpendUsd().toFixed(2)})`);
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

  // Reconcile with live backend sessions
  const reconcileResult = await reconcile(taskStore, terminalBackend, worktreeRegistry);
  if (reconcileResult.resumed.length > 0) {
    console.log(`Resumed monitoring: ${reconcileResult.resumed.join(', ')}`);
  }
  if (reconcileResult.markedCompleted.length > 0) {
    console.log(`Marked completed (session dead): ${reconcileResult.markedCompleted.join(', ')}`);
  }
  if (reconcileResult.orphans.length > 0) {
    console.warn(`Orphan sessions (not in tasks): ${reconcileResult.orphans.join(', ')}`);
  }

  if (remoteNodeClient) {
    const { createSessionStreamPublisher } = await import('../remote/session-stream-publisher.js');
    sessionStreamPublisher = createSessionStreamPublisher({
      terminalBackend,
      remoteNodeClient,
    });
    await sessionStreamPublisher.start();
  }

  // Hook watcher created here but resumed-session replay is deferred to after crash recovery,
  // so relaunched sessions have their new tmux names before snooze restore + hook replay.
  // HookIngestion serializes file-source and http-source delivery through a
  // content-hash dedup window so the same record never reaches the adapter
  // twice. The ActivityLedger captures a durable per-session ledger row for
  // every observed record — parent, child, malformed, duplicate — under
  // <kookrDir>/activity/ for /api/tasks/:taskId/activity-diagnostics.
  // See rfc-activity-log-reliability §5, §7.
  const activityLedger = new ActivityLedger(join(kookrDir, 'activity'));
  const hookIngestion = new HookIngestion({ adapter, httpPushTracker, activityLedger, taskStore });
  const hookWatcher = new HookFileWatcher(hooksDir, hookIngestion);

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
      case 'dtach-unavailable':
      case 'manifest-corrupt':
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
    broadcastToAll(createSnapshotMessage({ monitor, serverCwd, sttUrl, activityMetaProvider: hookIngestion, getMaxActiveTasks }));
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

  /** Fire-and-forget: generate a short AI name for a task */
  function autoNameTask(taskId: string, prompt: string, cwd: string, criteria?: string): void {
    if (!llmClient) return;
    generateTaskName(llmClient, prompt, cwd, criteria)
      .then((name) => {
        if (!name) {
          console.warn(`[task-naming] LLM returned empty name for task ${taskId}`);
          return;
        }
        const current = taskStore.getTask(taskId);
        if (current && !current.name) {
          taskStore.renameTask(taskId, name);
          console.log(`[task-naming] Named task ${taskId}: "${name}"`);
          broadcastToAll(createSnapshotMessage({ monitor, serverCwd, sttUrl, activityMetaProvider: hookIngestion, getMaxActiveTasks }));
        }
      })
      .catch((err) => {
        console.warn(`[task-naming] Failed to name task ${taskId}:`, err instanceof Error ? err.message : err);
      });
  }

  // --- HTTP (Hono) ---

  // Shared post-launch registration deps — used by both WS handler and REST routes
  const lifecycleDeps: AgentLifecycleDeps = {
    monitor, watchdog, hookWatcher, interactionLog, githubScanner, autoNameTask, taskStore,
    projectConfigStore,
  };

  // Launch service deps — shared by WS handler, REST routes, and the Ralph
  // cycler's fresh-runtime launcher inside wireEventPipeline.
  const launchServiceDeps: LaunchServiceDeps = {
    taskStore,
    adapterRegistry,
    lifecycleDeps,
    getMaxActiveTasks,
    getDefaultAgentType,
    interactionLog,
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
      suppressionTracker,
      checkpointCycler,
    }),
  });

  // --- Event pipeline ---

  const { abortPendingSuggestion } = wireEventPipeline({
    adapter, monitor, taskStore, tokenTracker, watchdog,
    githubScanner, llmClient, serverCwd, broadcastToAll,
    telemetryLog,
    checkpointCycler,
    ralphCycler,
    ralphLoopService,
    hookIngestion,
    onPermissionBlocked: (taskId, promptText) => {
      onPermissionBlockedHolder?.(taskId, promptText);
      const task = remoteNodeClient && process.env.KOOKR_PUSH_DISABLED !== 'true'
        ? taskStore.getTask(taskId)
        : undefined;
      if (!task) return;
      void import('../remote/push.js')
        .then(({ makePermissionBlockedPushPayload, publishPushAlertDelta }) => {
          publishPushAlertDelta(remoteNodeClient, makePermissionBlockedPushPayload({
            nodeDisplayName: process.env.KOOKR_RELAY_DISPLAY_NAME,
            task,
            alertId: `permission-${taskId}-${Date.now()}`,
          }));
        })
        .catch((err) => {
          console.warn('[remote-push] failed to publish permission alert:', err);
        });
    },
  });

  // Terminal input deps — used by terminal bridge handlers
  const terminalDeps: TerminalInputDeps = {
    monitor, abortPendingSuggestion, broadcastToAll, serverCwd,
  };

  if (remoteNodeClient && commandJournal) {
    const { executeWithPipeline } = await import('../remote/command-pipeline.js');
    const { RemotePermissionBroker } = await import('../remote/permission-broker.js');
    const { isPresetReplyId, sendPresetReply } = await import('../remote/preset-reply.js');
    const permissionBroker = new RemotePermissionBroker({
      adapter,
      monitor,
      queue,
      interactionLog,
      onRespond: abortPendingSuggestion,
      isOwnerLocal,
    });
    remoteNodeClient.setCommandHandler(async (command) => {
      const authorize = () => {
        if (command.grantId !== `owner-local:${command.nodeId}`) {
          return { ok: false as const, reason: 'invalid grant' };
        }
        const task = taskStore.findTaskBySession(command.sessionId);
        if (!task) return { ok: false as const, reason: 'unknown session' };
        const session = task.sessions.find((candidate) => candidate.tmuxSession === command.sessionId);
        const liveSession = session && session.lastStatus !== 'completed' && session.lastStatus !== 'aborted';
        if (!liveSession) return { ok: false as const, reason: 'session is not live' };
        if (command.action === 'mark-done') {
          const taskId = (command.payload as { taskId?: unknown } | undefined)?.taskId;
          if (taskId !== task.id) return { ok: false as const, reason: 'task/session mismatch' };
        }
        return { ok: true as const };
      };
      const baseValidate = () => {
        if (command.baseRevision !== undefined && command.baseRevision < 0) {
          return { ok: false as const, reason: 'stale baseRevision' };
        }
        return { ok: true as const };
      };
      switch (command.action) {
        case 'presetReply':
          return await executeWithPipeline({
            journal: commandJournal!,
            request: command,
            isOwnerLocal,
            handler: {
              action: 'presetReply',
              authorize,
              validate: () => {
                const valid = baseValidate();
                if (!valid.ok) return valid;
                const presetId = (command.payload as { presetId?: unknown } | undefined)?.presetId;
                return isPresetReplyId(presetId)
                  ? { ok: true as const }
                  : { ok: false as const, reason: 'invalid presetId' };
              },
              execute: async () => {
                const presetId = (command.payload as { presetId: Parameters<typeof sendPresetReply>[2] }).presetId;
                const result = await sendPresetReply(adapter, command.sessionId, presetId);
                monitor.markInputReceived(command.sessionId);
                queue.respondAndAdvance(command.sessionId);
                abortPendingSuggestion(command.sessionId, 'used');
                await interactionLog.append({
                  type: 'user_input',
                  agentId: command.sessionId,
                  content: result.text,
                  timestamp: new Date().toISOString(),
                });
                return result;
              },
            },
          });
        case 'permissionApprove':
          return await executeWithPipeline({
            journal: commandJournal!,
            request: command,
            isOwnerLocal,
            handler: {
              action: 'permissionApprove',
              authorize,
              validate: () => {
                const valid = baseValidate();
                if (!valid.ok) return valid;
                const keystroke = (command.payload as { keystroke?: unknown } | undefined)?.keystroke;
                return keystroke === undefined || typeof keystroke === 'string'
                  ? { ok: true as const }
                  : { ok: false as const, reason: 'invalid keystroke' };
              },
              execute: async () => await permissionBroker.approve(
                command.sessionId,
                (command.payload as { keystroke?: string } | undefined)?.keystroke ?? '1',
                command.actorId,
              ),
            },
          });
        case 'skip':
          return await executeWithPipeline({
            journal: commandJournal!,
            request: command,
            isOwnerLocal,
            handler: {
              action: 'skip',
              authorize,
              validate: baseValidate,
              execute: async () => {
                const anomaly = queue.getAnomaly(command.sessionId);
                const anomalyType = anomaly?.type ?? 'needs_input';
                queue.skip(command.sessionId);
                await interactionLog.append({
                  type: 'finding_skipped',
                  agentId: command.sessionId,
                  anomalyType,
                  timestamp: new Date().toISOString(),
                });
                return { skipped: true };
              },
            },
          });
        case 'snooze':
          return await executeWithPipeline({
            journal: commandJournal!,
            request: command,
            isOwnerLocal,
            handler: {
              action: 'snooze',
              authorize,
              validate: () => {
                const valid = baseValidate();
                if (!valid.ok) return valid;
                const durationMs = (command.payload as { durationMs?: unknown } | undefined)?.durationMs;
                return typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
                  ? { ok: true as const }
                  : { ok: false as const, reason: 'invalid durationMs' };
              },
              execute: async () => {
                const anomaly = queue.getAnomaly(command.sessionId);
                const durationMs = (command.payload as { durationMs: number }).durationMs;
                const snooze = queue.snooze(command.sessionId, durationMs, 'remote', anomaly ?? undefined);
                if (!snooze) throw new Error('nothing to snooze');
                await interactionLog.append({
                  type: 'finding_snoozed',
                  agentId: command.sessionId,
                  durationMs,
                  anomalyType: anomaly?.type,
                  timestamp: new Date().toISOString(),
                });
                return { snoozedUntil: snooze.expiresAt };
              },
            },
          });
        case 'mark-done':
          return await executeWithPipeline({
            journal: commandJournal!,
            request: command,
            isOwnerLocal,
            handler: {
              action: 'mark-done',
              authorize,
              validate: () => {
                const valid = baseValidate();
                if (!valid.ok) return valid;
                const taskId = (command.payload as { taskId?: unknown } | undefined)?.taskId;
                return typeof taskId === 'string' && taskStore.getTask(taskId)
                  ? { ok: true as const }
                  : { ok: false as const, reason: 'unknown taskId' };
              },
              execute: async () => {
                const taskId = (command.payload as { taskId: string }).taskId;
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
                  checkpointCycler,
                  queue,
                });
                return { taskId };
              },
            },
          });
        case 'launch': {
          if (!remoteLaunchBroker) {
            return await commandJournal!.appendPreAuditReject(command, 'launch feature disabled');
          }
          const launchCommand = {
            ...command,
            grantsChecked: ['launch' as const],
          } as Parameters<typeof remoteLaunchBroker.handle>[0];
          return await executeWithPipeline({
            journal: commandJournal!,
            request: launchCommand,
            isOwnerLocal,
            handler: remoteLaunchBroker,
          });
        }
      }
    });
  }

  const startupRecoverySummary = await runStartupRecoveryPhase({
    taskStore,
    queue,
    monitor,
    watchdog,
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
  });
  await promotePendingStartupTasks({
    taskStore,
    adapterRegistry,
    lifecycleDeps,
    broadcastToAll,
    serverCwd,
  });

  const { scheduleStore, scheduleService, scheduleRunner } = await createScheduleRuntime({
    kookrDir,
    taskStore,
    launchServiceDeps,
    getMaxActiveTasks,
    broadcastToAll,
  });
  realtime.setScheduleStore(scheduleStore);
  realtime.setSnapshotAchievementsReady(true);

  // --- Self-diagnostic runner ---
  const serverStartMs = Date.now();
  const diagnosticRunner = new DiagnosticRunner({
    getDetectionStats,
    getAgentCount: () => taskStore.listTasks().length,
    getUptimeMs: () => Date.now() - serverStartMs,
    getWsBroadcastCount: () => realtime.getWsBroadcastCount(),
    getEventCounts: () => monitor.getEventCounts(),
    measureSnapshotSizeBytes: () => {
      const msg = createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion });
      return JSON.stringify(msg).length;
    },
    onReport: (report) => {
      for (const f of report.findings) {
        if (f.severity === 'critical') {
          console.error(`[self-diagnostic] ${f.checkId}: ${f.description}`);
        } else {
          console.warn(`[self-diagnostic] ${f.checkId}: ${f.description}`);
        }
      }
      broadcastToAll({ type: 'diagnosticReport', report });
    },
  });
  diagnosticRunner.start();

  const app = createRoutes({
    taskStore, monitor, queue, adapter, hookWatcher, watchdog,
    interactionLog,
    githubScanner, githubStateStore, buildInfo, serverStartedAt,
    serverCwd, serverPort: port, frontendDir, broadcastToAll,
    shadowRegistry, httpPushTracker, hookIngestion, activityLedger, launchServiceDeps, sttUrl,
    projectConfigStore, projectSidebarStore, circuitBreakerRegistry,
    ossAttemptStore, ledgerAnalytics, ossRefresher, broadcastOssAttempts, getRegistryActiveRepos,
    skillDiscoveryState, prLessonsState, getRegistryActiveProjects, broadcastProjectSummaries,
    suppressionTracker, scheduleService, scheduleRunner,
    diagnosticRunner,
    terminalBackend,
    startupRecoverySummary,
    ralphCycler,
    tokenTracker,
    tasksFile,
    ralphLoopService,
    worktreeRegistry,
    getMaxActiveTasks,
    settings: {
      get: () => currentSettings,
      getLoadedFromDefaults: () => settingsLoadedFromDefaults,
      update: async (newSettings: KookrSettings) => {
        const prev = currentSettings;
        // Persist to disk FIRST. If saveSettings (inside applySettingsSideEffects)
        // throws, the in-memory `currentSettings` must not advance — otherwise
        // getMaxActiveTasks and other live getters would diverge from what's
        // on disk and the next snapshot would lie until the next restart.
        const warnings = await applySettingsSideEffects({
          prevSettings: prev,
          newSettings,
          settingsFile,
          githubScanner,
          watchdog,
          monitor,
        });
        currentSettings = newSettings;
        settingsLoadedFromDefaults = false;
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

  // --- Contribution Workspace services (Phase 1a) ---
  const leaseService = new WorktreeLeaseService();
  const serverProjectId = await getProjectId(serverCwd);
  const policyResolver = new RepoPolicyResolver({ serverProjectId });
  const attemptRepository = new WorkspaceAttemptRepository(join(kookrDir, 'workspace-attempts.json'));
  // Backfill leases from existing task/session state
  const leaseReconciliation = leaseService.reconcileFromTaskStore(taskStore);
  if (leaseReconciliation.backfilled > 0 || leaseReconciliation.released > 0) {
    console.log(`[workspace] Lease reconciliation: backfilled=${leaseReconciliation.backfilled} released=${leaseReconciliation.released}`);
  }

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
    await saveTasksWithSnapshotPolicy(
      taskStore.getAllTasks(),
      tasksFile,
      'predelete',
      taskStore.getLifetimeSpendUsd(),
      snoozes,
      suppressionState,
    );
  };

  const resourceStatusService = createResourceStatusService({
    sampler: createSystemResourceSampler(),
    broadcastToAll,
  });

  // --- Quota monitoring (polls Anthropic OAuth usage endpoint) ---
  const quotaAdapter = new QuotaAdapter(120_000); // 120s interval

  const wsConnectionDeps: WsConnectionDeps = {
    taskStore, queue, monitor, adapter, adapterRegistry,
    interactionLog, telemetryLog, buildInfo, serverStartedAt,
    serverCwd, sttUrl, abortPendingSuggestion,
    lifecycleExtras: { hookWatcher, watchdog, shadowRegistry, tokenTracker },
    agentLifecycleDeps: lifecycleDeps, broadcastToAll,
    broadcastProjectSummaries,
    launchTask: (opts) => launchTask(launchServiceDeps, opts),
    githubStateStore, ledgerAnalytics, projectConfigStore, projectSidebarStore,
    skillDiscoveryState, prLessonsState, getRegistryActiveProjects,
    achievementWatcher,
    getQuotaStatus: () => quotaAdapter.getLatest(),
    circuitBreakerRegistry,
    getMaxActiveTasks, suppressionTracker,
    availableAgentTypes: AVAILABLE_AGENT_TYPES.filter((item) => adapterRegistry.getTypes().includes(item.type)),
    defaultAgentType: getDefaultAgentType(),
    getDefaultAgentType,
    activityMetaProvider: hookIngestion,
    scheduleService,
    ralphLoopService,
    getDiagnosticStatus: () => diagnosticRunner.getStatus(),
    getLatestResourceStatus: () => resourceStatusService.getLatest(),
    workspaceEnabled: true,
    attemptRepository,
    policyResolver,
    leaseService,
    serverProjectId,
    takePredeleteSnapshot,
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
    timerDeps: {
      monitor, taskStore, queue, adapter, adapterRegistry, tokenTracker, watchdog,
      hookWatcher, terminalBackend, hooksDir, tasksFile, serverCwd,
      saveIntervalMs, livenessIntervalMs, broadcastToAll,
      shadowRegistry, agentLifecycleDeps: lifecycleDeps,
      quotaAdapter, getMaxActiveTasks, suppressionTracker,
      checkpointCycler, budgetChecker,
      worktreeRegistry,
      worktreeRegistryRepoPath: serverCwd,
      getDashboardClientCount: () => clients.size,
    },
  });

  const { httpServer, wss, terminalWss, activeBridges } = await startHttpAndWebSockets({
    app,
    port,
    host,
    tasksFile,
    hooksDir,
    terminalBackend,
    terminalDeps,
    useFakeTerminalBridge,
    onDashboardConnection: (ws) => handleWsConnection(ws, clients, wsConnectionDeps),
  });

  // Start background services that should wait for the server to be listening.
  backgroundServices.startAfterListen();
  remoteNodeClient?.start();

  // --- Close ---

  let isClosed = false;

  async function close(): Promise<void> {
    if (isClosed) return;
    isClosed = true;

    backgroundServices.stop();

    // Final save
    try {
      const snoozedFindings = serializeSnoozed(queue, taskStore);
      await saveTasks(taskStore.getAllTasks(), tasksFile, taskStore.getLifetimeSpendUsd(), snoozedFindings);
      await ossAttemptStore.save();
      await projectConfigStore.save();
      await scheduleStore.persist();
    } catch (err) {
      console.error('Error saving on shutdown:', err);
    }

    // Drain any pending suggestion lifecycles before shutdown
    drainLifecycles(telemetryLog);

    // Stop diagnostic runner
    diagnosticRunner.dispose();
    sessionStreamPublisher?.stop();
    await remoteNodeClient?.stop();

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

    // Close WebSocket connections
    for (const ws of clients) {
      ws.close(1001, 'Server shutting down');
    }
    clients.clear();

    // Telegram integration shutdown (releases lockfile so prod:restart picks up cleanly).
    if (telegramHandle) {
      try { await telegramHandle.stop(); } catch (err) { console.warn('[telegram] stop failed:', err); }
    }

    // Close servers
    terminalWss.close();
    wss.close();

    // Final flush of the terminal backend's ring snapshots before the process
    // exits. The dtach masters survive (spawned with setsid); this only stops
    // backend-owned background work and persists in-flight bytes that the
    // periodic flush hasn't picked up yet. Without this, `pnpm prod:restart`
    // races the 2 s flush cadence and the most-recent bytes are lost on
    // re-attach.
    terminalBackend.close?.();

    return new Promise((resolve) => {
      httpServer.close(() => resolve());
    });
  }

  // --- Telegram remote-chat trigger (opt-in; off by default) ---
  // See docs/rfc/rfc-remote-chat-trigger.md. Enabled when KOOKR_TELEGRAM_BOT_TOKEN
  // is set; the panic switch KOOKR_REMOTE_CHAT_DISABLED=1 short-circuits everything.
  let telegramHandle: { stop(): Promise<void> } | null = null;
  if (process.env.KOOKR_REMOTE_CHAT_DISABLED === '1') {
    console.log('[telegram] disabled via KOOKR_REMOTE_CHAT_DISABLED');
  } else if (process.env.KOOKR_TELEGRAM_BOT_TOKEN) {
    try {
      const { startTelegramTrigger, probeWhisperReachability } = await import('../integrations/telegram/index.js');
      const allowedUserIds = new Set(
        (process.env.KOOKR_TELEGRAM_ALLOWED_USERS ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map(Number)
          .filter((n) => !isNaN(n)),
      );
      const allowedProjects = (process.env.KOOKR_REMOTE_CHAT_PROJECTS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((cwd) => ({ name: cwd.split('/').pop() ?? cwd, cwd }));

      if (allowedUserIds.size === 0) {
        console.warn(
          '[telegram] KOOKR_TELEGRAM_BOT_TOKEN set but KOOKR_TELEGRAM_ALLOWED_USERS empty — refusing to start ' +
          '(an unauthenticated bot would be a backdoor).',
        );
      } else if (allowedProjects.length === 0) {
        console.warn(
          '[telegram] KOOKR_TELEGRAM_BOT_TOKEN set but KOOKR_REMOTE_CHAT_PROJECTS empty — refusing to start ' +
          '(no projects to spawn against).',
        );
      } else {
        const dashboardBaseUrl = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
        const handle = await startTelegramTrigger({
          token: process.env.KOOKR_TELEGRAM_BOT_TOKEN,
          allowedUserIds,
          allowedProjects,
          dataDir: kookrDir,
          dryRun: process.env.KOOKR_REMOTE_CHAT_DRY_RUN === '1',
          allowCodexRemoteSpawn: process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX === '1',
          dashboardBaseUrl,
          launchTask: (opts) => launchTask(launchServiceDeps, opts),
          llmClient,
          // Telegram audio transcription via the local faster-whisper-server.
          // Unset → audio messages are dropped with `dropped_audio_disabled`.
          // See issues #574 and #585.
          whisperUrl: process.env.KOOKR_STT_WHISPER_URL,
          // Cascade server shutdown into the warmup so STT teardown does not
          // race the in-flight whisper request. See issue #188.
          lifecycleSignal,
        });
        telegramHandle = handle;
        // Install the late-bound R16 callback now that the integration is up.
        onPermissionBlockedHolder = handle.onPermissionBlocked;
        console.log(
          `[telegram] active — allowedUsers=${allowedUserIds.size} projects=${allowedProjects.length} ` +
          `dryRun=${process.env.KOOKR_REMOTE_CHAT_DRY_RUN === '1'} ` +
          `codex=${process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX === '1' ? 'enabled' : 'disabled'} ` +
          `audio=${process.env.KOOKR_STT_WHISPER_URL ? 'enabled' : 'disabled'}`,
        );
        // Issue #576: surface whisper misconfig at startup so operators see it
        // in the server log instead of inferring it from per-message timeouts.
        // Probe is fire-and-forget and informational only — never gates startup,
        // never re-runs. Per-message error path (#574/#577) remains the runtime
        // fallback for any whisper container that restarts after this point.
        if (process.env.KOOKR_STT_WHISPER_URL) {
          const whisperUrl = process.env.KOOKR_STT_WHISPER_URL;
          void probeWhisperReachability(whisperUrl).then((probe) => {
            if (probe.ok) {
              const suffix = probe.modelCount !== null ? ` (${probe.modelCount} models)` : '';
              console.log(`[telegram] voice probe: 200 OK${suffix}`);
            } else {
              console.warn(
                `[telegram] voice probe FAILED: ${probe.reason} at ${whisperUrl}/v1/models — ` +
                'voice transcription will fail per-message',
              );
            }
          });
        }
      }
    } catch (err) {
      // Integration startup failure must NOT crash the server. Log and continue.
      console.error('[telegram] Failed to start integration:', err instanceof Error ? err.message : err);
    }
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
    app,
    broadcastToAll,
    close,
  };
}
