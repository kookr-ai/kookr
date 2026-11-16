import { DEFAULT_TRANSCRIPT_RETENTION_DAYS } from './transcript-store.js';

export type TranscriptCaptureScope = 'off' | 'own-repos' | 'all';

export interface TranscriptCaptureConfig {
  enabled: boolean;
  scope: TranscriptCaptureScope;
  graceMs: number;
  maxTasksPerTick: number;
  retentionDays: number;
}

export const DEFAULT_TRANSCRIPT_CAPTURE_GRACE_MS = 15 * 60_000;
export const DEFAULT_TRANSCRIPT_CAPTURE_MAX_PER_TICK = 25;

/** Scope used when `KOOKR_TRANSCRIPT_CAPTURE` is unset or empty (issue #3937). */
export const DEFAULT_TRANSCRIPT_CAPTURE_SCOPE: TranscriptCaptureScope = 'own-repos';

function parseScope(raw: string | undefined): TranscriptCaptureScope {
  const v = raw?.trim().toLowerCase();
  if (!v) return DEFAULT_TRANSCRIPT_CAPTURE_SCOPE;
  // Any other value, including a typo, is off: for a privacy control the safe reading.
  return v === 'own-repos' || v === 'all' ? v : 'off';
}

function parseNonNegInt(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

/**
 * Capture is on by default for the operator's own repositories (`own-repos`,
 * issue #3937); `all` must be asked for, since it stores content read from
 * third-party repositories. `off` (or `0` / `false` / `no`, or any unrecognised
 * value) turns it off.
 */
export function readTranscriptCaptureConfig(
  env: Record<string, string | undefined> = process.env,
): TranscriptCaptureConfig {
  const scope = parseScope(env.KOOKR_TRANSCRIPT_CAPTURE);
  return {
    enabled: scope !== 'off',
    scope,
    graceMs: parseNonNegInt(env.KOOKR_TRANSCRIPT_CAPTURE_GRACE_MS, DEFAULT_TRANSCRIPT_CAPTURE_GRACE_MS, 0),
    maxTasksPerTick: parseNonNegInt(env.KOOKR_TRANSCRIPT_CAPTURE_MAX_PER_TICK, DEFAULT_TRANSCRIPT_CAPTURE_MAX_PER_TICK, 1),
    retentionDays: parseNonNegInt(env.KOOKR_TRANSCRIPT_RETENTION_DAYS, DEFAULT_TRANSCRIPT_RETENTION_DAYS, 1),
  };
}
