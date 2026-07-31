/**
 * Env-configurable knobs for the dashboard WS mechanisms added in #1725 that
 * are NOT the event-loop-delay load-shed gate (see `websocket-load-shed.ts`
 * for that one) — per-client sustained-backpressure disconnect and dead-socket
 * liveness reaping. Split from the load-shed reader because these govern a
 * different axis (per-socket bufferedAmount / registry sweep) with its own
 * rollback knobs.
 */

import { DEFAULT_BACKPRESSURE_DISCONNECT_AFTER_SKIPS } from './viewer-broadcaster.js';

/** Default: dead-socket ping/pong liveness reaping is on. */
export const DEFAULT_LIVENESS_SWEEP_ENABLED = true;

export interface DashboardFanoutConfig {
  /**
   * Consecutive SNAPSHOT broadcasts a socket may sit above the soft
   * backpressure threshold before disconnect. `0` disables this specific
   * mechanism (soft-skip-only) — a mid-incident kill switch distinct from
   * the (always-on) hard bufferedAmount cap.
   */
  backpressureDisconnectAfterSkips: number;
  /** Whether the connection registry's sweep tick also reaps dead sockets via ping/pong + readyState. */
  livenessSweepEnabled: boolean;
}

function readNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

function readBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  return fallback;
}

/**
 * Read dashboard fan-out knobs from the environment. Invalid or blank values
 * fall back to the documented defaults.
 */
export function readDashboardFanoutConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DashboardFanoutConfig {
  return {
    backpressureDisconnectAfterSkips: readNonNegativeInt(
      env.KOOKR_WS_BACKPRESSURE_DISCONNECT_AFTER_SKIPS,
      DEFAULT_BACKPRESSURE_DISCONNECT_AFTER_SKIPS,
    ),
    livenessSweepEnabled: readBool(
      env.KOOKR_WS_LIVENESS_SWEEP_ENABLED,
      DEFAULT_LIVENESS_SWEEP_ENABLED,
    ),
  };
}
