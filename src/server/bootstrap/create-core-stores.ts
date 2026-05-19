import { readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { AttentionQueue } from '../../core/attention-queue.js';
import { BudgetChecker, readBudgetThresholdFromEnv } from '../../core/budget-checker.js';
import { loadBuildInfo, type BuildInfo } from '../../core/build-info.js';
import { CheckpointCycler, readMaxCancelledAttemptsFromEnv, readTriggerRatioFromEnv } from '../../core/checkpoint-cycler.js';
import { CircuitBreaker, CircuitBreakerRegistry } from '../../core/circuit-breaker.js';
import { CircuitBreakerLlmClient } from '../../core/circuit-breaker-llm-client.js';
import { DeferredInteractionLogWriter } from '../../core/interaction-log.js';
import { createLlmClient, type LlmClient } from '../../core/llm-client.js';
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
import { CombinedShadowStrategy } from '../../core/combined-shadow-strategy.js';
import { HttpPushTracker } from '../../core/http-push-tracker.js';
import { PaneSemanticsStrategy } from '../../core/pane-patterns.js';
import { ProcessLivenessStrategy } from '../../core/process-liveness.js';
import {
  JsonlProgressBudgetBurnDiagnosticSink,
  ProgressBudgetBurnDiagnostics,
} from '../../core/progress-budget-burn-diagnostics.js';

export interface CoreStoresDeps {
  kookrDir: string;
  hooksDir: string;
  settingsDir: string;
  frontendDir: string;
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
  circuitBreakerRegistry: CircuitBreakerRegistry;
  llmBreaker: CircuitBreaker;
  githubBreaker: CircuitBreaker;
  hookWatcherBreaker: CircuitBreaker;
  taskStore: TaskStore;
  worktreeRegistry: WorktreeRegistry;
  queue: AttentionQueue;
  suppressionTracker: SnoozeSuppressionTracker;
  monitor: Monitor;
  watchdog: Watchdog;
  checkpointCycler: CheckpointCycler;
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
  circuitBreakerRegistry.register(llmBreaker);
  circuitBreakerRegistry.register(githubBreaker);
  circuitBreakerRegistry.register(hookWatcherBreaker);

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
  const checkpointCycler = new CheckpointCycler({
    triggerRatio: readTriggerRatioFromEnv(),
    maxCancelledAttempts: readMaxCancelledAttemptsFromEnv(),
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
  shadowRegistry.register(new ProcessLivenessStrategy());
  shadowRegistry.register(new CombinedShadowStrategy());
  const httpPushTracker = new HttpPushTracker();

  const rawLlmClient: LlmClient | null = await createLlmClient();
  const llmClient = rawLlmClient ? new CircuitBreakerLlmClient(rawLlmClient, llmBreaker) : null;
  if (rawLlmClient) {
    console.log(`[llm] Provider: ${rawLlmClient.provider} (${rawLlmClient.model})`);
  } else {
    console.log(
      '[llm] AI features disabled (set GROQ_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, or KOOKR_OPENROUTER_API_KEY)',
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
    circuitBreakerRegistry,
    llmBreaker,
    githubBreaker,
    hookWatcherBreaker,
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
    progressBudgetBurnDiagnostics,
    projectConfigStore,
    projectSidebarStore,
    shadowRegistry,
    httpPushTracker,
    llmClient,
  };
}
