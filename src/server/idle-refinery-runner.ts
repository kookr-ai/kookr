import { decideIdleRefinerySpawn, type IdleRefineryReason } from '../core/idle-refinery.js';
import type { CapacityLedger } from '../core/capacity-ledger.js';
import {
  EMPTY_PAUSED_PROJECT_IDS,
  mayAutonomousActuate,
} from '../core/automation-kill-switch.js';
import type { LaunchOpts, LaunchResult, LaunchTaskServerOptions } from './launch-service.js';
import type { ResolvedRefineryLaunch } from './umbrella-decompose-launch.js';

/**
 * Idle-slot idea refinery runner (issue #2144).
 *
 * Owns a low-frequency timer that, when the harness is idle (free slots + empty
 * pending queue) and no refinery task is already in flight, spawns exactly ONE
 * bounded umbrella-decomposition task. The task decomposes a single open,
 * human-sanctioned umbrella issue into sized leaf issues that flow through the
 * normal vetting path — it never auto-executes them.
 *
 * The runner is deliberately thin: the go/no-go logic lives in the pure
 * {@link decideIdleRefinerySpawn} core; the playbook resolution lives in
 * {@link resolveUmbrellaDecomposeLaunch}. This class only wires them to a timer,
 * the launcher, and the durable-enough last-spawn bookkeeping.
 *
 * Safety posture (a NEW autonomous auto-spawn path):
 *  - `launchSource: 'idle-refinery'` routes the launch through the per-source
 *    spawn budget (NOT exempt — unlike schedules) so it is `spawnBudget`-capped
 *    as the issue requires, and marks it autonomous for the automation
 *    kill-switch (see {@link ../core/automation-kill-switch}).
 *  - The runner ALSO short-circuits on drain (`isAccepting`) and SAFE MODE
 *    (`isAutomationEnabled`) before ever calling the launcher, so a suppressed
 *    node spends no budget and logs no spurious spawn attempt.
 *  - Single-flight + cooldown bound the spawn rate independently of the budget.
 */

export interface IdleRefineryConfig {
  enabled: boolean;
  /** Config threshold `N`: minimum free slots required to fire. */
  minFreeSlots: number;
  /** Minimum gap between two refinery spawns, in ms. */
  cooldownMs: number;
}

export interface IdleRefineryRunnerDeps {
  /** Live config snapshot, read once per tick so settings changes apply live. */
  getConfig: () => IdleRefineryConfig;
  /** Same watchdog-aware ledger builder /api/health and the 429 bodies use. */
  getCapacityLedger: () => CapacityLedger;
  /** Count of refinery tasks currently non-terminal (single-flight guard). */
  countActiveRefineryTasks: () => number;
  /** Resolve the umbrella-decompose playbook into launch inputs (or null). */
  resolveLaunch: () => Promise<ResolvedRefineryLaunch | null>;
  /** The normal launch path (`launchTask` bound to launch-service deps). */
  launcher: (opts: LaunchOpts, serverOpts?: LaunchTaskServerOptions) => Promise<LaunchResult>;
  /** Operator drain gate (issue #659): suppress firing while draining. */
  isAccepting?: () => boolean;
  /** Automation kill-switch (issue #1710): suppress firing in SAFE MODE. */
  isAutomationEnabled?: () => boolean;
  /** Live paused-id set. Absent means no project is paused. */
  getPausedProjectIds?: () => ReadonlySet<string>;
  /**
   * Project id the idle-refinery is gated on (the server checkout's remote —
   * typically Kookr). Pausing Lucy does not stop the refinery.
   */
  getAutomationProjectId?: () => string | Promise<string>;
  /** Time source (epoch ms) — injected for deterministic tests. */
  now?: () => number;
  /** Timer period. Defaults to {@link DEFAULT_IDLE_REFINERY_TICK_MS}. */
  tickIntervalMs?: number;
  /** Notified after a successful spawn (e.g. broadcast a snapshot). Must not throw. */
  onSpawn?: (taskId: string) => void;
}

/**
 * Default tick period (60s). The refinery reacts to a standing idle posture, not
 * an urgent event, so a coarse tick is deliberate — it keeps the sweep cheap and
 * lets a genuinely transient idle blip pass without spawning.
 */
export const DEFAULT_IDLE_REFINERY_TICK_MS = 60_000;

