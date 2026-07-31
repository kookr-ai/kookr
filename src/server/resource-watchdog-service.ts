/**
 * Resource watchdog service (issue #1724).
 *
 * Periodic host sampler → pure evaluator → throttled investigation/meta spawn
 * through the existing launch path (capacity/backpressure, reserved slots).
 * Health snapshot is pure in-memory (issue #1553: no scans on `/api/health`).
 */

import type { LaunchOpts, LaunchResult } from '../shared/contracts/launch.js';
import {
  evaluateResourceWatchdog,
  countSpawnsInWindow,
} from '../core/resource-watchdog-eval.js';
import {
  buildAuditRecord,
  type ResourceWatchdogAuditSink,
} from '../core/resource-watchdog-audit.js';
import {
  buildResourceWatchdogPrompt,
  resourceWatchdogTaskName,
} from '../core/resource-watchdog-prompt.js';
import {
  emptyResourceWatchdogState,
  recordSpawn,
  recordTriggerOnly,
  type ResourceWatchdogStateStore,
} from '../core/resource-watchdog-state.js';
import type {
  ResourceWatchdogConfig,
  ResourceWatchdogHealthSnapshot,
  ResourceWatchdogPersistedState,
  ResourceWatchdogSample,
} from '../core/resource-watchdog-types.js';
import type { ResourceWatchdogHostSampler } from './resource-watchdog-sampler.js';

export interface ResourceWatchdogServiceDeps {
  getConfig: () => ResourceWatchdogConfig;
  sampler: ResourceWatchdogHostSampler;
  stateStore: ResourceWatchdogStateStore;
  auditSink: ResourceWatchdogAuditSink;
  /**
   * Launch via the standard path (same as POST /api/tasks). Must honor
   * capacity/backpressure. Injected so tests never spawn real tasks.
   */
  launchTask: (opts: LaunchOpts) => Promise<LaunchResult>;
  /** Optional tail of server.log for the brief (already truncated). */
  readServerLogTail?: () => string | null;
  /** Optional recent audit lines for the brief. */
  readAuditTail?: () => string | null;
  nowMs?: () => number;
  nowIso?: () => string;
  logger?: Pick<typeof console, 'info' | 'warn'>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class ResourceWatchdogService {
  private readonly getConfig: ResourceWatchdogServiceDeps['getConfig'];
  private readonly sampler: ResourceWatchdogHostSampler;
  private readonly stateStore: ResourceWatchdogStateStore;
  private readonly auditSink: ResourceWatchdogAuditSink;
  private readonly launchTask: ResourceWatchdogServiceDeps['launchTask'];
  private readonly readServerLogTail: () => string | null;
  private readonly readAuditTail: () => string | null;
  private readonly nowMs: () => number;
  private readonly nowIso: () => string;
  private readonly logger: Pick<typeof console, 'info' | 'warn'>;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private timeout: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private tickInFlight = false;
  private state: ResourceWatchdogPersistedState;
  private previousOomKillTotal: number | null = null;
  private lastSample: ResourceWatchdogSample | null = null;
  private lastDecision: ResourceWatchdogHealthSnapshot['lastDecision'] = null;

  constructor(deps: ResourceWatchdogServiceDeps) {
    this.getConfig = deps.getConfig;
    this.sampler = deps.sampler;
    this.stateStore = deps.stateStore;
    this.auditSink = deps.auditSink;
    this.launchTask = deps.launchTask;
    this.readServerLogTail = deps.readServerLogTail ?? (() => null);
    this.readAuditTail = deps.readAuditTail ?? (() => null);
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
    this.logger = deps.logger ?? console;
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
    this.state = this.stateStore.load();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const config = this.getConfig();
    if (config.enabled) {
      this.logger.info(
        `[resource-watchdog] enabled (interval=${config.intervalMs}ms, ` +
          `swap≥${config.swapUsedPercentThreshold}%, mem≤${config.memAvailableMbFloor}MiB, ` +
          `proc≥${config.processCeiling}, orphans≥${config.orphanCeiling}, ` +
          `throttle=${config.throttleMs}ms, budget24h=${config.spawnBudget24h})`,
      );
    } else {
      this.logger.info(
        '[resource-watchdog] disabled (set KOOKR_RESOURCE_WATCHDOG=1 to enable)',
      );
    }
    void this.tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timeout) {
      this.clearTimeoutFn(this.timeout);
      this.timeout = null;
    }
  }

