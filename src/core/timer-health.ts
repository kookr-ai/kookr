import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  isLifecycleTimerName,
  TIMER_HEALTH_OVERDUE_INTERVALS,
  TIMER_HEALTH_PERSIST_SCHEMA_VERSION,
  TIMER_HEALTH_SCHEMA_VERSION,
  TIMER_HEALTH_STATE_FILE,
  type LifecycleTimerName,
  type TimerHealthLoopEntry,
  type TimerHealthSnapshot,
  type TimerHealthSummary,
} from '../shared/contracts/timer-health.js';

export type {
  LifecycleTimerName,
  TimerHealthLoopEntry,
  TimerHealthSnapshot,
  TimerHealthSummary,
} from '../shared/contracts/timer-health.js';

export {
  EMPTY_TIMER_HEALTH_SUMMARY,
  isLifecycleTimerName,
  LIFECYCLE_TIMER_NAMES,
  TIMER_HEALTH_OVERDUE_INTERVALS,
  TIMER_HEALTH_PERSIST_SCHEMA_VERSION,
  TIMER_HEALTH_SCHEMA_VERSION,
  TIMER_HEALTH_STATE_FILE,
} from '../shared/contracts/timer-health.js';

/** Owner-read/write only — same class as last-good-health and settings.json. */
export const TIMER_HEALTH_PERSIST_FILE_MODE = 0o600;

/** Hard cap for the on-disk stamp file (issue #2638). Plenty for the known loops. */
export const TIMER_HEALTH_PERSIST_SIZE_CAP_BYTES = 8 * 1024;

export function timerHealthStatePath(kookrDir: string): string {
  return join(kookrDir, TIMER_HEALTH_STATE_FILE);
}

export interface TimerHealthPersistOptions {
  /** Absolute path of the stamp file. Omit to keep clocks in memory only. */
  persistPath?: string;
  /**
   * Queue a persist write off the fire path. Defaults to `setImmediate` so
   * `recordFire` never waits on disk. Tests inject a drainable queue.
   */
  scheduleWrite?: (work: () => void) => void;
  sizeCapBytes?: number;
}

interface PersistedLoopStamp {
  lastFiredAtMs: number;
}

interface TimerHealthPersistedState {
  schemaVersion: typeof TIMER_HEALTH_PERSIST_SCHEMA_VERSION;
  loops: Partial<Record<LifecycleTimerName, PersistedLoopStamp>>;
}

/**
 * Lightweight stamp surface for lifecycle timer loops (issue #1771).
 * Optional on `TimerDeps` so unit tests that do not care about health stay
 * unaffected. When constructed with `persistPath`, last-fired stamps survive
 * a process restart (issue #2638) and feed overdue math only — a reload is
 * not treated as a new fire.
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
  /**
   * Four-field counts for GET /api/health (issue #2636). Pure in-memory walk
   * of the registered loops — no disk or network.
   */
  summary(nowMs?: number): TimerHealthSummary;
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
  private readonly now: () => number;
  private readonly persistPath: string | undefined;
  private readonly scheduleWrite: (work: () => void) => void;
  private readonly sizeCapBytes: number;
  /** Last-fired stamps loaded from disk, updated on each fire. */
  private readonly persistedStamps = new Map<LifecycleTimerName, number>();
  private persistQueued = false;
  private persistDirty = false;

  constructor(
    now: () => number = () => Date.now(),
    opts: TimerHealthPersistOptions = {},
  ) {
    this.now = now;
    this.persistPath = opts.persistPath;
    this.scheduleWrite = opts.scheduleWrite ?? ((work) => setImmediate(work));
    this.sizeCapBytes = opts.sizeCapBytes ?? TIMER_HEALTH_PERSIST_SIZE_CAP_BYTES;
    if (this.persistPath) {
      this.loadPersisted();
    }
  }

  register(name: LifecycleTimerName, expectedIntervalMs: number): void {
    const existing = this.loops.get(name);
    if (existing) {
      existing.expectedIntervalMs = expectedIntervalMs;
      return;
    }
    // Seed last-fired from disk so overdue math sees the pre-crash stamp.
    // This is history, not a new fire — do not queue a write.
    this.loops.set(name, {
      name,
      expectedIntervalMs,
      registeredAtMs: this.now(),
      lastFiredAtMs: this.persistedStamps.get(name) ?? null,
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
      this.noteFire(name, nowMs);
      return;
    }
    existing.lastFiredAtMs = nowMs;
    if (expectedIntervalMs !== undefined) {
      existing.expectedIntervalMs = expectedIntervalMs;
    }
    this.noteFire(name, nowMs);
  }

  private noteFire(name: LifecycleTimerName, firedAtMs: number): void {
    this.persistedStamps.set(name, firedAtMs);
    this.queuePersist();
  }

  private loadPersisted(): void {
    const path = this.persistPath;
    if (!path) return;
    try {
      const st = statSync(path);
      if (st.size > this.sizeCapBytes) return;
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const loops = parsePersistedLoops(parsed);
      if (!loops) return;
      for (const [name, stamp] of loops) {
        this.persistedStamps.set(name, stamp);
      }
    } catch {
      // Missing or corrupt file: start empty. Startup must not throw.
    }
  }

  private queuePersist(): void {
    if (!this.persistPath) return;
    this.persistDirty = true;
    if (this.persistQueued) return;
    this.persistQueued = true;
    this.scheduleWrite(() => {
      this.persistQueued = false;
      if (!this.persistDirty) return;
      this.persistDirty = false;
      try {
        this.writePersisted();
      } catch {
        // Fail-open: a disk error must not throw back into the timer.
      }
      if (this.persistDirty) this.queuePersist();
    });
  }

  private writePersisted(): void {
    const path = this.persistPath;
    if (!path) return;
    const loops: TimerHealthPersistedState['loops'] = {};
    for (const [name, lastFiredAtMs] of this.persistedStamps) {
      loops[name] = { lastFiredAtMs };
    }
    const text = `${JSON.stringify({
      schemaVersion: TIMER_HEALTH_PERSIST_SCHEMA_VERSION,
      loops,
    } satisfies TimerHealthPersistedState)}\n`;
    if (Buffer.byteLength(text, 'utf8') > this.sizeCapBytes) return;

    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, text, { encoding: 'utf8', mode: TIMER_HEALTH_PERSIST_FILE_MODE });
      try {
        chmodSync(tmp, TIMER_HEALTH_PERSIST_FILE_MODE);
      } catch {
        // Create mode already requested 0o600.
      }
      renameSync(tmp, path);
      try {
        chmodSync(path, TIMER_HEALTH_PERSIST_FILE_MODE);
      } catch {
        // Content is already durable.
      }
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort temp cleanup.
      }
      throw err;
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

  summary(nowMs: number = this.now()): TimerHealthSummary {
    return summarizeTimerHealthFromStates(this.loops.values(), nowMs);
  }
}

