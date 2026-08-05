import { readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { AttentionQueue } from '../../core/attention-queue.js';
import { BudgetChecker, readBudgetThresholdFromEnv } from '../../core/budget-checker.js';
import { loadBuildInfo, type BuildInfo } from '../../core/build-info.js';
import { CircuitBreaker, CircuitBreakerRegistry } from '../../core/circuit-breaker.js';
import { CircuitBreakerLlmClient } from '../../core/circuit-breaker-llm-client.js';
import { DeferredInteractionLogWriter } from '../../core/interaction-log.js';
import { createLlmClient } from '../../adapters/llm/factory.js';
import type { LlmClient } from '../../core/llm-client.js';
import { Monitor } from '../../core/monitor.js';
import { ProjectConfigStore } from '../../core/project-config-store.js';
import { ProjectSidebarStore } from '../../core/project-sidebar-store.js';
import { RalphCycler } from '../../core/ralph-cycler.js';
import { loadSettings, type KookrSettings } from '../../core/settings-store.js';
import { ShadowDetectorRegistry } from '../../core/shadow-detector.js';
import { SnoozeSuppressionTracker } from '../../core/snooze-suppression.js';
import { TaskStore } from '../../core/tasks.js';
import { DeferredTelemetryLogWriter } from '../../core/telemetry.js';
import { TokenTracker } from '../../core/token-tracker.js';
import { Watchdog } from '../../core/watchdog.js';
import { WorktreeRegistry } from '../../adapters/git-worktree-registry.js';
import { createOpenRouterLlmClientFromEnv } from '../../adapters/llm/openrouter-client.js';
import { createRequestyLlmClientFromEnv } from '../../adapters/llm/requesty-client.js';
import { createBasetenLlmClientFromEnv } from '../../adapters/llm/baseten-client.js';
import { CombinedShadowStrategy } from '../../core/combined-shadow-strategy.js';
import { HttpPushTracker } from '../../core/http-push-tracker.js';
import { PaneSemanticsStrategy } from '../../core/pane-patterns.js';
import {
  ProcessLivenessStrategy,
  type ProcessLivenessProbe,
} from '../../core/process-liveness.js';
import {
  JsonlProgressBudgetBurnDiagnosticSink,
  ProgressBudgetBurnDiagnostics,
} from '../../core/progress-budget-burn-diagnostics.js';
import { createPermissionAlertBreaker } from '../permission-alert-breaker.js';

export interface CoreStoresDeps {
  kookrDir: string;
  hooksDir: string;
  settingsDir: string;
  frontendDir: string;
  /**
   * Optional session liveness probe for shadow process_liveness (dtach-backed).
   * When omitted the strategy is a no-op (safe for tests without a backend).
   */
  processLivenessProbe?: ProcessLivenessProbe;
}

export interface CoreStores {
  sessionsDir: string;
  interactionLog: DeferredInteractionLogWriter;
  telemetryLog: DeferredTelemetryLogWriter;
  buildInfo: BuildInfo;
  serverStartedAt: string;
  settingsFile: string;
  currentSettings: KookrSettings;
  settingsLoadedFromDefaults: boolean;
  settingsLoadWarnings: string[];
  /**
   * When set, settings load could not trust the kill-switch (issue #2085).
   * Cleared after a successful settings write recovers.
   */
  settingsLoadError?: string;
  circuitBreakerRegistry: CircuitBreakerRegistry;
  llmBreaker: CircuitBreaker;
  githubBreaker: CircuitBreaker;
  hookWatcherBreaker: CircuitBreaker;
  permissionAlertBreaker: CircuitBreaker;
  /** Speech STT health-probe breaker (issue #1772). */
  sttBreaker: CircuitBreaker;
  /** Speech TTS synthesize breaker (issue #1772). */
  ttsBreaker: CircuitBreaker;
  taskStore: TaskStore;
  worktreeRegistry: WorktreeRegistry;
  queue: AttentionQueue;
  suppressionTracker: SnoozeSuppressionTracker;
  monitor: Monitor;
  watchdog: Watchdog;
  ralphCycler: RalphCycler;
  tokenTracker: TokenTracker;
  budgetChecker: BudgetChecker;
  progressBudgetBurnDiagnostics: ProgressBudgetBurnDiagnostics;
  projectConfigStore: ProjectConfigStore;
  projectSidebarStore: ProjectSidebarStore;
  shadowRegistry: ShadowDetectorRegistry;
  httpPushTracker: HttpPushTracker;
  llmClient: CircuitBreakerLlmClient | null;
}

async function findRecentSession(sessionsDir: string, maxAgeMs: number): Promise<string | null> {
  try {
    const entries = await readdir(sessionsDir);
    if (entries.length === 0) return null;
    entries.sort().reverse();
    const latest = entries[0];
    const isoStr = latest.replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z');
    const ts = new Date(isoStr).getTime();
    if (isNaN(ts)) return null;
    if (Date.now() - ts <= maxAgeMs) return latest;
  } catch {
    // sessions dir doesn't exist yet
  }
  return null;
}

export async function createCoreStores(deps: CoreStoresDeps): Promise<CoreStores> {
  await mkdir(deps.kookrDir, { recursive: true });
  await mkdir(deps.hooksDir, { recursive: true });
  await mkdir(deps.settingsDir, { recursive: true });

  const sessionsDir = join(deps.kookrDir, 'sessions');
  let materializedSessionId: string | null = null;
  const resolveSessionId = async (): Promise<string> => {
    if (materializedSessionId) return materializedSessionId;
    materializedSessionId = await findRecentSession(sessionsDir, 30 * 60_000)
      ?? new Date().toISOString().replace(/[:.]/g, '-');
    return materializedSessionId;
  };

  const interactionLog = new DeferredInteractionLogWriter(sessionsDir, resolveSessionId);
  const telemetryLog = new DeferredTelemetryLogWriter(sessionsDir, () => materializedSessionId);
  const buildInfo = await loadBuildInfo(deps.frontendDir);
  const serverStartedAt = new Date().toISOString();

  const settingsFile = join(deps.kookrDir, 'settings.json');
  const settingsResult = await loadSettings(settingsFile);
  const currentSettings = settingsResult.settings;

  const circuitBreakerRegistry = new CircuitBreakerRegistry();
  const llmBreaker = new CircuitBreaker({ name: 'llm', failureThreshold: 5, failureWindowMs: 60_000, resetTimeoutMs: 30_000 });
  const githubBreaker = new CircuitBreaker({ name: 'github', failureThreshold: 5, failureWindowMs: 60_000, resetTimeoutMs: 60_000 });
  const hookWatcherBreaker = new CircuitBreaker({ name: 'hook-watcher', failureThreshold: 10, failureWindowMs: 60_000, resetTimeoutMs: 30_000 });
  const permissionAlertBreaker = createPermissionAlertBreaker();
  // Speech providers (issue #1772): same default thresholds as llm; degrade by
  // skipping fresh synthesis / STT health probes while open.
  const sttBreaker = new CircuitBreaker({ name: 'stt', failureThreshold: 5, failureWindowMs: 60_000, resetTimeoutMs: 30_000 });
  const ttsBreaker = new CircuitBreaker({ name: 'tts', failureThreshold: 5, failureWindowMs: 60_000, resetTimeoutMs: 30_000 });
  circuitBreakerRegistry.register(llmBreaker);
  circuitBreakerRegistry.register(githubBreaker);
  circuitBreakerRegistry.register(hookWatcherBreaker);
  circuitBreakerRegistry.register(permissionAlertBreaker);
  circuitBreakerRegistry.register(sttBreaker);
  circuitBreakerRegistry.register(ttsBreaker);

  const taskStore = new TaskStore();
  const worktreeRegistry = new WorktreeRegistry();
  const queue = new AttentionQueue({
    taskIdFor: (agentId) => taskStore.findTaskBySession(agentId)?.id ?? null,
  });
  const suppressionTracker = new SnoozeSuppressionTracker();
  const monitor = new Monitor(taskStore, queue, {
    repeatedErrorThreshold: currentSettings.repeatedErrorThreshold,
  }, undefined, suppressionTracker);
  const watchdog = new Watchdog({
    staleThresholdMs: currentSettings.watchdogStaleThresholdSec * 1000,
    unconditionalStaleThresholdMs: currentSettings.watchdogStaleThresholdSec * 2 * 1000,
  });
  const ralphCycler = new RalphCycler();
  const tokenTracker = new TokenTracker();

  const budgetThresholdUsd = readBudgetThresholdFromEnv();
  const budgetChecker = new BudgetChecker(budgetThresholdUsd);
  const progressBudgetBurnDiagnostics = new ProgressBudgetBurnDiagnostics(
    {},
    new JsonlProgressBudgetBurnDiagnosticSink(join(deps.kookrDir, 'budget-burn-diagnostics.jsonl')),
  );
  if (budgetThresholdUsd > 0) {
    console.log(`[budget] Warning threshold: $${budgetThresholdUsd.toFixed(2)} per task (critical at 2x)`);
  } else {
    console.log('[budget] Budget alerts disabled (KOOKR_BUDGET_WARN_USD=0)');
  }

  const projectConfigStore = new ProjectConfigStore(deps.kookrDir);
  await projectConfigStore.load();
  await projectConfigStore.loadRateLimits();
  const projectSidebarStore = new ProjectSidebarStore(deps.kookrDir);
  await projectSidebarStore.load();

  const shadowRegistry = new ShadowDetectorRegistry();
  shadowRegistry.register(new PaneSemanticsStrategy());
  const processLiveness = new ProcessLivenessStrategy(deps.processLivenessProbe);
  shadowRegistry.register(processLiveness);
  // Share the same process strategy (and probe cache) with combined.
  shadowRegistry.register(new CombinedShadowStrategy(undefined, processLiveness));
  const httpPushTracker = new HttpPushTracker();

  const rawLlmClient: LlmClient | null = await createLlmClient({
    buildOpenRouter: createOpenRouterLlmClientFromEnv,
    buildRequesty: createRequestyLlmClientFromEnv,
    buildBaseten: createBasetenLlmClientFromEnv,
  });
  const llmClient = rawLlmClient ? new CircuitBreakerLlmClient(rawLlmClient, llmBreaker) : null;
  if (rawLlmClient) {
    console.log(`[llm] Provider: ${rawLlmClient.provider} (${rawLlmClient.model})`);
  } else {
    console.log(
      '[llm] AI features disabled (set GROQ_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, KOOKR_OPENROUTER_API_KEY, OPENROUTER_API_KEY, KOOKR_REQUESTY_API_KEY, or REQUESTY_API_KEY)',
    );
  }

  return {
    sessionsDir,
    interactionLog,
    telemetryLog,
    buildInfo,
    serverStartedAt,
    settingsFile,
    currentSettings,
    settingsLoadedFromDefaults: settingsResult.loadedFromDefaults,
    settingsLoadWarnings: settingsResult.warnings,
    ...(settingsResult.loadError ? { settingsLoadError: settingsResult.loadError } : {}),
    circuitBreakerRegistry,
    llmBreaker,
    githubBreaker,
    hookWatcherBreaker,
    permissionAlertBreaker,
    sttBreaker,
    ttsBreaker,
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
  };
}