export class IdleRefineryRunner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = false;
  /**
   * Last successful-spawn timestamp for the cooldown. In-memory by design: a
   * lost timestamp on restart risks at most one extra spawn, still bounded by
   * the single-flight guard and the per-source spawn budget.
   */
  private lastSpawnAt: number | null = null;
  /** One-shot latch so an unresolvable playbook is logged once, not every tick. */
  private warnedUnresolvable = false;
  private readonly deps: IdleRefineryRunnerDeps;

  constructor(deps: IdleRefineryRunnerDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  start(): void {
    if (this.interval) return;
    const period = this.deps.tickIntervalMs ?? DEFAULT_IDLE_REFINERY_TICK_MS;
    this.interval = setInterval(() => {
      void this.tick();
    }, period);
    // Node timers keep the event loop alive; the refinery must never do that on
    // its own (it would block a clean shutdown), so unref where available.
    this.interval.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Evaluate the idle posture and, if warranted, spawn one refinery task.
   *
   * Exposed (not private) so tests can drive one tick deterministically without
   * a real timer. Re-entrancy guarded: a slow launch never overlaps the next
   * tick. Never throws — a launch failure is logged and swallowed so the timer
   * survives.
   */
  async tick(): Promise<{ spawned: boolean; reason: IdleRefineryReason }> {
    if (this.stopped) return { spawned: false, reason: 'disabled' };
    if (this.ticking) return { spawned: false, reason: 'refinery_in_flight' };
    this.ticking = true;
    try {
      const config = this.deps.getConfig();
      if (!config.enabled) return { spawned: false, reason: 'disabled' };

      // Operator suppressions short-circuit BEFORE the decision so a drained /
      // SAFE-MODE node never spends spawn budget or logs a spurious attempt.
      // Reported as 'disabled' — from the refinery's view it is switched off.
      if (this.deps.isAccepting && !this.deps.isAccepting()) {
        return { spawned: false, reason: 'disabled' };
      }
      if (this.deps.isAutomationEnabled && !this.deps.isAutomationEnabled()) {
        return { spawned: false, reason: 'disabled' };
      }

      const projectId = this.deps.getAutomationProjectId
        ? await this.deps.getAutomationProjectId()
        : undefined;
      const actuation = mayAutonomousActuate({
        source: 'idle-refinery',
        projectId,
        globalEnabled: true,
        pausedProjectIds: this.deps.getPausedProjectIds?.() ?? EMPTY_PAUSED_PROJECT_IDS,
      });
      if (actuation === 'project_paused') {
        return { spawned: false, reason: 'disabled' };
      }

      const ledger = this.deps.getCapacityLedger();
      // The refinery is a general (non-privileged) launch source, so measure
      // headroom the way its own launch is admitted: when the operator reserves
      // slots for privileged sources (`reservedActiveSlots`), `freeForGeneralSources`
      // is lower than the full-pool `free`, and spawning on the full pool would
      // only pend behind the reservation. Take the conservative minimum so the
      // gate never reads more idle than the launch path will actually accept.
      const effectiveFree = Math.min(ledger.free, ledger.freeForGeneralSources ?? ledger.free);
      const decision = decideIdleRefinerySpawn({
        enabled: config.enabled,
        ledger: { free: effectiveFree, pendingQueueDepth: ledger.pendingQueueDepth },
        minFreeSlots: config.minFreeSlots,
        activeRefineryCount: this.deps.countActiveRefineryTasks(),
        lastSpawnAt: this.lastSpawnAt,
        cooldownMs: config.cooldownMs,
        now: this.now(),
      });

      if (!decision.spawn) return { spawned: false, reason: decision.reason };

      const launch = await this.deps.resolveLaunch();
      if (!launch) {
        if (!this.warnedUnresolvable) {
          console.warn('[idle-refinery] umbrella-decompose playbook is not resolvable in the plugin tier; refinery inert');
          this.warnedUnresolvable = true;
        }
        return { spawned: false, reason: 'disabled' };
      }
      this.warnedUnresolvable = false;

      const result = await this.deps.launcher({
        prompt: launch.prompt,
        cwd: launch.cwd,
        ...(launch.criteria ? { criteria: launch.criteria } : {}),
        ...(launch.name ? { name: launch.name } : {}),
        playbookId: launch.playbookId,
        playbookSource: launch.playbookSource,
        playbookParameterValues: launch.playbookParameterValues,
        // NOT spawn-budget-exempt (unlike 'schedule'): this is the cap the issue
        // asks for. Also marks the launch autonomous for the kill-switch.
        launchSource: 'idle-refinery',
        // Identical prompt each fire — the single-flight guard already prevents
        // stacking, so opt out of dedup to keep intent explicit (mirrors schedules).
        disableDedup: true,
      }, projectId ? { automationProjectId: projectId } : undefined);

      // Record the spawn time only after the launch actually created a task, so
      // a rejected launch (budget/drain/kill-switch) does not start the cooldown.
      this.lastSpawnAt = this.now();
      console.log(
        `[idle-refinery] Spawned umbrella-decompose task ${result.task.id}`
        + ` (free=${effectiveFree}, pendingQueueDepth=${ledger.pendingQueueDepth})`,
      );
      try {
        this.deps.onSpawn?.(result.task.id);
      } catch (err) {
        console.warn('[idle-refinery] onSpawn hook threw:', err);
      }
      return { spawned: true, reason: 'spawn' };
    } catch (err) {
      // A launch can be legitimately refused (host-load admission, the per-source
      // spawn budget, a drain/kill-switch race between our gate and the launcher).
      // Engage the cooldown so a persistent refusal is paced to the cooldown
      // rather than retried — and re-logged — every tick. Logged at warn: this is
      // expected backpressure, not a crash. Rare genuine bugs are paced the same
      // way (safe) and still surface in the log.
      this.lastSpawnAt = this.now();
      console.warn('[idle-refinery] launch attempt refused; cooling down before retry:', err);
      return { spawned: false, reason: 'disabled' };
    } finally {
      this.ticking = false;
    }
  }
}
