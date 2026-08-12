/**
 * Shared stale-process /proc summary cache (issues #2081, #2350).
 *
 * Before #2350, two independent 15s caches walked /proc for the same data:
 *  - diagnostics-routes `STALE_PROCESS_CACHE_MS` (health `staleProcesses`)
 *  - `createCachedStaleDtachCountReader` (session-reaper pressure)
 * and the resource-watchdog disabled-under-pressure gauge scanned uncached.
 * Under host pressure that multiplied /proc work on the event loop.
 *
 * One cache now serves:
 *  - GET /api/health `staleProcesses` (SWR — never blocks the request path)
 *  - session reaper pressure-adaptive orphan age (`getDtachCount`, sync-on-miss)
 *  - resourceWatchdog `pressureWhileDisabled` / disabled-pressure alerter
 *
 * Returns `null` when /proc is unavailable (non-Linux / empty snapshot) so
 * callers can fall back (reaper → live session count; health → omit block).
 */
import { listProcessSnapshots } from '../adapters/proc-process-lister.js';
import type { ProcessSnapshot, StaleProcessSummary } from '../core/orphan-process-scanner.js';
import { scanStaleProcesses, summarizeStaleProcesses } from '../core/orphan-process-scanner.js';

/** Shared TTL for health SWR + reaper/watchdog pressure readers (15s). */
export const STALE_PROCESS_CACHE_MS = 15_000;

/** @deprecated Prefer {@link STALE_PROCESS_CACHE_MS}; kept for #2081 call sites. */
export const STALE_DTACH_PRESSURE_CACHE_MS = STALE_PROCESS_CACHE_MS;

export interface StaleProcessSummaryCacheDeps {
  ttlMs?: number;
  listProcesses?: () => ProcessSnapshot[];
  now?: () => number;
  /**
   * Schedule a background refresh (SWR path). Defaults to `setImmediate` so
   * the health request path never awaits a /proc walk (#1553 lesson).
   */
  schedule?: (fn: () => void) => void;
}

export interface StaleProcessSummaryCache {
  /**
   * Stale-while-revalidate read for the health hot path.
   * Returns the last warm summary (or null if never scanned). When the TTL
   * has expired, schedules a single-flight background refresh and still
   * returns the previous summary until it lands.
   */
  getSummary(): StaleProcessSummary | null;
  /**
   * Sync-on-miss read for reaper / watchdog ticks.
   * Returns a warm cache hit immediately; on miss or expiry scans /proc now
   * and stores the result so concurrent SWR readers share it.
   */
  getSummarySync(): StaleProcessSummary | null;
  /** Convenience: `getSummarySync()?.dtach.count ?? null`. */
  getDtachCount(): number | null;
}

interface CacheEntry {
  expiresAtMs: number;
  summary: StaleProcessSummary | null;
}

/**
 * Build a process-scoped stale-process summary cache.
 * Wire one instance through index.ts into health routes + reaper + watchdog.
 */
export function createStaleProcessSummaryCache(
  deps: StaleProcessSummaryCacheDeps = {},
): StaleProcessSummaryCache {
  const ttlMs = deps.ttlMs ?? STALE_PROCESS_CACHE_MS;
  const listProcesses = deps.listProcesses ?? listProcessSnapshots;
  const nowFn = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((fn: () => void) => {
    setImmediate(fn);
  });

  let cache: CacheEntry | null = null;
  let scanInFlight = false;

  function scanNow(): StaleProcessSummary | null {
    try {
      const snapshots = listProcesses();
      if (snapshots.length === 0) return null; // no /proc (non-Linux/sandbox)
      return summarizeStaleProcesses(
        scanStaleProcesses({
          listProcesses: () => snapshots,
          now: nowFn(),
        }),
      );
    } catch {
      return null;
    }
  }

  function store(summary: StaleProcessSummary | null): void {
    cache = { expiresAtMs: nowFn() + ttlMs, summary };
  }

  function refreshInBackground(): void {
    if (scanInFlight) return;
    scanInFlight = true;
    schedule(() => {
      try {
        // Sync readers may have already warmed the cache while this job was
        // queued — skip a redundant /proc walk (issue #2350).
        if (isWarm(nowFn())) return;
        store(scanNow());
      } finally {
        scanInFlight = false;
      }
    });
  }

  function isWarm(now: number): boolean {
    return cache !== null && cache.expiresAtMs > now;
  }

  function getSummarySync(): StaleProcessSummary | null {
    const now = nowFn();
    if (isWarm(now)) return cache!.summary;
    const summary = scanNow();
    store(summary);
    return summary;
  }

  return {
    getSummary(): StaleProcessSummary | null {
      const now = nowFn();
      if (!isWarm(now)) refreshInBackground();
      return cache?.summary ?? null;
    },

    getSummarySync,

    getDtachCount(): number | null {
      return getSummarySync()?.dtach.count ?? null;
    },
  };
}

export interface CachedStaleDtachCountReaderDeps {
  ttlMs?: number;
  listProcesses?: () => ProcessSnapshot[];
  now?: () => number;
}

/**
 * Build a zero-arg reader suitable for
 * `SessionReaperDeps.getStaleDtachCount` / resource-watchdog pressure.
 * Thin wrapper over {@link createStaleProcessSummaryCache} so isolated
 * call sites (and existing tests) keep working; production wires one
 * shared cache via index.ts instead.
 */
export function createCachedStaleDtachCountReader(
  deps: CachedStaleDtachCountReaderDeps = {},
): () => number | null {
  const cache = createStaleProcessSummaryCache(deps);
  return () => cache.getDtachCount();
}
