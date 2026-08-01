import {
  TIMER_HEALTH_OVERDUE_INTERVALS,
  TIMER_HEALTH_SCHEMA_VERSION,
  type LifecycleTimerName,
  type TimerHealthLoopEntry,
  type TimerHealthSnapshot,
} from '../shared/contracts/timer-health.js';

export type {
  LifecycleTimerName,
  TimerHealthLoopEntry,
  TimerHealthSnapshot,
} from '../shared/contracts/timer-health.js';

export {
  LIFECYCLE_TIMER_NAMES,
  TIMER_HEALTH_OVERDUE_INTERVALS,
  TIMER_HEALTH_SCHEMA_VERSION,
} from '../shared/contracts/timer-health.js';

/**
 * Lightweight stamp surface for lifecycle timer loops (issue #1771).
 * Optional on `TimerDeps` so unit tests that do not care about health stay
 * unaffected.
 */
export interface TimerHealthRecorder {
  /**
   * Declare a loop is active with its expected cadence. Idempotent; updates
   * expectedIntervalMs when called again (adaptive quota poll).
   */
  register(name: LifecycleTimerName, expectedIntervalMs: number): void;
  /**
   * Stamp lastFiredAt = now. Optionally refresh expectedIntervalMs for
   * adaptive loops (quota poll). No-ops if the loop was never registered —
   * call {@link register} at timer start so never-fired loops still appear.
   */
  recordFire(name: LifecycleTimerName, expectedIntervalMs?: number): void;
  /** Cheap in-memory snapshot for GET /api/diagnostics/timer-health. */
  snapshot(nowMs?: number): TimerHealthSnapshot;
}

interface LoopState {
  name: LifecycleTimerName;
  expectedIntervalMs: number;
  /** Epoch ms when the loop was first registered (timer started). */
  registeredAtMs: number;
  /** Epoch ms of the most recent fire, or null. */
  lastFiredAtMs: number | null;
}

export class TimerHealthTracker implements TimerHealthRecorder {
  private readonly loops = new Map<LifecycleTimerName, LoopState>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  register(name: LifecycleTimerName, expectedIntervalMs: number): void {
    const existing = this.loops.get(name);
    if (existing) {
      existing.expectedIntervalMs = expectedIntervalMs;
      return;
    }
    this.loops.set(name, {
      name,
      expectedIntervalMs,
      registeredAtMs: this.now(),
      lastFiredAtMs: null,
    });
  }

  recordFire(name: LifecycleTimerName, expectedIntervalMs?: number): void {
    const nowMs = this.now();
    const existing = this.loops.get(name);
    if (!existing) {
      // Defensive: allow fire-before-register so a missed register does not
      // silently drop the stamp (still surfaces the loop).
      this.loops.set(name, {
        name,
        expectedIntervalMs: expectedIntervalMs ?? 0,
        registeredAtMs: nowMs,
        lastFiredAtMs: nowMs,
      });
      return;
    }
    existing.lastFiredAtMs = nowMs;
    if (expectedIntervalMs !== undefined) {
      existing.expectedIntervalMs = expectedIntervalMs;
    }
  }

  snapshot(nowMs: number = this.now()): TimerHealthSnapshot {
    const loops: TimerHealthLoopEntry[] = [];
    for (const state of this.loops.values()) {
      loops.push(toEntry(state, nowMs));
    }
    // Stable order for operators / tests.
    loops.sort((a, b) => a.name.localeCompare(b.name));
    return {
      schemaVersion: TIMER_HEALTH_SCHEMA_VERSION,
      generatedAt: new Date(nowMs).toISOString(),
      loops,
    };
  }
}

function toEntry(state: LoopState, nowMs: number): TimerHealthLoopEntry {
  const progressMs = state.lastFiredAtMs ?? state.registeredAtMs;
  const maxAgeMs = state.expectedIntervalMs * TIMER_HEALTH_OVERDUE_INTERVALS;
  // expectedIntervalMs === 0 would always be overdue; treat as not-overdue
  // (disabled / unknown cadence) rather than flapping.
  const overdue =
    state.expectedIntervalMs > 0 && nowMs - progressMs > maxAgeMs;
  return {
    name: state.name,
    lastFiredAt:
      state.lastFiredAtMs === null ? null : new Date(state.lastFiredAtMs).toISOString(),
    expectedIntervalMs: state.expectedIntervalMs,
    overdue,
  };
}
