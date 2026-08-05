/**
 * Cached `staleProcesses.dtach.count` reader for the session reaper's
 * pressure-adaptive orphan age (issue #2081).
 *
 * Same soft-bound gauge as `resourceWatchdog.pressureWhileDisabled` (#2039):
 * host-wide kookr-dtach masters from a /proc scan. Cached with a short TTL so
 * the 5s liveness tick does not re-walk /proc every time (same 15s window the
 * diagnostics health path uses for its stale-process gauge).
 *
 * Returns `null` when /proc is unavailable (non-Linux / empty snapshot) so the
 * reaper can fall back to its live session count.
 */
import { listProcessSnapshots } from '../adapters/proc-process-lister.js';
import type { ProcessSnapshot } from '../core/orphan-process-scanner.js';
import { scanStaleProcesses, summarizeStaleProcesses } from '../core/orphan-process-scanner.js';

/** Match diagnostics-routes' stale-process SWR window. */
export const STALE_DTACH_PRESSURE_CACHE_MS = 15_000;

export interface CachedStaleDtachCountReaderDeps {
  ttlMs?: number;
  listProcesses?: () => ProcessSnapshot[];
  now?: () => number;
}

/**
 * Build a zero-arg reader suitable for
 * `SessionReaperDeps.getStaleDtachCount`. Each call returns the last warm
 * count, or refreshes when the TTL has expired.
 */
export function createCachedStaleDtachCountReader(
  deps: CachedStaleDtachCountReaderDeps = {},
): () => number | null {
  const ttlMs = deps.ttlMs ?? STALE_DTACH_PRESSURE_CACHE_MS;
  const listProcesses = deps.listProcesses ?? listProcessSnapshots;
  const nowFn = deps.now ?? Date.now;
  let cache: { expiresAtMs: number; count: number | null } | null = null;

  return () => {
    const now = nowFn();
    if (cache && cache.expiresAtMs > now) return cache.count;
    try {
      const snapshots = listProcesses();
      if (snapshots.length === 0) {
        cache = { expiresAtMs: now + ttlMs, count: null };
        return null;
      }
      const summary = summarizeStaleProcesses(
        scanStaleProcesses({ listProcesses: () => snapshots, now }),
      );
      cache = { expiresAtMs: now + ttlMs, count: summary.dtach.count };
      return summary.dtach.count;
    } catch {
      cache = { expiresAtMs: now + ttlMs, count: null };
      return null;
    }
  };
}
