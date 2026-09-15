/**
 * Resource watchdog service (issue #1724).
 *
 * Periodic host sampler → pure evaluator → throttled investigation/meta spawn
 * through the existing launch path (capacity/backpressure, reserved slots).
 * Health snapshot is pure in-memory (issue #1553: no scans on `/api/health`).
 */

import type { LaunchOpts, LaunchResult } from '../shared/contracts/launch.js';
import { isTerminatedAtLaunch, type TaskDisposition } from '../shared/contracts/task.js';
import {
  evaluateResourceWatchdog,
  evaluatePressureWhileDisabled,
  evaluateDisabledPressureAutoEnable,
  DEFAULT_DTACH_PRESSURE_SOFT_BOUND,
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
  recordOomKillBaseline,
  recordSpawn,
  recordTriggerOnly,
  type ResourceWatchdogStateStore,
} from '../core/resource-watchdog-state.js';
import {
  RESOURCE_WATCHDOG_SYNC_RECLAIM_REASONS,
  type ResourceWatchdogConfig,
  type ResourceWatchdogDecision,
  type ResourceWatchdogHealthSnapshot,
  type ResourceWatchdogPersistedState,
  type ResourceWatchdogSample,
  type ResourceWatchdogSpawnKind,
} from '../core/resource-watchdog-types.js';
import type { ResourceWatchdogHostSampler } from './resource-watchdog-sampler.js';
import type { WatchdogDisabledPressureAlerter } from './watchdog-disabled-pressure-alert.js';
import { MAX_LAUNCH_TIMEOUT_SEC } from '../core/settings-store.js';

const MAX_PERSISTENCE_ERROR_CHARS = 500;
const MAX_LAUNCH_ERROR_CHARS = 500;

export interface ResourceWatchdogServiceDeps {
  getConfig: () => ResourceWatchdogConfig;
  sampler: ResourceWatchdogHostSampler;
  stateStore: ResourceWatchdogStateStore;
  auditSink: ResourceWatchdogAuditSink;
  /**
   * Launch via the standard path (same as POST /api/tasks). Must honor
   * capacity/backpressure. Injected so tests never spawn real tasks.
   */
  launchTask: (opts: LaunchOpts) => Promise<LaunchResult<{
    id: string;
    disposition?: Pick<TaskDisposition, 'reason' | 'detail'> | null;
  }>>;
  /** Optional tail of server.log for the brief (already truncated). */
  readServerLogTail?: () => string | null;
  /** Optional recent audit lines for the brief. */
  readAuditTail?: () => string | null;
  /**
   * Cached `staleProcesses.dtach.count` for the disabled-under-pressure page
   * (issue #2078). Only consulted when the actuator is off; null skips the
   * pressure signal for that tick. Injected so tests never scan `/proc`.
   */
  getStaleDtachCount?: () => number | null;
  /**
   * Page-only alerter when pressureWhileDisabled stays true (issue #2078).
   * Never enables the actuator and never spawns.
   */
  pressureWhileDisabledAlerter?: Pick<WatchdogDisabledPressureAlerter, 'evaluate'>;
  /**
   * Optional host-stale dtach reaper (issue #3247). When a spawn trigger is
   * dtach soft-bound, orphan ceiling, or process ceiling, one bounded
   * `runSweep` runs before `launchTask`. Tests omit this to keep the spawn
   * path unchanged.
   */
  hostStaleDtachReaper?: {
    runSweep: () => Promise<unknown> | unknown;
  };
  /**
   * Optional session reaper (issue #3247). Same reclaim-before-spawn pass as
   * `hostStaleDtachReaper`. Existing per-sweep caps still apply.
   */
  sessionReaper?: {
    runSweep: () => Promise<unknown> | unknown;
  };
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
  private readonly getStaleDtachCount: (() => number | null) | null;
  private readonly pressureWhileDisabledAlerter: Pick<
    WatchdogDisabledPressureAlerter,
    'evaluate'
  > | null;
  private readonly hostStaleDtachReaper: ResourceWatchdogServiceDeps['hostStaleDtachReaper'];
  private readonly sessionReaper: ResourceWatchdogServiceDeps['sessionReaper'];
  private readonly nowMs: () => number;
  private readonly nowIso: () => string;
  private readonly logger: Pick<typeof console, 'info' | 'warn'>;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private timeout: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private tickInFlight = false;
  private state: ResourceWatchdogPersistedState;
  private oomKillBaselineSource: 'persisted_state' | 'runtime_sample' | null;
  private lastSample: ResourceWatchdogSample | null = null;
  private samplingStartedAtMs: number | null = null;
  private lastDecision: ResourceWatchdogHealthSnapshot['lastDecision'] = null;
  private lastLaunch: ResourceWatchdogHealthSnapshot['lastLaunch'] = null;
  private lastSyncReclaim: ResourceWatchdogHealthSnapshot['lastSyncReclaim'] = null;
  // One owner outlives sampling ticks and stop/start. Only settlement releases
  // it; an expired throttle never permits a second concurrent launch.
  private launchInFlight: {
    startedAt: string;
    startedAtMs: number;
    kind: ResourceWatchdogSpawnKind;
    completion: Promise<void>;
  } | null = null;
  private persistenceHealth: ResourceWatchdogHealthSnapshot['persistence'];

