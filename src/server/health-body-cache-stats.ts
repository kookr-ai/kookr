/**
 * Shared timing gauges for the `/api/health` body cache (issue #2497).
 *
 * `registerDiagnosticsRoutes` owns the health-body cache and records the last
 * full-assembly duration plus when the current cached body was produced.
 * `/metrics` reads the same instance via {@link snapshot} so operators can chart
 * assembly cost and cache staleness without polling JSON `/api/health`.
 *
 * The one instance is wired in `createRoutes` (same pattern as the shared
 * lesson-yield cache, issue #1857); partial test harnesses that register a
 * single route get a private fallback and simply report cold (no series).
 */
export interface HealthBodyCacheStatsSnapshot {
  /** Duration of the most recent full health-body assembly walk, milliseconds. */
  assemblyMs: number;
  /**
   * Age of the currently-cached health body at read time, milliseconds. During
   * a stale-while-revalidate refresh (issue #2492) this can exceed the 1s TTL
   * until the background assembly replaces the body.
   */
  cacheAgeMs: number;
}

export class HealthBodyCacheStats {
  #assemblyMs = 0;
  #cachedAtMs: number | undefined;

  /** Record a completed assembly: how long it took and when it landed. */
  record(assemblyMs: number, cachedAtMs: number): void {
    this.#assemblyMs = assemblyMs;
    this.#cachedAtMs = cachedAtMs;
  }

  /**
   * Point-in-time gauges, or `undefined` when no body has ever been assembled
   * (cold) so `/metrics` omits the series rather than emitting fabricated zeros.
   */
  snapshot(nowMs: number): HealthBodyCacheStatsSnapshot | undefined {
    if (this.#cachedAtMs === undefined) return undefined;
    return {
      assemblyMs: this.#assemblyMs,
      cacheAgeMs: Math.max(0, nowMs - this.#cachedAtMs),
    };
  }
}
