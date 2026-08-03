/**
 * Short-lived on-disk marker written by `scripts/prod-restart.sh` just before
 * pre-stop drain (issue #1983).
 *
 * While the outgoing process is still draining, schedule fires consult this
 * marker so ledger / UI can record `skipped_server_restarting` instead of a
 * generic operator `skipped_draining`. After process exit the marker is
 * harmless: fires only consult it when the drain gate is already closed.
 *
 * Intentionally best-effort and age-capped so a crashed restart cannot
 * mislabel a later manual drain forever.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Filename under `kookrDir` written by prod-restart before drain. */
export const SERVER_RESTARTING_MARKER_FILE = 'server-restarting.json';

/**
 * Markers older than this are ignored so a stuck file cannot re-label
 * a later operator drain as a redeploy forever.
 */
export const SERVER_RESTARTING_MARKER_MAX_AGE_MS = 10 * 60_000;

export interface ServerRestartingMarker {
  schemaVersion: 'server-restarting.v1';
  reason: 'server_restarting';
  at: string;
  source?: string;
}

/**
 * Best-effort sync read of the restart marker. Returns null when missing,
 * unreadable, malformed, or older than {@link SERVER_RESTARTING_MARKER_MAX_AGE_MS}.
 * Never throws — schedule tick path must stay resilient.
 */
export function readServerRestartingMarker(
  kookrDir: string,
  nowMs: number = Date.now(),
): ServerRestartingMarker | null {
  try {
    const path = join(kookrDir, SERVER_RESTARTING_MARKER_FILE);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.schemaVersion !== 'server-restarting.v1') return null;
    if (parsed.reason !== 'server_restarting') return null;
    if (typeof parsed.at !== 'string' || parsed.at.length === 0) return null;
    const atMs = Date.parse(parsed.at);
    if (!Number.isFinite(atMs)) return null;
    if (nowMs - atMs > SERVER_RESTARTING_MARKER_MAX_AGE_MS) return null;
    // Future-dated clocks are tolerated within a small skew window.
    if (atMs - nowMs > 60_000) return null;
    const marker: ServerRestartingMarker = {
      schemaVersion: 'server-restarting.v1',
      reason: 'server_restarting',
      at: parsed.at,
    };
    if (typeof parsed.source === 'string' && parsed.source.length > 0) {
      marker.source = parsed.source;
    }
    return marker;
  } catch {
    return null;
  }
}

/** True when a fresh restart marker is present under `kookrDir`. */
export function isServerRestartingActive(
  kookrDir: string,
  nowMs: number = Date.now(),
): boolean {
  return readServerRestartingMarker(kookrDir, nowMs) !== null;
}
