import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TIME_TO_UNBLOCK_SCHEMA_VERSION,
  TIME_TO_UNBLOCK_WINDOW_MS,
  type TimeToUnblockSnapshot,
} from '../shared/contracts/time-to-unblock.js';
import { readInteractionLog, type InteractionEvent } from './interaction-log.js';

/**
 * Collect human-reply wait durations from interaction events.
 *
 * Only `finding_resolved` events where a person actually replied
 * (`method === "input"`) and `durationMs` is a finite number count.
 * Snooze, skip, auto-clear, and false-positive resolutions are a
 * different population and must not enter the median.
 */
export function collectInputResolutionDurations(
  events: readonly InteractionEvent[],
  opts: { nowMs: number; windowMs?: number },
): number[] {
  const windowMs = opts.windowMs ?? TIME_TO_UNBLOCK_WINDOW_MS;
  const windowStartMs = opts.nowMs - windowMs;
  const durations: number[] = [];

  for (const event of events) {
    if (event.type !== 'finding_resolved') continue;
    if (event.method !== 'input') continue;
    if (!Number.isFinite(event.durationMs)) continue;
    const resolvedAtMs = Date.parse(event.timestamp);
    if (!Number.isFinite(resolvedAtMs)) continue;
    if (resolvedAtMs < windowStartMs || resolvedAtMs > opts.nowMs) continue;
    durations.push(event.durationMs);
  }

  return durations;
}

/**
 * Median of a numeric sample. Odd count: middle value. Even count:
 * average of the two middle values. Empty: null.
 */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function computeTimeToUnblockSnapshot(
  events: readonly InteractionEvent[],
  opts: { nowMs: number; windowMs?: number },
): TimeToUnblockSnapshot {
  const windowMs = opts.windowMs ?? TIME_TO_UNBLOCK_WINDOW_MS;
  const durations = collectInputResolutionDurations(events, { nowMs: opts.nowMs, windowMs });
  return {
    schemaVersion: TIME_TO_UNBLOCK_SCHEMA_VERSION,
    medianMs: medianOf(durations),
    sampleCount: durations.length,
    windowMs,
    generatedAt: new Date(opts.nowMs).toISOString(),
  };
}

/**
 * Read recent interaction events from the existing session JSONL files.
 * Does not create a store. Session files whose mtime is older than the
 * window cannot contain in-window events, so they are skipped.
 */
export async function loadRecentInteractionEvents(
  kookrDir: string,
  opts: { nowMs: number; windowMs?: number },
): Promise<InteractionEvent[]> {
  const paths = await listRecentInteractionLogPaths(kookrDir, opts);
  const batches = await Promise.all(paths.map((path) => readInteractionLog(path)));
  return batches.flat();
}

export async function computeTimeToUnblockFromDir(
  kookrDir: string,
  opts: { nowMs: number; windowMs?: number },
): Promise<TimeToUnblockSnapshot> {
  const events = await loadRecentInteractionEvents(kookrDir, opts);
  return computeTimeToUnblockSnapshot(events, opts);
}

export async function listRecentInteractionLogPaths(
  kookrDir: string,
  opts: { nowMs: number; windowMs?: number },
): Promise<string[]> {
  const windowMs = opts.windowMs ?? TIME_TO_UNBLOCK_WINDOW_MS;
  const windowStartMs = opts.nowMs - windowMs;
  const candidates = [join(kookrDir, 'interaction-log.jsonl')];

  try {
    const entries = await readdir(join(kookrDir, 'sessions'));
    for (const entry of entries) {
      candidates.push(join(kookrDir, 'sessions', entry, 'interactions.jsonl'));
    }
  } catch {
    // No sessions directory is fine — the root log (if any) still counts.
  }

  const recent: string[] = [];
  for (const path of candidates) {
    try {
      const info = await stat(path);
      if (info.mtimeMs >= windowStartMs) recent.push(path);
    } catch {
      // Missing file: skip.
    }
  }
  return recent;
}
