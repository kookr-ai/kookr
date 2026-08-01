/**
 * Shared lesson-yield snapshot cache for health + /metrics (issues #1538, #1553, #1857).
 *
 * Diagnostics fills this after bounded background hook-log scans.
 * `/metrics` only *reads* the last days=1 snapshot — it must never scan hooks
 * on the scrape path (OOM/timeout risk; see 2026-07-26 incident).
 */
import type { LessonYieldSnapshot } from '../core/lesson-decision.js';

export interface LessonYieldCacheEntry {
  expiresAtMs: number;
  snapshot: LessonYieldSnapshot;
}

export class LessonYieldHealthCache {
  private readonly entries = new Map<number, LessonYieldCacheEntry>();

  getEntry(days: number): LessonYieldCacheEntry | undefined {
    return this.entries.get(days);
  }

  set(days: number, snapshot: LessonYieldSnapshot, expiresAtMs: number): void {
    this.entries.set(days, { expiresAtMs, snapshot });
  }

  /**
   * Pure read of the last 24h (days=1) snapshot when warm.
   * Returns undefined when cold — callers must omit series, not invent zeros.
   */
  getCached24h(): LessonYieldSnapshot | undefined {
    return this.entries.get(1)?.snapshot;
  }
}