  /** Cheap in-memory snapshot for `/api/health`. */
  getHealthSnapshot(): ResourceWatchdogHealthSnapshot {
    const config = this.getConfig();
    const nowMs = this.nowMs();
    const spawnsIn24h = countSpawnsInWindow(
      this.state.spawnTimestamps,
      nowMs,
      config.spawnBudgetWindowMs,
    );
    const lastSpawnMs = this.state.lastSpawnAt ? Date.parse(this.state.lastSpawnAt) : NaN;
    let throttleRemainingMs = 0;
    let throttleOpen = true;
    if (Number.isFinite(lastSpawnMs)) {
      const elapsed = nowMs - lastSpawnMs;
      if (elapsed < config.throttleMs) {
        throttleOpen = false;
        throttleRemainingMs = config.throttleMs - elapsed;
      }
    }
    return {
      enabled: config.enabled,
      lastSampleAt: this.lastSample?.sampledAt ?? null,
      lastSample: this.lastSample
        ? {
            swapUsedPercent: this.lastSample.swapUsedPercent,
            memAvailableMb: this.lastSample.memAvailableMb,
            oomKillTotal: this.lastSample.oomKillTotal,
            processCounts: this.lastSample.processCounts,
            orphanSessionCount: this.lastSample.orphanSessionCount,
            terminalLeakCount: this.lastSample.terminalLeakCount,
          }
        : null,
      lastTriggerAt: this.state.lastTriggerAt,
      lastTriggerReasons: this.state.lastTriggerReasons,
      lastSpawnAt: this.state.lastSpawnAt,
      lastSpawnKind: this.state.lastSpawnKind,
      lastSpawnTaskId: this.state.lastSpawnTaskId,
      spawnsIn24h,
      throttleOpen,
      throttleRemainingMs,
      lastDecision: config.enabled ? this.lastDecision : 'disabled',
    };
  }

