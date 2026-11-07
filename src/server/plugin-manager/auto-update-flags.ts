/**
 * Env flags for Layer-4 auto-update. A dependency-free leaf module so both the
 * runner wiring (`auto-update-ops.ts`) and the spawn gate (`loadout-store.ts`)
 * can read them without an import cycle.
 */

/** Gate for the auto-APPLY runner. Default OFF — `notify` + the UI work regardless. */
export const AUTO_UPDATE_APPLY_FLAG = 'KOOKR_PLUGIN_AUTO_UPDATE';

/** True when `apply-when-idle` may actually auto-apply updates in this process. */
export function autoUpdateApplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[AUTO_UPDATE_APPLY_FLAG];
  return v === '1' || v === 'true';
}

/** Interval between background auto-update sweeps. */
export const AUTO_UPDATE_INTERVAL_FLAG = 'KOOKR_PLUGIN_AUTO_UPDATE_INTERVAL_MS';
export const DEFAULT_AUTO_UPDATE_SWEEP_MS = 15 * 60 * 1000;

/** The sweep interval in ms: the env override when a valid ≥60s integer, else the 15-minute default. */
export function autoUpdateSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[AUTO_UPDATE_INTERVAL_FLAG];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_AUTO_UPDATE_SWEEP_MS;
}
