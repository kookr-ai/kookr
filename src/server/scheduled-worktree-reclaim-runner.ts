/**
 * Cron-driven trigger for the scheduled worktree reclaim (issue #1578).
 *
 * A minimal, self-contained scheduler — deliberately NOT routed through the
 * playbook-launching {@link ScheduleRunner}, because the reclaim is an internal
 * server job, not a task launch. It uses the shared cron surface
 * (`src/core/cron.ts`) to decide when a run is due and calls
 * {@link runScheduledWorktreeReclaim}.
 *
 * Disabled by default: unless `KOOKR_WORKTREE_RECLAIM_CRON` is set to a valid
 * cron expression, {@link ScheduledWorktreeReclaimRunner.start} is a no-op, so
 * existing servers see zero behavior change.
 */

import { nextRun, isValidCron, describeCron } from '../core/cron.js';
import {
  runScheduledWorktreeReclaim,
  type ScheduledReclaimDeps,
  type ScheduledReclaimResult,
} from './use-cases/scheduled-worktree-reclaim.js';

const TICK_INTERVAL_MS = 60_000;

export interface ReclaimScheduleConfig {
  enabled: boolean;
  cron: string;
  /** When true, runs only classify + report; nothing is removed. */
  dryRun: boolean;
}

/**
 * Resolve the reclaim schedule from the environment. Enabled only when
 * `KOOKR_WORKTREE_RECLAIM_CRON` holds a valid 5-field cron expression.
 *
 * `KOOKR_WORKTREE_RECLAIM_DRY_RUN` forces dry-run when set to a truthy value
 * (`1`/`true`/`yes`, case-insensitive). Default is a LIVE run so the schedule
 * actually reclaims; operators opt into preview mode explicitly.
 */
export function resolveReclaimScheduleConfig(
  env: NodeJS.ProcessEnv = process.env,
): ReclaimScheduleConfig {
  const cron = env.KOOKR_WORKTREE_RECLAIM_CRON?.trim();
  if (!cron || !isValidCron(cron)) {
    return { enabled: false, cron: cron ?? '', dryRun: false };
  }
  return { enabled: true, cron, dryRun: isTruthyEnv(env.KOOKR_WORKTREE_RECLAIM_DRY_RUN) };
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export interface ScheduledWorktreeReclaimRunnerDeps extends ScheduledReclaimDeps {
  config: ReclaimScheduleConfig;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Injectable tick interval (tests). */
  tickIntervalMs?: number;
}

export class ScheduledWorktreeReclaimRunner {
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private nextDue: Date | null = null;
  private running = false;
  private pending: Promise<void> | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: ScheduledWorktreeReclaimRunnerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  start(): void {
    if (!this.deps.config.enabled) {
      return;
    }
    if (this.tickInterval) return;
    this.nextDue = nextRun(this.deps.config.cron, this.now());
    const interval = this.deps.tickIntervalMs ?? TICK_INTERVAL_MS;
    this.tickInterval = setInterval(() => {
      void this.tick();
    }, interval);
    // Node keeps the event loop alive for interval timers; unref so the
    // scheduler never blocks a clean shutdown.
    this.tickInterval.unref?.();
    this.deps.logger?.info('worktree_reclaim_scheduled', {
      cron: this.deps.config.cron,
      description: describeCron(this.deps.config.cron),
      dryRun: this.deps.config.dryRun,
      nextRunAt: this.nextDue?.toISOString(),
    });
  }

  async stop(): Promise<void> {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.pending) {
      await this.pending.catch(() => undefined);
    }
  }

  /**
   * One scheduler tick. Fires a reclaim run when the cron time has passed and
   * no run is already in flight, then recomputes the next due time. Exposed for
   * deterministic tests (call directly instead of waiting on the timer).
   */
  async tick(): Promise<ScheduledReclaimResult | null> {
    if (!this.deps.config.enabled) return null;
    if (this.running) return null;
    const now = this.now();
    if (!this.nextDue || now < this.nextDue) return null;

    this.running = true;
    let result: ScheduledReclaimResult | null = null;
    const run = (async () => {
      try {
        result = await runScheduledWorktreeReclaim(this.deps, { dryRun: this.deps.config.dryRun });
      } catch (err) {
        this.deps.logger?.warn('worktree_reclaim_tick_error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    this.pending = run;
    try {
      await run;
    } finally {
      this.running = false;
      this.pending = null;
      // Recompute strictly after `now` so a run never immediately re-fires.
      this.nextDue = nextRun(this.deps.config.cron, this.now());
    }
    return result;
  }

  /** Next scheduled run time, or null when disabled / not started. */
  getNextRunAt(): Date | null {
    return this.nextDue;
  }
}