  constructor(deps: ResourceWatchdogServiceDeps) {
    this.getConfig = deps.getConfig;
    this.sampler = deps.sampler;
    this.stateStore = deps.stateStore;
    this.auditSink = deps.auditSink;
    this.launchTask = deps.launchTask;
    this.readServerLogTail = deps.readServerLogTail ?? (() => null);
    this.readAuditTail = deps.readAuditTail ?? (() => null);
    this.getStaleDtachCount = deps.getStaleDtachCount ?? null;
    this.pressureWhileDisabledAlerter = deps.pressureWhileDisabledAlerter ?? null;
    this.hostStaleDtachReaper = deps.hostStaleDtachReaper;
    this.sessionReaper = deps.sessionReaper;
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
    this.logger = deps.logger ?? console;
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
    this.state = this.stateStore.load();
    this.oomKillBaselineSource = this.state.oomKillBaseline === null
      ? null
      : 'persisted_state';
    this.persistenceHealth = {
      status: 'unknown',
      reservationDurable: this.state.lastSpawnAt !== null,
      consecutiveFailures: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const config = this.getConfig();
    this.samplingStartedAtMs = config.enabled ? this.nowMs() : null;
    if (config.enabled) {
      this.logger.info(
        `[resource-watchdog] enabled (interval=${config.intervalMs}ms, ` +
          `swap≥${config.swapUsedPercentThreshold}%, mem≤${config.memAvailableMbFloor}MiB, ` +
          `proc≥${config.processCeiling}, orphans≥${config.orphanCeiling}, ` +
          `throttle=${config.throttleMs}ms, budget24h=${config.spawnBudget24h})`,
      );
    } else if (config.autoEnableOnPressure) {
      this.logger.info(
        '[resource-watchdog] disabled with auto-enable-on-pressure ' +
          '(set KOOKR_RESOURCE_WATCHDOG=1 for continuous monitoring; ' +
          'KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE=0 for page-only)',
      );
    } else {
      this.logger.info(
        '[resource-watchdog] disabled page-only ' +
          '(set KOOKR_RESOURCE_WATCHDOG=1 to enable; auto-enable is off)',
      );
    }
    this.tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timeout) {
      this.clearTimeoutFn(this.timeout);
      this.timeout = null;
    }
  }

