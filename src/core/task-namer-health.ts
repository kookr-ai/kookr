/**
 * "Task namer has gone silent" signal (issue #3616).
 *
 * The LLM task namer degrades without failing anything: when its provider
 * dies, every task silently falls back to a prompt-derived name. In 2026-11 a
 * provider answering HTTP 410 Gone went unnoticed for weeks that way. This
 * module keeps a small record of naming outcomes and says when every naming
 * attempt over at least `thresholdMs` has failed, so the dashboard can show it.
 *
 * Rules:
 * - The streak starts at the first failed attempt after the last success and
 *   ends at the next success. The namer is "silent" once the first and the
 *   latest failure of the streak are at least `thresholdMs` apart. Measuring
 *   between failures, not from the last success, means an idle host (no task
 *   launches, so no attempts) never looks dead, and one transient failure
 *   after a quiet night does not fire.
 * - One success clears the streak.
 * - The record is persisted: prod restarts many times a day, so a streak kept
 *   in memory would never reach a threshold measured in hours.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { TaskNamerHealthSnapshot } from '../shared/contracts/diagnostic.js';

/** Default N: six hours of failed naming calls before the signal shows. */
export const DEFAULT_TASK_NAMER_ALERT_HOURS = 6;

/** Persisted naming record. Times are epoch milliseconds. */
export interface TaskNamerHealthState {
  lastSuccessAt: number | null;
  /** First failed attempt since the last success; null when not failing. */
  failingSince: number | null;
  lastFailureAt: number | null;
  /** Failed attempts since the last success. */
  failedAttempts: number;
}

export type TaskNamerOutcome = 'success' | 'failure';

export function emptyTaskNamerHealthState(): TaskNamerHealthState {
  return { lastSuccessAt: null, failingSince: null, lastFailureAt: null, failedAttempts: 0 };
}

/** Return the record after one naming attempt that ended at `now`. */
export function recordTaskNamerOutcome(
  state: TaskNamerHealthState,
  outcome: TaskNamerOutcome,
  now: number,
): TaskNamerHealthState {
  if (outcome === 'success') {
    return { lastSuccessAt: now, failingSince: null, lastFailureAt: null, failedAttempts: 0 };
  }
  return {
    lastSuccessAt: state.lastSuccessAt,
    failingSince: state.failingSince ?? now,
    lastFailureAt: now,
    failedAttempts: state.failedAttempts + 1,
  };
}

/**
 * Project the record for `GET /api/health.taskNamer`. `enabled` is false when
 * no LLM provider is configured (the namer is off on purpose) or the threshold
 * is `0`; a disabled namer is never silent.
 */
export function evaluateTaskNamerHealth(
  state: TaskNamerHealthState,
  opts: { enabled: boolean; thresholdMs: number },
): TaskNamerHealthSnapshot {
  const enabled = opts.enabled && opts.thresholdMs > 0;
  const failingForMs = state.failingSince !== null && state.lastFailureAt !== null
    ? state.lastFailureAt - state.failingSince
    : 0;
  return {
    enabled,
    silent: enabled && state.failedAttempts > 0 && failingForMs >= opts.thresholdMs,
    thresholdMs: opts.thresholdMs,
    lastSuccessAt: toIso(state.lastSuccessAt),
    failingSince: toIso(state.failingSince),
    lastFailureAt: toIso(state.lastFailureAt),
    failedAttempts: state.failedAttempts,
  };
}

/**
 * Read N from `KOOKR_TASK_NAMER_ALERT_HOURS` as milliseconds. Blank or invalid
 * values use the default; `0` (or a negative number) turns the signal off.
 */
export function readTaskNamerAlertThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KOOKR_TASK_NAMER_ALERT_HOURS;
  const fallback = DEFAULT_TASK_NAMER_ALERT_HOURS * 3_600_000;
  if (raw == null || raw.trim() === '') return fallback;
  const hours = Number(raw);
  if (!Number.isFinite(hours)) return fallback;
  return hours <= 0 ? 0 : Math.round(hours * 3_600_000);
}

function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function isNullableTime(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function parseState(value: unknown): TaskNamerHealthState | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const { lastSuccessAt, failingSince, lastFailureAt, failedAttempts } = rec;
  if (!isNullableTime(lastSuccessAt) || !isNullableTime(failingSince) || !isNullableTime(lastFailureAt)) {
    return null;
  }
  if (typeof failedAttempts !== 'number' || !Number.isInteger(failedAttempts) || failedAttempts < 0) {
    return null;
  }
  return { lastSuccessAt, failingSince, lastFailureAt, failedAttempts };
}

/**
 * Records naming outcomes and persists them to one small JSON file. A missing
 * or corrupt file starts empty; a failed write is logged and never breaks
 * naming (the signal is diagnostics, not control flow).
 */
export class TaskNamerHealthTracker {
  private state: TaskNamerHealthState;

  constructor(
    private readonly opts: {
      /** State file path; omit for an in-memory tracker (tests). */
      path?: string;
      enabled: boolean;
      thresholdMs: number;
      now?: () => number;
    },
  ) {
    this.state = opts.path ? loadState(opts.path) : emptyTaskNamerHealthState();
  }

  record(outcome: TaskNamerOutcome): void {
    this.state = recordTaskNamerOutcome(this.state, outcome, (this.opts.now ?? Date.now)());
    if (!this.opts.path) return;
    try {
      saveState(this.opts.path, this.state);
    } catch (err) {
      console.warn('[task-naming] Could not save the namer health record:', err instanceof Error ? err.message : err);
    }
  }

  snapshot(): TaskNamerHealthSnapshot {
    return evaluateTaskNamerHealth(this.state, { enabled: this.opts.enabled, thresholdMs: this.opts.thresholdMs });
  }
}

function loadState(path: string): TaskNamerHealthState {
  try {
    return parseState(JSON.parse(readFileSync(path, 'utf-8'))) ?? emptyTaskNamerHealthState();
  } catch {
    return emptyTaskNamerHealthState();
  }
}

function saveState(path: string, state: TaskNamerHealthState): void {
  mkdirSync(dirname(path), { recursive: true });
  // Temp file + rename, so a crash mid-write never leaves truncated JSON.
  const tempPath = join(dirname(path), `.task-namer-health.${randomBytes(6).toString('hex')}.tmp`);
  let renamed = false;
  try {
    writeFileSync(tempPath, `${JSON.stringify(state)}\n`, 'utf-8');
    renameSync(tempPath, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try { unlinkSync(tempPath); } catch { /* best effort */ }
    }
  }
}