  /** One evaluation cycle. Exposed for tests (does not require start()). */
  async runOnce(): Promise<void> {
    await this.evaluateAndAct();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.evaluateAndAct();
    } catch (err) {
      this.logger.warn(
        '[resource-watchdog] tick failed:',
        err instanceof Error ? err.message : err,
      );
    } finally {
      if (this.running) {
        const intervalMs = Math.max(1_000, this.getConfig().intervalMs);
        this.timeout = this.setTimeoutFn(() => {
          void this.tick();
        }, intervalMs);
        (this.timeout as { unref?: () => void }).unref?.();
      }
    }
  }

  private async evaluateAndAct(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const config = this.getConfig();
      if (!config.enabled) {
        this.lastDecision = 'disabled';
        return;
      }

      let sample: ResourceWatchdogSample;
      try {
        sample = this.sampler.sample();
      } catch (err) {
        this.logger.warn(
          '[resource-watchdog] sample failed:',
          err instanceof Error ? err.message : err,
        );
        return;
      }
      this.lastSample = sample;

      const decision = evaluateResourceWatchdog({
        sample,
        previousOomKillTotal: this.previousOomKillTotal,
        state: this.state,
        config,
        nowMs: this.nowMs(),
      });
      // Advance oom baseline after evaluation so a delta is only seen once.
      if (sample.oomKillTotal !== null) {
        this.previousOomKillTotal = sample.oomKillTotal;
      }
      this.lastDecision = decision.action;

      if (decision.action === 'idle') {
        return;
      }

      if (decision.action === 'suppress_throttled') {
        this.state = recordTriggerOnly({
          state: this.state,
          nowIso: this.nowIso(),
          triggerReasons: decision.triggers.map((t) => t.reason),
        });
        this.persistState();
        this.auditSink.append(buildAuditRecord({
          action: 'suppress_throttled',
          timestamp: this.nowIso(),
          sample,
          triggers: decision.triggers,
          throttleRemainingMs: decision.throttleRemainingMs,
          spawnsInWindow: countSpawnsInWindow(
            this.state.spawnTimestamps,
            this.nowMs(),
            config.spawnBudgetWindowMs,
          ),
        }));
        this.logger.warn(
          `[resource-watchdog] pressure detected but throttled ` +
            `(${decision.throttleRemainingMs}ms remaining): ` +
            decision.triggers.map((t) => t.reason).join(','),
        );
        return;
      }

      // action === 'spawn'
      this.auditSink.append(buildAuditRecord({
        action: 'trigger',
        timestamp: this.nowIso(),
        sample,
        triggers: decision.triggers,
        kind: decision.kind,
        spawnsInWindow: decision.spawnsInWindow,
      }));

      // Arm throttle *before* launch so a crash mid-launch or a capacity
      // rejection cannot re-fire every intervalMs under pressure. taskId is
      // patched in on success.
      const nowMs = this.nowMs();
      const nowIso = this.nowIso();
      const retainMs = Math.max(config.throttleMs, config.spawnBudgetWindowMs);
      this.state = recordSpawn({
        state: this.state,
        nowIso,
        nowMs,
        kind: decision.kind,
        taskId: null,
        triggerReasons: decision.triggers.map((t) => t.reason),
        retainMs,
      });
      this.persistState();

      const prompt = buildResourceWatchdogPrompt({
        kind: decision.kind,
        sample,
        triggers: decision.triggers,
        spawnsInWindow: decision.spawnsInWindow,
        spawnBudget24h: config.spawnBudget24h,
        serverLogTail: this.readServerLogTail() ?? undefined,
        recentAuditTail: this.readAuditTail() ?? undefined,
      });

      let taskId: string | null = null;
      try {
        const result = await this.launchTask({
          prompt,
          cwd: config.taskCwd,
          name: resourceWatchdogTaskName(decision.kind),
          disableDedup: true,
          // 'api' source participates in spawn-burst budgets; actor 'kookr'
          // may consume reserved self-maintenance slots (#1564 default).
          launchSource: 'api',
          launchActorId: 'kookr',
          unattended: true,
          autoCloseOnSignal: true,
        });
        taskId = result.task.id;
        this.state = {
          ...this.state,
          lastSpawnTaskId: taskId,
        };
        this.persistState();
        this.logger.warn(
          `[resource-watchdog] spawned ${decision.kind} task ${taskId}` +
            (result.queued ? ' (queued)' : '') +
            ` — triggers: ${decision.triggers.map((t) => t.reason).join(',')}`,
        );
        this.auditSink.append(buildAuditRecord({
          action: 'spawn',
          timestamp: this.nowIso(),
          sample,
          triggers: decision.triggers,
          kind: decision.kind,
          taskId,
          spawnsInWindow: decision.spawnsInWindow,
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[resource-watchdog] spawn failed: ${message}`);
        // Throttle already armed above — do not clear it. A host under
        // pressure that rejects launches must quiet for throttleMs, not retry
        // every sample interval.
        this.auditSink.append(buildAuditRecord({
          action: 'spawn_failed',
          timestamp: this.nowIso(),
          sample,
          triggers: decision.triggers,
          kind: decision.kind,
          error: message,
          spawnsInWindow: decision.spawnsInWindow,
        }));
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private persistState(): void {
    try {
      this.stateStore.save(this.state);
    } catch (err) {
      this.logger.warn(
        '[resource-watchdog] failed to persist state:',
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export function createResourceWatchdogService(
  deps: ResourceWatchdogServiceDeps,
): ResourceWatchdogService {
  return new ResourceWatchdogService(deps);
}

export function defaultResourceWatchdogHealthSnapshot(
  enabled = false,
): ResourceWatchdogHealthSnapshot {
  return {
    enabled,
    lastSampleAt: null,
    lastSample: null,
    lastTriggerAt: null,
    lastTriggerReasons: [],
    lastSpawnAt: null,
    lastSpawnKind: null,
    lastSpawnTaskId: null,
    spawnsIn24h: 0,
    throttleOpen: true,
    throttleRemainingMs: 0,
    lastDecision: enabled ? null : 'disabled',
  };
}

// Re-export for callers that only need the empty state factory.
export { emptyResourceWatchdogState };