/**
 * Collapse registered loop state into the /api/health four-field summary.
 * Overdue reuses the same 2×-interval rule as the diagnostics snapshot, so a
 * loop still inside its first cadence after boot is not overdue.
 */
function summarizeTimerHealthFromStates(
  states: Iterable<LoopState>,
  nowMs: number,
): TimerHealthSummary {
  let registered = 0;
  let overdue = 0;
  let neverFired = 0;
  let oldestNeverFiredName: LifecycleTimerName | null = null;
  let oldestNeverFiredAt = Number.POSITIVE_INFINITY;
  let oldestOverdueName: LifecycleTimerName | null = null;
  let oldestOverdueProgressAt = Number.POSITIVE_INFINITY;

  for (const state of states) {
    registered += 1;
    const entry = toEntry(state, nowMs);
    const progressMs = state.lastFiredAtMs ?? state.registeredAtMs;
    if (entry.overdue) {
      overdue += 1;
      if (
        progressMs < oldestOverdueProgressAt
        || (progressMs === oldestOverdueProgressAt
          && (oldestOverdueName === null || state.name < oldestOverdueName))
      ) {
        oldestOverdueProgressAt = progressMs;
        oldestOverdueName = state.name;
      }
    }
    if (state.lastFiredAtMs === null) {
      neverFired += 1;
      if (
        state.registeredAtMs < oldestNeverFiredAt
        || (state.registeredAtMs === oldestNeverFiredAt
          && (oldestNeverFiredName === null || state.name < oldestNeverFiredName))
      ) {
        oldestNeverFiredAt = state.registeredAtMs;
        oldestNeverFiredName = state.name;
      }
    }
  }

  return {
    registered,
    overdue,
    neverFired,
    oldestNeverFiredName,
    oldestOverdueName,
  };
}

/**
 * Fallback when a test harness only stubs `snapshot()`. Name-sort stands in
 * for register order because the snapshot does not carry `registeredAt`.
 */
export function summarizeTimerHealth(
  snapshot: Pick<TimerHealthSnapshot, 'loops'>,
): TimerHealthSummary {
  let overdue = 0;
  let neverFired = 0;
  let oldestNeverFiredName: LifecycleTimerName | null = null;
  let oldestOverdueName: LifecycleTimerName | null = null;
  let oldestOverdueFiredAt = Number.POSITIVE_INFINITY;

  for (const loop of snapshot.loops) {
    if (loop.overdue) {
      overdue += 1;
      const firedAt = loop.lastFiredAt === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(loop.lastFiredAt);
      const progressAt = Number.isFinite(firedAt) ? firedAt : Number.NEGATIVE_INFINITY;
      if (
        progressAt < oldestOverdueFiredAt
        || (progressAt === oldestOverdueFiredAt
          && (oldestOverdueName === null || loop.name < oldestOverdueName))
      ) {
        oldestOverdueFiredAt = progressAt;
        oldestOverdueName = loop.name;
      }
    }
    if (loop.lastFiredAt === null) {
      neverFired += 1;
      if (oldestNeverFiredName === null || loop.name < oldestNeverFiredName) {
        oldestNeverFiredName = loop.name;
      }
    }
  }

  return {
    registered: snapshot.loops.length,
    overdue,
    neverFired,
    oldestNeverFiredName,
    oldestOverdueName,
  };
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

function parsePersistedLoops(value: unknown): Map<LifecycleTimerName, number> | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (rec.schemaVersion !== TIMER_HEALTH_PERSIST_SCHEMA_VERSION) return null;
  if (!rec.loops || typeof rec.loops !== 'object' || Array.isArray(rec.loops)) return null;
  const out = new Map<LifecycleTimerName, number>();
  for (const [name, entry] of Object.entries(rec.loops as Record<string, unknown>)) {
    if (!isLifecycleTimerName(name)) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const ms = (entry as { lastFiredAtMs?: unknown }).lastFiredAtMs;
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
      out.set(name, ms);
    }
  }
  return out;
}
