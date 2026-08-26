/**
 * Per-source spawn budget (issue #1526 Phase C / C3).
 *
 * During the 2026-07-24 deadlock a runaway burst of task creations looked
 * successful to the caller while every over-cap launch silently starved
 * (FM3). The pending-queue depth limit bounds total queued work; this limiter
 * bounds how fast any ONE launch source can create tasks, so a single
 * misbehaving caller exhausts its own budget before it exhausts the shared
 * queue.
 *
 * Sliding window, counted per bucket key. The key is the launch source
 * (`cli` / `api` / `websocket` / …), actor-qualified when the Phase B
 * `X-Kookr-Actor` header identified the caller (see {@link spawnBudgetKey}) —
 * so 'lucy' has her own budget distinct from anonymous API callers.
 *
 * Schedule-fired launches are deliberately EXEMPT (enforced at the call site
 * in `launchTaskCore`, not here): schedules are operator-configured cadence
 * with their own coalescing (at most one outstanding queued fire per
 * schedule, issue #1526 Phase A) and dead-man starvation alerting (Phase C).
 * A "burst" there means schedule configuration, not a runaway caller, and
 * rate-limiting it would convert planned periodic work into
 * `dispatch_failed` noise.
 *
 * In-memory only, by design: a restart resets every window, which errs toward
 * accepting work — the same trade the launch-reservation map makes.
 */

export interface SpawnRateLimiterDeps {
  /** Live getter — max creations per window per bucket (`spawnBurstLimit`). */
  getLimit: () => number;
  /** Live getter — sliding-window size in ms (`spawnBurstWindowMinutes`). */
  getWindowMs: () => number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface SpawnRateVerdict {
  allowed: boolean;
  /** Bucket key the verdict applies to. */
  source: string;
  /** Creations already recorded inside the current window (before this attempt). */
  count: number;
  limit: number;
  windowMs: number;
  /**
   * When rejected: how long until the oldest in-window entry slides out and
   * one slot frees. 0 when allowed.
   */
  retryAfterMs: number;
}

/**
 * Build the budget bucket key: bare launch source, or `source:actor:<id>`
 * when the caller identified itself via the Phase B actor header.
 */
export function spawnBudgetKey(source: string, actorId?: string): string {
  const trimmed = actorId?.trim();
  return trimmed ? `${source}:actor:${trimmed}` : source;
}

export class SpawnRateLimiter {
  /** Bucket key → ascending creation timestamps still inside some window. */
  private buckets = new Map<string, number[]>();

  constructor(private readonly deps: SpawnRateLimiterDeps) {}

  /**
   * Check the budget for `key` and, when allowed, record this creation
   * against it in the same synchronous step (no await may separate check from
   * record, mirroring the launch-reservation CAS convention). A rejected attempt
   * is NOT recorded — being told "no" must not itself burn budget, or a
   * retrying caller could never recover.
   */
  tryAcquire(key: string): SpawnRateVerdict {
    const now = this.deps.now?.() ?? Date.now();
    const limit = this.deps.getLimit();
    const windowMs = this.deps.getWindowMs();
    const cutoff = now - windowMs;

    let bucket = this.buckets.get(key);
    if (bucket) {
      // Prune entries that slid out of the window. Timestamps are appended in
      // ascending order, so one findIndex + slice keeps this O(bucket size).
      const firstLive = bucket.findIndex((t) => t > cutoff);
      if (firstLive === -1) bucket.length = 0;
      else if (firstLive > 0) bucket.splice(0, firstLive);
      if (bucket.length === 0) this.buckets.delete(key);
    }
    bucket = this.buckets.get(key);
    const count = bucket?.length ?? 0;

    if (count >= limit) {
      const oldest = bucket![0];
      return {
        allowed: false,
        source: key,
        count,
        limit,
        windowMs,
        retryAfterMs: Math.max(0, oldest + windowMs - now),
      };
    }

    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    bucket.push(now);
    return { allowed: true, source: key, count, limit, windowMs, retryAfterMs: 0 };
  }
}
