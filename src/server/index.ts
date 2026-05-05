import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { getRequestListener } from '@hono/node-server';
import type { Hono } from 'hono';
import { WebSocketServer, WebSocket } from 'ws';

import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { Monitor } from '../core/monitor.js';
import { loadBuildInfo } from '../core/build-info.js';
import { loadTasks, saveTasks, saveTasksWithSnapshotPolicy, serializeSnoozed } from '../core/task-persistence.js';
import { TokenTracker } from '../core/token-tracker.js';
import { BudgetChecker, readBudgetThresholdFromEnv } from '../core/budget-checker.js';
import { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import { DeferredTelemetryLogWriter } from '../core/telemetry.js';
import { GitHubStateStore } from '../core/github-state-store.js';
import { GitHubScannerService } from '../core/github-scanner-service.js';
import { DEFAULT_GITHUB_SCANNER_CONFIG } from '../core/github-types.js';
import { HOOK_EVENTS, LOAD_BEARING_HOOKS } from '../core/hook-spec.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter.js';
import { CodexCliAdapter } from '../adapters/codex-cli-adapter.js';
import { RoutingAgentAdapter } from '../adapters/routing-agent-adapter.js';
import { ghCliFetcher } from '../adapters/github-fetcher.js';
import { CircuitBreakerGitHubFetcher } from '../adapters/circuit-breaker-github-fetcher.js';
import { reconcile } from './reconciliation.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { HookFileWatcher } from './hook-watcher.js';
import { generateTaskName } from '../core/task-naming.js';
import { createLlmClient } from '../core/llm-client.js';
import { FakeTerminalBridge } from './fake-terminal-bridge.js';
import { SessionBridge } from './session-bridge.js';
import type { BackendError, TerminalBackend } from '../adapters/terminal-backend.js';
import { Watchdog } from '../core/watchdog.js';
import { formatGitHubAlert } from '../core/github-alerts.js';
import { wireEventPipeline } from './event-pipeline.js';
import {
  CheckpointCycler,
  readTriggerRatioFromEnv,
  readMaxCancelledAttemptsFromEnv,
} from '../core/checkpoint-cycler.js';
import { drainLifecycles } from '../core/suggestion-telemetry.js';
import { createRoutes } from './routes.js';
import { startLifecycleTimers, clearAllTimers } from './lifecycle-timers.js';
import {
  handleTerminalInput, handleTerminalKeystroke,
  type AgentLifecycleDeps, type TerminalInputDeps,
} from './agent-lifecycle.js';
import { launchTask, type LaunchServiceDeps } from './launch-service.js';
import { handleWsConnection, type WsConnectionDeps } from './ws-connection-handler.js';
import { ShadowDetectorRegistry } from '../core/shadow-detector.js';
import { QuotaAdapter } from '../adapters/quota-adapter.js';
import { PaneSemanticsStrategy } from '../core/pane-patterns.js';
import { ProcessLivenessStrategy } from '../core/process-liveness.js';
import { CombinedShadowStrategy } from '../core/combined-shadow-strategy.js';
import { HttpPushTracker } from '../core/http-push-tracker.js';
import { ProjectConfigStore } from '../core/project-config-store.js';
import { OssAttemptStore } from '../core/oss-attempt-store.js';
import { LedgerAnalytics } from '../core/ledger-analytics.js';
import { OssRefresher } from './oss-refresh.js';
import { toOssAttemptsSnapshot } from './oss-attempts-snapshot.js';
import { SkillDiscoveryStateHolder, SkillTrackedRepoDiscovery } from '../core/skill-tracked-repo-discovery.js';
import { PrLessonsDiscovery, PrLessonsStateHolder } from '../core/pr-lessons-discovery.js';
import { AchievementWatcher, loadAchievements } from './achievement-watcher.js';
import { ACHIEVEMENT_BY_ID } from '../core/achievement-catalog.js';
import { loadSettings, type KookrSettings } from '../core/settings-store.js';
import { CircuitBreaker, CircuitBreakerRegistry } from '../core/circuit-breaker.js';
import { CircuitBreakerLlmClient } from '../core/circuit-breaker-llm-client.js';
import { AutoProceedService } from './auto-proceed.js';
import { AutonomyOrchestrator } from './autonomy-orchestrator.js';
import { SnoozeSuppressionTracker } from '../core/snooze-suppression.js';
import { AVAILABLE_AGENT_TYPES } from '../core/agent-types.js';
import { ScheduleStore } from '../core/schedule.js';
import { ScheduleRunner } from './schedule-runner.js';
import { ScheduleValidator } from './schedule-validator.js';
import { ScheduleService } from './schedule-service.js';
import { startLedgerWatcher } from './ledger-watcher.js';
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
import { createSnapshotMessage, getProjectSummaries } from './use-cases/get-snapshot.js';
import { startBackgroundServices } from './bootstrap/start-background-services.js';

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

/**
 * Find the most recent session directory that was created within `maxAgeMs` milliseconds.
 * Session directory names are ISO timestamps with colons/dots replaced by hyphens.
 * Returns the directory name if found, or null to create a new session.
 */
async function findRecentSession(sessionsDir: string, maxAgeMs: number): Promise<string | null> {
  try {
    const entries = await readdir(sessionsDir);
    if (entries.length === 0) return null;
    // Sort descending — most recent first
    entries.sort().reverse();
    const latest = entries[0];
    // Parse the directory name back to a timestamp
    const isoStr = latest.replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z');
    const ts = new Date(isoStr).getTime();
    if (isNaN(ts)) return null;
    if (Date.now() - ts <= maxAgeMs) return latest;
  } catch {
    // sessions dir doesn't exist yet
  }
  return null;
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
    claudeDir,
  } = config;

  // Ensure directories exist
  await mkdir(kookrDir, { recursive: true });
  await mkdir(hooksDir, { recursive: true });
  await mkdir(settingsDir, { recursive: true });

  // Create core dependencies
  // Session creation is deferred until the first substantive event (agent_launched,
  // user_input, finding) to prevent empty sessions from dashboard opens, page
  // reloads, or server restarts with no agent activity. See issue #73.
  // Resume window is 30 min so reconnects land in the same session.
  const sessionsDir = join(kookrDir, 'sessions');
  let materializedSessionId: string | null = null;
  const resolveSessionId = async (): Promise<string> => {
    if (materializedSessionId) return materializedSessionId;
    materializedSessionId = await findRecentSession(sessionsDir, 30 * 60_000)
      ?? new Date().toISOString().replace(/[:.]/g, '-');
    return materializedSessionId;
  };
  const interactionLog = new DeferredInteractionLogWriter(sessionsDir, resolveSessionId);
  const telemetryLog = new DeferredTelemetryLogWriter(sessionsDir, () => materializedSessionId);

  // Load build metadata (generated by scripts/generate-build-info.ts during build)
  const buildInfo = await loadBuildInfo(frontendDir);
  const serverStartedAt = new Date().toISOString();

  // Load user settings (early — needed for watchdog/monitor construction)
  const settingsFile = join(kookrDir, 'settings.json');
  const settingsResult = await loadSettings(settingsFile);
  let currentSettings = settingsResult.settings;
  let settingsLoadedFromDefaults = settingsResult.loadedFromDefaults;

  // Circuit breaker registry — protects external service calls.
  // V8 (rfc-v8-tmux-removal.md) removed the `'tmux'` breaker: its failures
  // were always logic bugs (the adapter calling tmux on a dtach-only
  // session), and dtach binary / socket failures are surfaced directly
  // via `terminalBackend.onBackendError` into the anomaly queue and
  // `/api/health.terminalBackend`.
  const circuitBreakerRegistry = new CircuitBreakerRegistry();
  const llmBreaker = new CircuitBreaker({ name: 'llm', failureThreshold: 5, failureWindowMs: 60_000, resetTimeoutMs: 30_000 });
  const githubBreaker = new CircuitBreaker({ name: 'github', failureThreshold: 5, failureWindowMs: 60_000, resetTimeoutMs: 60_000 });
  const hookWatcherBreaker = new CircuitBreaker({ name: 'hook-watcher', failureThreshold: 10, failureWindowMs: 60_000, resetTimeoutMs: 30_000 });
  circuitBreakerRegistry.register(llmBreaker);
  circuitBreakerRegistry.register(githubBreaker);
  circuitBreakerRegistry.register(hookWatcherBreaker);

  const taskStore = new TaskStore();
  const queue = new AttentionQueue();
  const suppressionTracker = new SnoozeSuppressionTracker();
  const monitor = new Monitor(taskStore, queue, {
    repeatedErrorThreshold: currentSettings.repeatedErrorThreshold,
  }, undefined, suppressionTracker);
  const watchdog = new Watchdog({
    staleThresholdMs: currentSettings.watchdogStaleThresholdSec * 1000,
    unconditionalStaleThresholdMs: currentSettings.watchdogStaleThresholdSec * 2 * 1000,
  });
  // v5 checkpoint cycler — single instance shared between the periodic timer
  // (where `tick()` reads transcript fill ratios) and the event pipeline
  // (where Stop events advance the per-session state machine). Both consumers
  // are fail-open: a cycler error never breaks task launch or normal operation.
  const checkpointCycler = new CheckpointCycler({
    triggerRatio: readTriggerRatioFromEnv(),
    maxCancelledAttempts: readMaxCancelledAttemptsFromEnv(),
  });

  const claudeCodeAdapter = new ClaudeCodeAdapter(terminalBackend, taskStore, {
    hooksDir,
    settingsDir,
    writeFile: (path, content) => writeFile(path, content, 'utf-8'),
    serverPort: port,
    agentBin,
    bypassAllPermissions,
    kookrDataDir: kookrDir,
  });
  const codexCliAdapter = new CodexCliAdapter(terminalBackend, taskStore, {
    hooksDir,
    settingsDir,
    writeFile: (path, content) => writeFile(path, content, 'utf-8'),
    serverPort: port,
    agentBin: codexBin,
    bypassAllPermissions,
    kookrDataDir: kookrDir,
  });

  // Register adapters — first registered becomes the default
  const adapterRegistry = new AdapterRegistry();
  adapterRegistry.register(claudeCodeAdapter);
  adapterRegistry.register(codexCliAdapter);
  const adapter = new RoutingAgentAdapter(taskStore, adapterRegistry);

  // Create token tracker
  const tokenTracker = new TokenTracker();

  // Reactive budget threshold checker (issue #98). Threshold is per-task, in USD,
  // configurable via KOOKR_BUDGET_WARN_USD. Default $5 per task. Setting to 0
  // disables the check. Fires `budget_exceeded` anomalies through the attention
  // queue the first time a task crosses threshold and then 2x threshold.
  const budgetThresholdUsd = readBudgetThresholdFromEnv();
  const budgetChecker = new BudgetChecker(budgetThresholdUsd);
  if (budgetThresholdUsd > 0) {
    console.log(`[budget] Warning threshold: $${budgetThresholdUsd.toFixed(2)} per task (critical at 2x)`);
  } else {
    console.log('[budget] Budget alerts disabled (KOOKR_BUDGET_WARN_USD=0)');
  }

  // Project config store (daily/weekly PR limits, tracked flag, notes)
  const projectConfigStore = new ProjectConfigStore(kookrDir);
  await projectConfigStore.load();
  await projectConfigStore.loadRateLimits(); // Rate limits from oss-contribution-gate hook

  // OSS contribution lifecycle store (rfc-oss-contribution-tracking). Single
  // source of truth for outgoing PR attempts — absorbs the previous
  // ContributionStore role (ledger ingestion, today/week counts) alongside the
  // richer scouted → pr_open → merged/closed state machine.
  const ossAttemptStore = new OssAttemptStore(kookrDir);
  await ossAttemptStore.load();
  await ossAttemptStore.loadFromLedger(); // Authoritative source: contribution-ledger.jsonl
  const ledgerAnalytics = new LedgerAnalytics(ossAttemptStore);
  const ossRefresher = new OssRefresher({ store: ossAttemptStore, kookrDir });

  // Skill-tracked OSS discovery (read-only scan of ~/.claude/*-recon/recon-report.md).
  // One server-owned snapshot with last-known-good semantics.
  const resolvedClaudeDir = claudeDir ?? join(homedir(), '.claude');
  const skillDiscoveryState = new SkillDiscoveryStateHolder(
    new SkillTrackedRepoDiscovery(resolvedClaudeDir),
  );
  const initialDiscovery = await skillDiscoveryState.rescan();
  if (initialDiscovery.warnings.length > 0) {
    console.warn(
      `[skill-discovery] ${initialDiscovery.warnings.length} warning(s): ${initialDiscovery.warnings.join('; ')}`,
    );
  }
  if (initialDiscovery.lastError) {
    console.warn(`[skill-discovery] Initial scan failed: ${initialDiscovery.lastError}`);
  } else {
    console.log(`[skill-discovery] Loaded ${initialDiscovery.projects.length} skill-tracked repo(s)`);
  }

  // PR lessons discovery (read-only scan of ~/.claude/*-pr-lessons/state.json).
  const prLessonsState = new PrLessonsStateHolder(
    new PrLessonsDiscovery(resolvedClaudeDir),
  );
  await prLessonsState.rescan();

  // Create shadow detection registry with Phase 1-3 strategies (all in shadow mode)
  const shadowRegistry = new ShadowDetectorRegistry();
  shadowRegistry.register(new PaneSemanticsStrategy());
  shadowRegistry.register(new ProcessLivenessStrategy());
  shadowRegistry.register(new CombinedShadowStrategy());
  const httpPushTracker = new HttpPushTracker();

  // AI features (task naming, response suggestions) — enabled when any LLM API key is set
  const rawLlmClient = await createLlmClient();
  const llmClient = rawLlmClient ? new CircuitBreakerLlmClient(rawLlmClient, llmBreaker) : null;
  if (rawLlmClient) {
    console.log(`[llm] Provider: ${rawLlmClient.provider} (${rawLlmClient.model})`);
  } else {
    console.log('[llm] AI features disabled (set GROQ_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY)');
  }

  // STT feature (opt-in via KOOKR_STT_URL)
  if (sttUrl) {
    console.log(`[stt] Speech-to-text enabled (${sttUrl})`);
  } else {
    console.log('[stt] Speech-to-text disabled (no KOOKR_STT_URL)');
  }

  // Create GitHub scanner with user-configured intervals
  const githubStateStore = new GitHubStateStore();
  const githubScannerConfig = {
    ...DEFAULT_GITHUB_SCANNER_CONFIG,
    stateFetchIntervalMs: currentSettings.githubPollingIntervalSec * 1000,
    referenceExtractionIntervalMs: currentSettings.githubPollingIntervalSec * 1000,
  };
  const githubScanner = new GitHubScannerService({
    taskStore,
    stateStore: githubStateStore,
    fetcher: new CircuitBreakerGitHubFetcher(ghCliFetcher, githubBreaker),
    config: githubScannerConfig,
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

  // Load persisted tasks
  const persisted = await loadTasks(tasksFile);
  if (persisted.tasks.length > 0) {
    taskStore.loadTasks(persisted.tasks, persisted.lifetimeSpendUsd);
    console.log(`Loaded ${persisted.tasks.length} task(s) from ${tasksFile} (lifetime spend: $${taskStore.getLifetimeSpendUsd().toFixed(2)})`);
  }

  // Reconcile with live backend sessions
  const reconcileResult = await reconcile(taskStore, terminalBackend);
  if (reconcileResult.resumed.length > 0) {
    console.log(`Resumed monitoring: ${reconcileResult.resumed.join(', ')}`);
  }
  if (reconcileResult.markedCompleted.length > 0) {
    console.log(`Marked completed (session dead): ${reconcileResult.markedCompleted.join(', ')}`);
  }
  if (reconcileResult.orphans.length > 0) {
    console.warn(`Orphan sessions (not in tasks): ${reconcileResult.orphans.join(', ')}`);
  }

  // Hook watcher created here but resumed-session replay is deferred to after crash recovery,
  // so relaunched sessions have their new tmux names before snooze restore + hook replay.
  const hookWatcher = new HookFileWatcher(hooksDir, adapter);

  // Register transcripts for resumed sessions so token tracker picks up existing data
  for (const task of taskStore.getAllTasks()) {
    for (const session of task.sessions) {
      if (session.transcriptPath) {
        tokenTracker.register(session.transcriptPath, task.id);
      }
    }
  }

  // --- Achievements (must be created before broadcastToAll, which injects achievement state) ---

  const achievementsFile = join(kookrDir, 'achievements.json');
  const achievementState = await loadAchievements(achievementsFile);

  // --- WebSocket ---

  const clients = new Set<WebSocket>();

  // AchievementWatcher needs broadcastToAll for unlock notifications, and broadcastToAll
  // needs achievementWatcher for snapshot injection — break the cycle with a late-bound ref.
  let achievementWatcher: AchievementWatcher;

  let wsBroadcastCount = 0;

  function broadcastToAll(msg: ServerMessage): void {
    wsBroadcastCount++;
    // Auto-inject lifetime spending and achievements into snapshot messages
    if (msg.type === 'snapshot') {
      // Enrich with auto-proceed countdown timestamps
      if (autonomyOrchestrator) {
        for (const agent of msg.agents) {
          const proceedAt = autonomyOrchestrator.getActiveProceedAt(agent.agentId);
          if (proceedAt && agent.anomaly) {
            agent.anomaly.autoProceedingAt = proceedAt;
          }
        }
      }
      msg = { ...msg, totalSpendUsd: taskStore.getLifetimeSpendUsd(), achievements: achievementWatcher?.getUnlocked() };
      msg = {
        ...msg,
        availableAgentTypes: AVAILABLE_AGENT_TYPES.filter((item) => adapterRegistry.getTypes().includes(item.type)),
        defaultAgentType: adapterRegistry.getDefaultType(),
      };
    }
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  achievementWatcher = new AchievementWatcher(achievementsFile, achievementState, (unlock) => {
    const def = ACHIEVEMENT_BY_ID.get(unlock.id);
    if (def) {
      broadcastToAll({
        type: 'achievement:unlocked',
        id: unlock.id,
        name: def.name,
        emoji: def.emoji,
        description: def.description,
        unlockedAt: unlock.unlockedAt,
      });
    }
  });

  // --- Auto-proceed service + autonomy orchestrator ---

  const autoProceedService = new AutoProceedService({
    taskStore, monitor, queue, adapter,
    interactionLog, broadcastToAll, serverCwd,
  });

  const autonomyOrchestrator = new AutonomyOrchestrator({
    taskStore, monitor, queue, autoProceedService, interactionLog,
  });

  // --- Event pipeline ---

  // Late-bound R16 block-alert callback. The Telegram integration is started
  // later in bootstrap (after launchServiceDeps is fully built); this holder
  // lets wireEventPipeline take a stable callback shape now and the integration
  // installs the real implementation when it's ready.
  let onPermissionBlockedHolder: ((taskId: string, promptText: string) => void) | undefined;

  const { abortPendingSuggestion } = wireEventPipeline({
    adapter, monitor, taskStore, tokenTracker, watchdog,
    githubScanner, llmClient, serverCwd, broadcastToAll,
    autonomyOrchestrator, telemetryLog,
    checkpointCycler,
    onPermissionBlocked: (taskId, promptText) => {
      onPermissionBlockedHolder?.(taskId, promptText);
    },
  });

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
    broadcastToAll(createSnapshotMessage({ monitor, serverCwd, sttUrl }));
    broadcastProjectSummaries();
  });

  /** Compute and broadcast project summaries to all connected clients. */
  function broadcastProjectSummaries(): void {
    const projects = getProjectSummaries({
      monitor,
      ledgerAnalytics,
      projectConfigStore,
      getSkillTrackedProjects: () => skillDiscoveryState.getProjects(),
      prLessonsHolder: prLessonsState,
    });
    // Always broadcast — user-initiated mutations (track/untrack/rescan) can
    // legitimately transition the list to empty, and clients need the update.
    broadcastToAll({ type: 'projectSummaries', projects });
  }

  /** Broadcast the current OSS attempts snapshot to all connected clients. */
  function broadcastOssAttempts(): void {
    broadcastToAll({ type: 'ossAttempts', store: toOssAttemptsSnapshot(ossAttemptStore) });
  }

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
          broadcastToAll(createSnapshotMessage({ monitor, serverCwd, sttUrl }));
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
  };

  // Terminal input deps — used by terminal bridge handlers
  const terminalDeps: TerminalInputDeps = {
    monitor, abortPendingSuggestion, broadcastToAll, serverCwd,
  };

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
  });
  await promotePendingStartupTasks({
    taskStore,
    adapterRegistry,
    lifecycleDeps,
    broadcastToAll,
    serverCwd,
  });
  autonomyOrchestrator.rearmAfterRestart();

  // Live getter for max active tasks — reads from current settings
  const getMaxActiveTasks = () => currentSettings.maxActiveTasks;

  // Launch service deps — shared by WS handler and REST routes
  const launchServiceDeps: LaunchServiceDeps = { taskStore, adapterRegistry, lifecycleDeps, getMaxActiveTasks, interactionLog };

  // Schedule system — load schedules and start the cron runner
  const scheduleStore = new ScheduleStore(kookrDir);
  await scheduleStore.load();
  const scheduleValidator = new ScheduleValidator();
  const scheduleService = new ScheduleService({
    store: scheduleStore,
    validator: scheduleValidator,
    broadcast: (payload) => {
      broadcastToAll({ type: 'schedules', ...payload });
    },
  });
  await scheduleService.reconcileOnStartup(taskStore);
  const ACTIVE_STATUSES = new Set(['open', 'pending', 'inProgress']);
  const scheduleRunner = new ScheduleRunner({
    store: scheduleStore,
    service: scheduleService,
    validator: scheduleValidator,
    launcher: (opts) => launchTask(launchServiceDeps, opts),
    getActiveCount: () => taskStore.getActiveCount(),
    getMaxActiveTasks,
    isTaskActive: (taskId) => {
      const task = taskStore.getTask(taskId);
      return !!task && ACTIVE_STATUSES.has(task.status);
    },
  });

  // --- Self-diagnostic runner ---
  const serverStartMs = Date.now();
  const diagnosticRunner = new DiagnosticRunner({
    getDetectionStats,
    getAgentCount: () => taskStore.listTasks().length,
    getUptimeMs: () => Date.now() - serverStartMs,
    getWsBroadcastCount: () => wsBroadcastCount,
    getEventCounts: () => monitor.getEventCounts(),
    measureSnapshotSizeBytes: () => {
      const msg = createSnapshotMessage({ monitor, serverCwd });
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
    serverCwd, frontendDir, broadcastToAll,
    shadowRegistry, httpPushTracker, launchServiceDeps, sttUrl,
    projectConfigStore, circuitBreakerRegistry,
    ossAttemptStore, ledgerAnalytics, ossRefresher, broadcastOssAttempts,
    skillDiscoveryState, prLessonsState, broadcastProjectSummaries,
    autonomyOrchestrator, suppressionTracker, scheduleService, scheduleRunner,
    diagnosticRunner,
    terminalBackend,
    startupRecoverySummary,
    settings: {
      get: () => currentSettings,
      getLoadedFromDefaults: () => settingsLoadedFromDefaults,
      update: async (newSettings: KookrSettings) => {
        const prev = currentSettings;
        currentSettings = newSettings;
        settingsLoadedFromDefaults = false;
        return applySettingsSideEffects({
          prevSettings: prev,
          newSettings,
          settingsFile,
          githubScanner,
          watchdog,
          monitor,
        });
      },
    },
  });

  // --- HTTP Server + WebSocket Server ---

  const requestListener = getRequestListener(app.fetch);
  const httpServer = createServer(requestListener);

  const wss = new WebSocketServer({ noServer: true });
  const terminalWss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = req.url ?? '';

    if (url === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else if (url.startsWith('/ws/terminal/')) {
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        terminalWss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // Terminal WebSocket: bridge xterm.js to an agent session.
  // v7 Main B.b per-session routing:
  //   1. Fake bridge for E2E / demo mode.
  //   2. If terminalBackend is present AND knows about this sessionId →
  //      v7 SessionBridge (byte-transparent, ring-buffered).
  //   3. Otherwise legacy TerminalBridge (tmux attach). Covers the
  //      KOOKR_BACKEND=tmux escape hatch AND the cutover case where
  //      a live tmux-era session is still running alongside new
  //      dtach-backed sessions. Users re-launching the task moves it
  //      to the dtach path.
  // V8: two bridge kinds — Fake (E2E/demo) and Session (production). The
  // legacy TerminalBridge (which spawned `tmux attach` directly) is gone;
  // all production WS attaches go through `SessionBridge`, which subscribes
  // to the backend's byte stream.
  const activeBridges = new Map<WebSocket, FakeTerminalBridge | SessionBridge>();

  terminalWss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = req.url ?? '';
    const sessionName = decodeURIComponent(url.replace('/ws/terminal/', ''));

    if (!sessionName) {
      ws.close(1008, 'Missing session name');
      return;
    }

    void (async () => {
      const bridgeKind: 'fake' | 'session' = useFakeTerminalBridge ? 'fake' : 'session';
      console.log(`Terminal bridge opened for ${sessionName} (kind=${bridgeKind})`);

      if (bridgeKind === 'fake') {
        const content = FakeTerminalBridge.getContent(sessionName);
        const bridge = new FakeTerminalBridge(sessionName, ws, content);
        activeBridges.set(ws, bridge);
        bridge.start();
        return;
      }

      const sb = new SessionBridge(
        sessionName,
        ws,
        terminalBackend,
        (id) => handleTerminalInput(terminalDeps, id),
        (id) => handleTerminalKeystroke(terminalDeps, id),
      );
      activeBridges.set(ws, sb);
      sb.start().catch((err) => {
        console.error(`[session-bridge] attach failed for ${sessionName}:`, err);
      });
    })();

    ws.on('close', () => {
      console.log(`Terminal bridge closed for ${sessionName}`);
      activeBridges.delete(ws);
    });
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
    const snoozedFindings = serializeSnoozed(queue, taskStore);
    const suppressionState = suppressionTracker?.export();
    await saveTasksWithSnapshotPolicy(
      taskStore.getAllTasks(),
      tasksFile,
      'predelete',
      taskStore.getLifetimeSpendUsd(),
      snoozedFindings,
      suppressionState,
    );
  };

  const wsConnectionDeps: WsConnectionDeps = {
    taskStore, queue, monitor, adapter, adapterRegistry,
    interactionLog, telemetryLog, buildInfo, serverStartedAt,
    serverCwd, sttUrl, abortPendingSuggestion,
    lifecycleExtras: { hookWatcher, watchdog, shadowRegistry, tokenTracker, autonomyOrchestrator },
    agentLifecycleDeps: lifecycleDeps, broadcastToAll,
    broadcastProjectSummaries,
    launchTask: (opts) => launchTask(launchServiceDeps, opts),
    githubStateStore, ledgerAnalytics, projectConfigStore,
    skillDiscoveryState, prLessonsState,
    achievementWatcher,
    getQuotaStatus: () => quotaAdapter.getLatest(),
    circuitBreakerRegistry,
    getMaxActiveTasks, suppressionTracker,
    availableAgentTypes: AVAILABLE_AGENT_TYPES.filter((item) => adapterRegistry.getTypes().includes(item.type)),
    defaultAgentType: adapterRegistry.getDefaultType(),
    scheduleService,
    getDiagnosticStatus: () => diagnosticRunner.getStatus(),
    workspaceEnabled: true,
    attemptRepository,
    policyResolver,
    leaseService,
    serverProjectId,
    takePredeleteSnapshot,
  };

  // --- Quota monitoring (polls Anthropic OAuth usage endpoint) ---
  const quotaAdapter = new QuotaAdapter(120_000); // 120s interval

  wss.on('connection', (ws: WebSocket) => {
    handleWsConnection(ws, clients, wsConnectionDeps);
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
    timerDeps: {
      monitor, taskStore, queue, adapter, adapterRegistry, tokenTracker, watchdog,
      hookWatcher, terminalBackend, hooksDir, tasksFile, serverCwd,
      saveIntervalMs, livenessIntervalMs, broadcastToAll,
      shadowRegistry, agentLifecycleDeps: lifecycleDeps,
      quotaAdapter, getMaxActiveTasks, suppressionTracker,
      checkpointCycler, budgetChecker,
    },
  });

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

    // Stop auto-proceed timers
    autonomyOrchestrator.dispose();

    // Stop diagnostic runner
    diagnosticRunner.dispose();

    // Stop hook watchers and trackers
    hookWatcher.stopAll();
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

  // --- Start ---

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      console.log(`Kookr server listening on http://${host}:${port}`);
      console.log(`WebSocket endpoint: ws://${host}:${port}/ws`);
      console.log(`Task file: ${tasksFile}`);
      console.log(`Hook files: ${hooksDir}`);
      console.log(
        JSON.stringify({
          msg: 'hooks_inventory_loaded',
          eventCount: HOOK_EVENTS.length,
          loadBearingCount: LOAD_BEARING_HOOKS.size,
        }),
      );
      console.log('\nManaged agents run under dtach sessions prefixed with "kookr-".');
      console.log('Attach a Kookr-managed terminal through the dashboard terminal panel.\n');
      resolve();
    });
  });

  // Start background services that should wait for the server to be listening.
  backgroundServices.startAfterListen();

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
          dashboardBaseUrl,
          launchTask: (opts) => launchTask(launchServiceDeps, opts),
          llmClient,
          // Telegram audio transcription via the local faster-whisper-server.
          // Unset → audio messages are dropped with `dropped_audio_disabled`.
          // See issues #574 and #585.
          whisperUrl: process.env.KOOKR_STT_WHISPER_URL,
        });
        telegramHandle = handle;
        // Install the late-bound R16 callback now that the integration is up.
        onPermissionBlockedHolder = handle.onPermissionBlocked;
        console.log(
          `[telegram] active — allowedUsers=${allowedUserIds.size} projects=${allowedProjects.length} ` +
          `dryRun=${process.env.KOOKR_REMOTE_CHAT_DRY_RUN === '1'} ` +
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
    circuitBreakerRegistry,
    app,
    broadcastToAll,
    close,
  };
}
