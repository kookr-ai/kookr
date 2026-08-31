import {
  INVENT_PRIORITY_HEALTH_WINDOW_HOURS,
  loadInventPriorityClassHealth,
  type InventPriorityClassHealth,
} from '../core/pipeline-starvation-state.js';

/** Queue-feeder rollups are fresh enough at minute cadence and stay off health polls. */
export const INVENT_PRIORITY_HEALTH_REFRESH_INTERVAL_MS = 60_000;

export interface InventPriorityClassHealthSnapshot extends InventPriorityClassHealth {
  /** Completion time of the last successful ledger scan. */
  generatedAt: string | null;
  /** Age of the last successful ledger scan, computed when the snapshot is read. */
  ageMs: number | null;
  /** Most recent refresh failure; cleared by the next successful scan. */
  lastRefreshError: string | null;
}

type InventPriorityHealthLoader = (
  opts?: Parameters<typeof loadInventPriorityClassHealth>[0],
) => Promise<InventPriorityClassHealth>;

export interface InventPriorityHealthRefresherDeps {
  kookrDir?: string;
  intervalMs?: number;
  load?: InventPriorityHealthLoader;
  nowMs?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/**
 * Process-scoped queue-feeder rollup publisher (issue #2912).
 *
 * The timer owns all ledger I/O. Health only calls {@link getSnapshot}, a
 * synchronous in-memory read. Refreshes are single-flight, and failures update
 * error metadata without discarding the last successful counts.
 */
export class InventPriorityHealthRefresher {
  private readonly kookrDir: string | undefined;
  private readonly intervalMs: number;
  private readonly load: InventPriorityHealthLoader;
  private readonly nowMs: () => number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private counts: InventPriorityClassHealth = {
    product: 0,
    micro: 0,
    other: 0,
    windowHours: INVENT_PRIORITY_HEALTH_WINDOW_HOURS,
  };
  private generatedAtMs: number | null = null;
  private lastRefreshError: string | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: InventPriorityHealthRefresherDeps = {}) {
    this.kookrDir = deps.kookrDir;
    this.intervalMs = deps.intervalMs ?? INVENT_PRIORITY_HEALTH_REFRESH_INTERVAL_MS;
    this.load = deps.load ?? loadInventPriorityClassHealth;
    this.nowMs = deps.nowMs ?? Date.now;
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  start(): void {
    if (this.timer !== null) return;
    void this.refresh();
    this.timer = this.setIntervalFn(() => {
      void this.refresh();
    }, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;

    let pending: Promise<void>;
    try {
      pending = this.load({
        ...(this.kookrDir !== undefined ? { kookrDir: this.kookrDir } : {}),
        windowHours: INVENT_PRIORITY_HEALTH_WINDOW_HOURS,
      }).then((counts) => {
        this.counts = counts;
        this.generatedAtMs = this.nowMs();
        this.lastRefreshError = null;
      }).catch((error: unknown) => {
        this.lastRefreshError = error instanceof Error ? error.message : String(error);
      }).finally(() => {
        if (this.refreshInFlight === pending) this.refreshInFlight = null;
      });
    } catch (error) {
      this.lastRefreshError = error instanceof Error ? error.message : String(error);
      return Promise.resolve();
    }
    this.refreshInFlight = pending;
    return pending;
  }

  getSnapshot(): InventPriorityClassHealthSnapshot {
    const generatedAtMs = this.generatedAtMs;
    return {
      ...this.counts,
      generatedAt: generatedAtMs === null ? null : new Date(generatedAtMs).toISOString(),
      ageMs: generatedAtMs === null ? null : Math.max(0, this.nowMs() - generatedAtMs),
      lastRefreshError: this.lastRefreshError,
    };
  }
}