  /**
   * Cheap in-memory snapshot for `/api/health`.
   *
   * Optional `staleDtachCount` folds the already-cached `staleProcesses.dtach`
   * gauge into `pressureWhileDisabled` (issue #2039) without a fresh `/proc`
   * scan on this path.
   */
  getHealthSnapshot(opts?: {
    staleDtachCount?: number | null;
  }): ResourceWatchdogHealthSnapshot {
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
    const pressure = evaluatePressureWhileDisabled({
      enabled: config.enabled,
      dtachCount: opts?.staleDtachCount ?? null,
      softBound: DEFAULT_DTACH_PRESSURE_SOFT_BOUND,
      autoEnableOnPressure: config.autoEnableOnPressure,
    });
    // When master is off, surface the real lastDecision (spawn / suppress /
    // auto_enable / disabled) so health never permanently lies as silent
    // `disabled` under pressure (issue #2354).
    const lastDecision = config.enabled
      ? this.lastDecision
      : (this.lastDecision ?? 'disabled');
    const oomKillBaseline = this.state.oomKillBaseline;
    const oomKillBaselineSampledAtMs = oomKillBaseline === null
      ? NaN
      : Date.parse(oomKillBaseline.sampledAt);
    const intervalMs = Math.max(1_000, config.intervalMs);
    // Retain the existing stale-warning grace independently of launch state.
    // Sampling now continues during launch; pending ownership is exposed below.
    const staleAfterMs = 3 * intervalMs + MAX_LAUNCH_TIMEOUT_SEC * 1_000;
    const lastSampleMs = this.lastSample ? Date.parse(this.lastSample.sampledAt) : NaN;
    const freshnessSinceMs = Number.isFinite(lastSampleMs)
      ? Math.max(lastSampleMs, this.samplingStartedAtMs ?? lastSampleMs)
      : this.samplingStartedAtMs;
    const ageMs = freshnessSinceMs === null ? null : Math.max(0, nowMs - freshnessSinceMs);
    return {
      enabled: config.enabled,
      lastSampleAt: this.lastSample?.sampledAt ?? null,
      sampleFreshness: config.enabled && ageMs !== null
        ? { ageMs, intervalMs, staleAfterMs, stale: ageMs > staleAfterMs }
        : null,
      lastSample: this.lastSample
        ? {
            swapUsedPercent: this.lastSample.swapUsedPercent,
            memAvailableMb: this.lastSample.memAvailableMb,
            oomKillTotal: this.lastSample.oomKillTotal,
            processCounts: this.lastSample.processCounts,
            orphanSessionCount: this.lastSample.orphanSessionCount,
            terminalLeakCount: this.lastSample.terminalLeakCount,
            ...(this.lastSample.rssCoverage ? { rssCoverage: { ...this.lastSample.rssCoverage } } : {}),
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
      lastDecision,
      lastLaunch: this.lastLaunch ? { ...this.lastLaunch } : null,
      lastSyncReclaim: this.lastSyncReclaim ? { ...this.lastSyncReclaim } : null,
      launchInFlight: this.launchInFlight
        ? {
            startedAt: this.launchInFlight.startedAt,
            ageMs: Math.max(0, nowMs - this.launchInFlight.startedAtMs),
            kind: this.launchInFlight.kind,
          }
        : null,
      pressureWhileDisabled: pressure.pressureWhileDisabled,
      pressureWhileDisabledReason: pressure.pressureWhileDisabledReason,
      autoEnableOnPressure: config.autoEnableOnPressure,
      oomKillBaseline: oomKillBaseline === null || this.oomKillBaselineSource === null
        ? null
        : {
            ...oomKillBaseline,
            ageMs: Number.isFinite(oomKillBaselineSampledAtMs)
              ? Math.max(0, nowMs - oomKillBaselineSampledAtMs)
              : null,
            source: this.oomKillBaselineSource,
          },
      persistence: { ...this.persistenceHealth },
    };
  }

  /** Evaluate once and await any launch. Test helper; does not require start(). */
  async runOnce(): Promise<void> {
    this.evaluateAndAct();
    await this.launchInFlight?.completion;
  }

  private tick(): void {
    if (!this.running) return;
    try {
      this.evaluateAndAct();
    } catch (err) {
      this.logger.warn(
        '[resource-watchdog] tick failed:',
        err instanceof Error ? err.message : err,
      );
    } finally {
      if (this.running) {
        const intervalMs = Math.max(1_000, this.getConfig().intervalMs);
        this.timeout = this.setTimeoutFn(() => {
          this.tick();
        }, intervalMs);
        (this.timeout as { unref?: () => void }).unref?.();
      }
    }
  }

  private evaluateAndAct(): void {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const config = this.getConfig();
      if (config.enabled) {
        this.samplingStartedAtMs ??= this.nowMs();
      } else {
        this.samplingStartedAtMs = null;
      }
      // Page when disabled-under-pressure stays true (issue #2078). Runs on
      // every tick — including the enabled path, which clears the episode.
      // Page-only alerter: never itself enables the actuator.
      this.evaluateDisabledPressureAlert(config);

      if (!config.enabled) {
        this.evaluateDisabledAutoEnable(config);
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
        previousOomKillTotal: this.state.oomKillBaseline?.total ?? null,
        state: this.state,
        config,
        nowMs: this.nowMs(),
      });
      this.lastDecision = decision.action;

      if (this.launchInFlight) {
        // A readable reset/equal counter is safe to save while launch is busy.
        // Keep positive deltas pending so a later investigation can handle them.
        const baseline = this.state.oomKillBaseline;
        const canAdvanceBaseline = sample.oomKillTotal !== null
          && (baseline === null || sample.oomKillTotal <= baseline.total);
        if (canAdvanceBaseline && sample.oomKillTotal !== null) {
          this.state = recordOomKillBaseline({
            state: this.state,
            total: sample.oomKillTotal,
            sampledAt: sample.sampledAt,
          });
          this.oomKillBaselineSource = 'runtime_sample';
        }
        if (decision.action === 'suppress_throttled') {
          this.handleSuppressThrottled(config, sample, decision);
        } else {
          if (decision.action === 'spawn') this.lastDecision = 'launch_in_flight';
          if (canAdvanceBaseline) this.persistState();
        }
        return;
      }

      if (decision.action === 'idle') {
        // An idle sample can advance independently. Spawn decisions instead
        // save the baseline and reservation together so a failed reservation
        // cannot consume a one-shot OOM delta.
        if (sample.oomKillTotal !== null) {
          this.state = recordOomKillBaseline({
            state: this.state,
            total: sample.oomKillTotal,
            sampledAt: sample.sampledAt,
          });
          this.oomKillBaselineSource = 'runtime_sample';
          this.persistState();
        }
        return;
      }

      if (decision.action === 'suppress_throttled') {
        // Keep the old baseline while a reservation has no known task. This
        // preserves an OOM delta through recovery until the normal throttle
        // allows the deferred launch.
        const unresolvedReservation = this.state.lastSpawnAt !== null
          && this.state.lastSpawnTaskId === null;
        if (sample.oomKillTotal !== null && !unresolvedReservation) {
          this.state = recordOomKillBaseline({
            state: this.state,
            total: sample.oomKillTotal,
            sampledAt: sample.sampledAt,
          });
          this.oomKillBaselineSource = 'runtime_sample';
        }
        this.handleSuppressThrottled(config, sample, decision);
        return;
      }

      // action === 'spawn'
      this.startLaunch(config, sample, decision, { autoEnabled: false });
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Issue #2354: when the master switch is off but soft-bound pressure is
   * already tripping, auto-enable one rate-limited investigation cycle
   * instead of permanent silent `lastDecision: disabled`.
   */
  private evaluateDisabledAutoEnable(
    config: ResourceWatchdogConfig,
  ): void {
    const dtachCount = this.getStaleDtachCount?.() ?? null;
    const decision = evaluateDisabledPressureAutoEnable({
      enabled: false,
      autoEnableOnPressure: config.autoEnableOnPressure,
      dtachCount,
      softBound: DEFAULT_DTACH_PRESSURE_SOFT_BOUND,
      state: this.state,
      throttleMs: config.throttleMs,
      spawnBudget24h: config.spawnBudget24h,
      spawnBudgetWindowMs: config.spawnBudgetWindowMs,
      nowMs: this.nowMs(),
    });

    if (decision.action === 'stay_disabled') {
      this.lastDecision = 'disabled';
      return;
    }

    const sample = this.syntheticPressureSample(dtachCount ?? 0);

    if (decision.action === 'suppress_throttled') {
      this.lastDecision = 'suppress_throttled';
      this.handleSuppressThrottled(config, sample, {
        action: 'suppress_throttled',
        sample,
        triggers: decision.triggers,
        throttleRemainingMs: decision.throttleRemainingMs,
        lastSpawnAt: decision.lastSpawnAt,
      });
      return;
    }

    if (this.launchInFlight) {
      this.lastDecision = 'launch_in_flight';
      return;
    }

    // action === 'spawn' — reclaim-before-spawn (issue #3247) lives in
    // handleSpawn; auto_enable audit is recorded only if spawn still proceeds.
    this.lastDecision = 'spawn';
    this.startLaunch(
      config,
      sample,
      {
        action: 'spawn',
        sample,
        triggers: decision.triggers,
        kind: decision.kind,
        spawnsInWindow: decision.spawnsInWindow,
      },
      { autoEnabled: true },
    );
  }

  /** Minimal sample for auto-enable audits when the full sampler is off. */
  private syntheticPressureSample(dtachCount: number): ResourceWatchdogSample {
    const sample: ResourceWatchdogSample = {
      sampledAt: this.nowIso(),
      swapUsedPercent: null,
      memAvailableMb: null,
      oomKillTotal: null,
      processCounts: { claude: 0, grok: 0, codex: 0, dtach: dtachCount },
      orphanSessionCount: 0,
      terminalLeakCount: 0,
      topConsumers: [],
    };
    this.lastSample = sample;
    return sample;
  }

  private handleSuppressThrottled(
    config: ResourceWatchdogConfig,
    sample: ResourceWatchdogSample,
    decision: Extract<ResourceWatchdogDecision, { action: 'suppress_throttled' }>,
  ): void {
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
  }

  private startLaunch(
    config: ResourceWatchdogConfig,
    sample: ResourceWatchdogSample,
    decision: Extract<ResourceWatchdogDecision, { action: 'spawn' }>,
    opts: { autoEnabled: boolean },
  ): void {
    if (this.launchInFlight) {
      this.lastDecision = 'launch_in_flight';
      return;
    }
    const owner = {
      startedAt: this.nowIso(),
      startedAtMs: this.nowMs(),
      kind: decision.kind,
      completion: Promise.resolve(),
    };
    this.launchInFlight = owner;
    // Reserve durably and begin launch in this tick. The timer only waits for
    // sampling; completion patches the current state without replacing newer
    // samples, OOM baselines, or trigger history.
    owner.completion = this.handleSpawn(config, sample, decision, opts)
      .catch((err: unknown) => {
        this.logger.warn(
          '[resource-watchdog] launch handling failed:',
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => {
        this.launchInFlight = null;
      });
  }

  private async handleSpawn(
    config: ResourceWatchdogConfig,
    sample: ResourceWatchdogSample,
    decision: Extract<ResourceWatchdogDecision, { action: 'spawn' }>,
    opts: { autoEnabled: boolean },
  ): Promise<void> {
    // Only await when reaper hooks will actually run. A bare `await` of a
    // sync no-op still yields a microtask and would delay the throttle
    // reservation past the first fake-timer tick.
    if (this.shouldRunSyncReclaim(decision.triggers)) {
      const afterReclaim = await this.runSyncReclaim(config, sample, decision, opts);
      if (afterReclaim.skipSpawn) return;
      sample = afterReclaim.sample;
      decision = afterReclaim.decision;
    } else if (this.isReclaimableTrigger(decision.triggers)) {
      this.lastSyncReclaim = {
        at: this.nowIso(),
        ran: false,
        spawnSkippedBecausePressureCleared: false,
      };
    }

    if (opts.autoEnabled) {
      this.auditSink.append(buildAuditRecord({
        action: 'auto_enable',
        timestamp: this.nowIso(),
        sample,
        triggers: decision.triggers,
        kind: decision.kind,
        spawnsInWindow: decision.spawnsInWindow,
      }));
      this.logger.warn(
        `[resource-watchdog] auto-enable under pressure ` +
          `(dtach=${sample.processCounts.dtach} ≥ soft bound ${DEFAULT_DTACH_PRESSURE_SOFT_BOUND}); ` +
          `attempting ${decision.kind} spawn`,
      );
    }

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
    const previousOomKillBaseline = this.state.oomKillBaseline;
    const previousOomKillBaselineSource = this.oomKillBaselineSource;
    const previousLastMetaReflectionAt = this.state.lastMetaReflectionAt;
    if (sample.oomKillTotal !== null) {
      this.state = recordOomKillBaseline({
        state: this.state,
        total: sample.oomKillTotal,
        sampledAt: sample.sampledAt,
      });
      this.oomKillBaselineSource = 'runtime_sample';
    }
    this.state = recordSpawn({
      state: this.state,
      nowIso,
      nowMs,
      kind: decision.kind,
      taskId: null,
      triggerReasons: decision.triggers.map((t) => t.reason),
      retainMs,
    });
    this.persistenceHealth = {
      ...this.persistenceHealth,
      reservationDurable: false,
    };
    if (!this.persistState()) {
      // Keep the conservative throttle reservation in memory, but do not let
      // a failed write consume a one-shot OOM delta or claim that a meta task
      // ran. A later durable save retains the old baseline, so the trigger is
      // still present when the throttle reopens (including after restart).
      this.state = {
        ...this.state,
        oomKillBaseline: previousOomKillBaseline,
        lastMetaReflectionAt: previousLastMetaReflectionAt,
      };
      this.oomKillBaselineSource = previousOomKillBaselineSource;
      this.lastDecision = 'spawn_persist_failed';
      const error = this.persistenceHealth.lastError ?? 'unknown persistence failure';
      this.auditSink.append(buildAuditRecord({
        action: 'spawn_persist_failed',
        timestamp: this.nowIso(),
        sample,
        triggers: decision.triggers,
        kind: decision.kind,
        error,
        spawnsInWindow: decision.spawnsInWindow,
      }));
      this.logger.warn(
        `[resource-watchdog] spawn refused because throttle reservation was not durable: ${error}`,
      );
      return;
    }

    const prompt = buildResourceWatchdogPrompt({
      kind: decision.kind,
      sample,
      triggers: decision.triggers,
      spawnsInWindow: decision.spawnsInWindow,
      spawnBudget24h: config.spawnBudget24h,
      serverLogTail: this.readServerLogTail() ?? undefined,
      recentAuditTail: this.readAuditTail() ?? undefined,
    });

    let failedTaskId: string | null = null;
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
      const taskId = result.task.id;
      if (isTerminatedAtLaunch(result.task)) {
        failedTaskId = taskId;
        const reason = result.task.disposition?.reason ?? 'launch_error';
        const detail = result.task.disposition?.detail?.trim();
        throw new Error(`task terminated during launch (${reason})${detail ? `: ${detail}` : ''}`);
      }
      this.state = {
        ...this.state,
        lastSpawnTaskId: taskId,
      };
      this.persistState();
      this.lastLaunch = {
        status: result.queued ? 'queued' : 'spawned',
        at: this.nowIso(),
        taskId,
        error: null,
      };
      this.logger.warn(
        `[resource-watchdog] spawned ${decision.kind} task ${taskId}` +
          (result.queued ? ' (queued)' : '') +
          (opts.autoEnabled ? ' (auto-enable)' : '') +
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
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = (rawMessage || 'unknown launch failure').slice(0, MAX_LAUNCH_ERROR_CHARS);
      this.lastDecision = 'spawn_failed';
      this.lastLaunch = {
        status: 'failed',
        at: this.nowIso(),
        taskId: failedTaskId,
        error: message,
      };
      this.logger.warn(`[resource-watchdog] spawn failed: ${message}`);
      // Throttle already armed above — do not clear it. A host under
      // pressure that rejects launches must quiet for throttleMs, not retry
      // every sample interval. Keep failed task IDs in health diagnostics and
      // the audit trail; never store them as the last accepted launch.
      this.auditSink.append(buildAuditRecord({
        action: 'spawn_failed',
        timestamp: this.nowIso(),
        sample,
        triggers: decision.triggers,
        kind: decision.kind,
        ...(failedTaskId ? { taskId: failedTaskId } : {}),
        error: message,
        spawnsInWindow: decision.spawnsInWindow,
      }));
    }
  }

  /**
   * Issue #3247: when spawn triggers are leaks the existing reapers already
   * know how to shrink, run one bounded sweep of each before launching another
   * agent. Skip the spawn when that pass drops the host back under threshold.
   */
  private isReclaimableTrigger(
    triggers: readonly { reason: string }[],
  ): boolean {
    return triggers.some((trigger) =>
      (RESOURCE_WATCHDOG_SYNC_RECLAIM_REASONS as readonly string[]).includes(trigger.reason),
    );
  }

  private shouldRunSyncReclaim(
    triggers: readonly { reason: string }[],
  ): boolean {
    return this.isReclaimableTrigger(triggers)
      && (this.hostStaleDtachReaper != null || this.sessionReaper != null);
  }

  private async runSyncReclaim(
    config: ResourceWatchdogConfig,
    sample: ResourceWatchdogSample,
    decision: Extract<ResourceWatchdogDecision, { action: 'spawn' }>,
    opts: { autoEnabled: boolean },
  ): Promise<{
    skipSpawn: boolean;
    sample: ResourceWatchdogSample;
    decision: Extract<ResourceWatchdogDecision, { action: 'spawn' }>;
  }> {
    const dtachResult = await this.runReaperSweep(this.hostStaleDtachReaper);
    const sessionResult = await this.runReaperSweep(this.sessionReaper);
    const after = this.recheckPressureAfterReclaim(
      config,
      sample,
      decision,
      opts,
      dtachResult,
      sessionResult,
    );
    this.lastSyncReclaim = {
      at: this.nowIso(),
      ran: true,
      spawnSkippedBecausePressureCleared: after.skipBecausePressureCleared,
    };
    if (after.skipSpawn) {
      this.lastDecision = after.skipBecausePressureCleared ? 'idle' : 'suppress_throttled';
      this.logger.warn(
        after.skipBecausePressureCleared
          ? `[resource-watchdog] sync reclaim cleared pressure; skipping ${decision.kind} spawn`
          : `[resource-watchdog] sync reclaim ran; spawn still suppressed`,
      );
      return { skipSpawn: true, sample: after.sample, decision };
    }
    return { skipSpawn: false, sample: after.sample, decision: after.decision };
  }

  private recheckPressureAfterReclaim(
    config: ResourceWatchdogConfig,
    sample: ResourceWatchdogSample,
    decision: Extract<ResourceWatchdogDecision, { action: 'spawn' }>,
    opts: { autoEnabled: boolean },
    dtachResult: unknown,
    sessionResult: unknown,
  ): {
    skipSpawn: boolean;
    skipBecausePressureCleared: boolean;
    sample: ResourceWatchdogSample;
    decision: Extract<ResourceWatchdogDecision, { action: 'spawn' }>;
  } {
    if (opts.autoEnabled || !config.enabled) {
      const remainingDtach =
        remainingDtachAfterSweep(dtachResult) ?? this.getStaleDtachCount?.() ?? null;
      const next = evaluateDisabledPressureAutoEnable({
        enabled: false,
        autoEnableOnPressure: config.autoEnableOnPressure,
        dtachCount: remainingDtach,
        softBound: DEFAULT_DTACH_PRESSURE_SOFT_BOUND,
        state: this.state,
        throttleMs: config.throttleMs,
        spawnBudget24h: config.spawnBudget24h,
        spawnBudgetWindowMs: config.spawnBudgetWindowMs,
        nowMs: this.nowMs(),
      });
      const updatedSample = remainingDtach !== null
        ? this.syntheticPressureSample(remainingDtach)
        : sample;
      if (next.action === 'stay_disabled') {
        return {
          skipSpawn: true,
          skipBecausePressureCleared: true,
          sample: updatedSample,
          decision,
        };
      }
      if (next.action === 'suppress_throttled') {
        return {
          skipSpawn: true,
          skipBecausePressureCleared: false,
          sample: updatedSample,
          decision,
        };
      }
      return {
        skipSpawn: false,
        skipBecausePressureCleared: false,
        sample: updatedSample,
        decision: {
          action: 'spawn',
          sample: updatedSample,
          triggers: next.triggers,
          kind: next.kind,
          spawnsInWindow: next.spawnsInWindow,
        },
      };
    }

    let fresh: ResourceWatchdogSample;
    try {
      fresh = this.sampler.sample();
    } catch (err) {
      this.logger.warn(
        '[resource-watchdog] post-reclaim sample failed:',
        err instanceof Error ? err.message : err,
      );
      return {
        skipSpawn: false,
        skipBecausePressureCleared: false,
        sample,
        decision,
      };
    }
    const remainingOrphans = remainingOrphansAfterSweep(sessionResult);
    if (remainingOrphans !== null) {
      fresh = { ...fresh, orphanSessionCount: remainingOrphans };
    }
    this.lastSample = fresh;
    const next = evaluateResourceWatchdog({
      sample: fresh,
      previousOomKillTotal: this.state.oomKillBaseline?.total ?? null,
      state: this.state,
      config,
      nowMs: this.nowMs(),
    });
    if (next.action === 'idle') {
      return {
        skipSpawn: true,
        skipBecausePressureCleared: true,
        sample: fresh,
        decision,
      };
    }
    if (next.action === 'suppress_throttled') {
      return {
        skipSpawn: true,
        skipBecausePressureCleared: false,
        sample: fresh,
        decision,
      };
    }
    return {
      skipSpawn: false,
      skipBecausePressureCleared: false,
      sample: fresh,
      decision: next,
    };
  }

  private async runReaperSweep(
    reaper: { runSweep: () => Promise<unknown> | unknown } | undefined,
  ): Promise<unknown> {
    if (!reaper) return undefined;
    try {
      return await reaper.runSweep();
    } catch (err) {
      this.logger.warn(
        '[resource-watchdog] sync reclaim sweep failed:',
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
  }

  private persistState(): boolean {
    const attemptedAt = this.nowIso();
    try {
      this.stateStore.save(this.state);
      this.persistenceHealth = {
        ...this.persistenceHealth,
        status: 'ok',
        reservationDurable: this.state.lastSpawnAt !== null,
        consecutiveFailures: 0,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: attemptedAt,
        lastError: null,
      };
      return true;
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = (rawMessage || 'unknown persistence failure')
        .slice(0, MAX_PERSISTENCE_ERROR_CHARS);
      this.persistenceHealth = {
        ...this.persistenceHealth,
        status: 'error',
        consecutiveFailures: Math.min(
          Number.MAX_SAFE_INTEGER,
          this.persistenceHealth.consecutiveFailures + 1,
        ),
        lastAttemptAt: attemptedAt,
        lastFailureAt: attemptedAt,
        lastError: message,
      };
      this.logger.warn(
        '[resource-watchdog] failed to persist state:',
        message,
      );
      return false;
    }
  }

  /**
   * Issue #2078: page Discord when pressureWhileDisabled stays true long
   * enough. Skips the dtach gauge read when the actuator is on (pressure is
   * always false then). Must never throw into the tick.
   */
  private evaluateDisabledPressureAlert(config: ResourceWatchdogConfig): void {
    if (!this.pressureWhileDisabledAlerter) return;
    try {
      // Only pay for the gauge when the actuator is off; when enabled the
      // helper returns false without consulting dtachCount.
      const dtachCount = config.enabled
        ? null
        : (this.getStaleDtachCount?.() ?? null);
      const pressure = evaluatePressureWhileDisabled({
        enabled: config.enabled,
        dtachCount,
        softBound: DEFAULT_DTACH_PRESSURE_SOFT_BOUND,
        autoEnableOnPressure: config.autoEnableOnPressure,
      });
      this.pressureWhileDisabledAlerter.evaluate({
        pressureWhileDisabled: pressure.pressureWhileDisabled,
        reason: pressure.pressureWhileDisabledReason,
        dtachCount,
      });
    } catch (err) {
      this.logger.warn(
        '[resource-watchdog] disabled-pressure alerter failed:',
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

/** Pre-kill dtach master count minus successful reaps from one host-stale sweep. */
function remainingDtachAfterSweep(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null;
  const rec = result as { plan?: { dtachCount?: unknown }; reaped?: unknown };
  if (typeof rec.plan?.dtachCount !== 'number' || !Array.isArray(rec.reaped)) return null;
  return Math.max(0, rec.plan.dtachCount - rec.reaped.length);
}

/** Unowned sessions still live after one session-reaper sweep. */
function remainingOrphansAfterSweep(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null;
  const rec = result as { orphanCount?: unknown; reaped?: unknown };
  if (typeof rec.orphanCount !== 'number' || !Array.isArray(rec.reaped)) return null;
  let reapedOrphans = 0;
  for (const entry of rec.reaped) {
    if (entry && typeof entry === 'object' && (entry as { kind?: unknown }).kind === 'unowned') {
      reapedOrphans += 1;
    }
  }
  return Math.max(0, rec.orphanCount - reapedOrphans);
}

export function defaultResourceWatchdogHealthSnapshot(
  enabled = false,
  autoEnableOnPressure = true,
): ResourceWatchdogHealthSnapshot {
  return {
    enabled,
    lastSampleAt: null,
    sampleFreshness: null,
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
    lastLaunch: null,
    lastSyncReclaim: null,
    launchInFlight: null,
    pressureWhileDisabled: false,
    pressureWhileDisabledReason: null,
    autoEnableOnPressure,
    oomKillBaseline: null,
    persistence: {
      status: 'unknown',
      reservationDurable: false,
      consecutiveFailures: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
    },
  };
}

// Re-export for callers that only need the empty state factory.
export { emptyResourceWatchdogState };
