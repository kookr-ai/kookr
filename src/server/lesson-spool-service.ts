/**
 * Background service: probe KB health, drain the lesson-write spool on
 * recovery, and fire a prolonged-degradation operational alert (issue #1519).
 *
 * Additive — when KB is healthy and the spool is empty the tick is cheap
 * (one doctor/search preflight + empty spool read).
 */

import type { ServerMessage } from '../shared/contracts/messages.js';
import type { AnomalySeverity } from '../shared/contracts/anomalies.js';
import {
  applyDegradationProbe,
  DEFAULT_DEGRADED_ALERT_THRESHOLD_MS,
  defaultSpoolDir,
  drainLessonSpool,
  readPendingLessons,
  readSpoolState,
  writeSpoolState,
  type LessonSpoolState,
} from '../core/lesson-write-spool.js';
import { createKbRememberWriteFn } from '../core/lesson-write-runner.js';
import { runLaunchDependencyPreflights } from './launch-dependency-runner.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/** Default probe interval: 5 minutes. */
export const DEFAULT_LESSON_SPOOL_PROBE_INTERVAL_MS = 5 * 60 * 1000;

export interface LessonSpoolServiceOptions {
  spoolDir?: string;
  intervalMs?: number;
  thresholdMs?: number;
  /** Inject preflight (tests). Default: real kb preflight. */
  probeKb?: () => Promise<'healthy' | 'degraded'>;
  /** Inject drain write fn (tests). */
  writeFn?: ReturnType<typeof createKbRememberWriteFn>;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Broadcast operational alerts (dashboard / webhook chain). */
  emitAlert?: (message: Extract<ServerMessage, { type: 'alert' }>) => void;
}

export interface LessonSpoolTickResult {
  status: 'healthy' | 'degraded';
  drained?: {
    attempted: number;
    written: number;
    failed: number;
    deadLetteredCount: number;
    remaining: number;
  };
  alertFired: boolean;
  state: LessonSpoolState;
}

export class LessonSpoolService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly spoolDir: string;
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly probeKb: () => Promise<'healthy' | 'degraded'>;
  private readonly writeFn: ReturnType<typeof createKbRememberWriteFn>;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  private readonly emitAlert?: LessonSpoolServiceOptions['emitAlert'];

  constructor(opts: LessonSpoolServiceOptions = {}) {
    this.spoolDir = opts.spoolDir ?? defaultSpoolDir();
    this.intervalMs = opts.intervalMs ?? DEFAULT_LESSON_SPOOL_PROBE_INTERVAL_MS;
    this.thresholdMs = opts.thresholdMs ?? DEFAULT_DEGRADED_ALERT_THRESHOLD_MS;
    this.probeKb = opts.probeKb ?? defaultKbProbe;
    this.writeFn = opts.writeFn ?? createKbRememberWriteFn();
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((msg) => console.log(msg));
    this.emitAlert = opts.emitAlert;
  }

  start(): void {
    if (this.timer) return;
    this.log(
      `[lesson-spool] started (interval=${this.intervalMs}ms, `
        + `alertThreshold=${this.thresholdMs}ms, dir=${this.spoolDir})`,
    );
    // Kick once shortly after boot so a pre-existing spool drains without
    // waiting a full interval — deferred so startup is not blocked on kb.
    setTimeout(() => {
      void this.tick().catch((err) => {
        this.log(`[lesson-spool] initial tick failed: ${err instanceof Error ? err.message : err}`);
      });
    }, 15_000);
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.log(`[lesson-spool] tick failed: ${err instanceof Error ? err.message : err}`);
      });
    }, this.intervalMs);
    // Don't keep the event loop alive solely for this timer in tests.
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<LessonSpoolTickResult> {
    if (this.running) {
      const state = await readSpoolState(this.spoolDir);
      return {
        status: state.lastProbeStatus ?? 'healthy',
        alertFired: false,
        state,
      };
    }
    this.running = true;
    try {
      return await this.runTick();
    } finally {
      this.running = false;
    }
  }

  private async runTick(): Promise<LessonSpoolTickResult> {
    const previous = await readSpoolState(this.spoolDir);
    const pending = await readPendingLessons(this.spoolDir);
    const status = await this.probeKb();
    const transition = applyDegradationProbe({
      previous: { ...previous, lastPendingCount: pending.length },
      status,
      now: this.now(),
      thresholdMs: this.thresholdMs,
    });

    let drained: LessonSpoolTickResult['drained'];
    if (transition.shouldDrain || (status === 'healthy' && pending.length > 0)) {
      const result = await drainLessonSpool({
        spoolDir: this.spoolDir,
        write: this.writeFn,
      });
      drained = {
        attempted: result.attempted,
        written: result.written,
        failed: result.failed,
        deadLetteredCount: result.deadLettered,
        remaining: result.remaining,
      };
      if (result.attempted > 0) {
        this.log(
          `[lesson-spool] drain attempted=${result.attempted} written=${result.written} `
            + `failed=${result.failed} deadLettered=${result.deadLettered} `
            + `remaining=${result.remaining}`,
        );
      }
      transition.state.lastPendingCount = result.remaining;
    } else {
      transition.state.lastPendingCount = pending.length;
    }

    await writeSpoolState(this.spoolDir, transition.state);

    let alertFired = false;
    if (transition.shouldFireAlert) {
      alertFired = true;
      const degradedForMs = transition.degradedForMs;
      const hours = Math.round((degradedForMs / 3_600_000) * 10) / 10;
      const alert = buildKbDegradedAlert({
        degradedSince: transition.state.kbDegradedSince ?? 'unknown',
        degradedForHours: hours,
        pendingCount: transition.state.lastPendingCount ?? pending.length,
        thresholdHours: this.thresholdMs / 3_600_000,
      });
      this.log(`[lesson-spool] prolonged KB degradation alert (${hours}h)`);
      this.emitAlert?.(alert);
    }

    return {
      status,
      drained,
      alertFired,
      state: transition.state,
    };
  }
}

async function defaultKbProbe(): Promise<'healthy' | 'degraded'> {
  try {
    const findings = await runLaunchDependencyPreflights(['kb']);
    return findings.length === 0 ? 'healthy' : 'degraded';
  } catch {
    return 'degraded';
  }
}

export function buildKbDegradedAlert(args: {
  degradedSince: string;
  degradedForHours: number;
  pendingCount: number;
  thresholdHours: number;
}): Extract<ServerMessage, { type: 'alert' }> {
  const severity: AnomalySeverity = 'warning';
  const pendingNote = args.pendingCount > 0
    ? ` ${args.pendingCount} lesson write(s) are waiting in the durable spool.`
    : '';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `KB launch dependency degraded for ${args.degradedForHours}h`,
    details:
      `Advisory operational alert: the \`kb\` launch dependency has remained degraded `
      + `for ${args.degradedForHours}h (threshold ${args.thresholdHours}h; since ${args.degradedSince}).`
      + pendingNote
      + ' Lesson writes are spooled locally and will replay on recovery. '
      + 'Run `kb doctor --format=json` and `kookr lesson status`.',
    severity,
    operationalAlert: {
      key: 'launch_dependency:kb',
      metric: 'launch_dependency_kb_degraded',
      state: 'fired',
    },
  };
}
