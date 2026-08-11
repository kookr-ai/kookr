/**
 * Deploy-stale residual classifier (issue #2226).
 *
 * When `kookr-prod` sits behind `origin/main` with no deploy in flight, the
 * operator previously saw silent health-ok forever: deploy-lag only pages
 * after 6h, and the agent-scheduled deploy-convergence path only acts when
 * the schedule is registered *and* an agent slot is free. This pure module
 * answers one question:
 *
 *   behindCount ≥ N AND deploying === false for ≥ T minutes → page / act
 *
 * No I/O. The in-process controller (`src/server/deploy-convergence-controller.ts`)
 * gathers live status and applies the decision (redeploy trigger + operator
 * signal).
 */

export interface DeployStaleResidualThresholds {
  /** Minimum undeployed commit count before residual tracking starts. Default 1. */
  minBehindCount: number;
  /** How long behind+idle must persist before the residual is "loud". Default 20m. */
  staleMs: number;
  /** Re-page cooldown while residual remains high. Default 1h. */
  cooldownMs: number;
}

/**
 * Defaults aligned with the 15m deploy-convergence grace (#1883): residual
 * becomes loud shortly after grace expires so an idle `behindCount≥1` cannot
 * sit for hours under a green health card.
 */
export const DEFAULT_DEPLOY_STALE_RESIDUAL_THRESHOLDS: Readonly<DeployStaleResidualThresholds> =
  Object.freeze({
    minBehindCount: 1,
    staleMs: 20 * 60_000,
    cooldownMs: 60 * 60_000,
  });

export type DeployStaleResidualAction = 'none' | 'alert' | 'recover';

export interface DeployStaleResidualInput {
  behindCount: number;
  /** True when a deploy is already in progress (status.deploying or local lock). */
  deploying: boolean;
  /**
   * When we first observed behindCount ≥ min AND !deploying for this episode,
   * or null if not currently in residual territory.
   */
  behindIdleSinceMs: number | null;
  /** Last time we fired a residual alert, or null. */
  lastAlertedAtMs: number | null;
  /** Whether an unrecovered residual episode is currently open. */
  firing: boolean;
  nowMs: number;
  thresholds?: Partial<DeployStaleResidualThresholds>;
}

export interface DeployStaleResidualResult {
  action: DeployStaleResidualAction;
  /** Next episode anchor to persist (null when not in residual territory). */
  nextBehindIdleSinceMs: number | null;
  /** Age of the current behind+idle episode, or null. */
  ageMs: number | null;
  /** True when residual is past the stale window (regardless of cooldown). */
  stale: boolean;
  /** Operator-facing one-liner. */
  message: string;
  thresholds: DeployStaleResidualThresholds;
}

/**
 * Pure residual decision for "behindCount>0 + deploying=false for T".
 *
 * Rules:
 * - behindCount < min OR deploying → leave residual territory (recover if firing)
 * - first observation in residual territory → start clock, no alert yet
 * - age ≥ staleMs and (not firing or cooldown elapsed) → alert
 * - age ≥ staleMs but inside cooldown while already firing → none (hold open)
 * - age < staleMs → none (still waiting)
 */
export function evaluateDeployStaleResidual(
  input: DeployStaleResidualInput,
): DeployStaleResidualResult {
  const thresholds: DeployStaleResidualThresholds = {
    ...DEFAULT_DEPLOY_STALE_RESIDUAL_THRESHOLDS,
    ...input.thresholds,
  };
  const behind = Number.isFinite(input.behindCount)
    ? Math.max(0, Math.floor(input.behindCount))
    : 0;
  const inTerritory = behind >= thresholds.minBehindCount && !input.deploying;

  if (!inTerritory) {
    if (input.firing) {
      return {
        action: 'recover',
        nextBehindIdleSinceMs: null,
        ageMs: null,
        stale: false,
        message: input.deploying
          ? `deploy in progress with behindCount=${behind} — residual clears on converge`
          : `behindCount=${behind} within bound — residual clear`,
        thresholds,
      };
    }
    return {
      action: 'none',
      nextBehindIdleSinceMs: null,
      ageMs: null,
      stale: false,
      message: input.deploying
        ? `deploying=true; residual idle clock paused (behindCount=${behind})`
        : `behindCount=${behind} below residual bound ${thresholds.minBehindCount}`,
      thresholds,
    };
  }

  const sinceMs =
    typeof input.behindIdleSinceMs === 'number' && Number.isFinite(input.behindIdleSinceMs)
      ? input.behindIdleSinceMs
      : input.nowMs;
  const ageMs = Math.max(0, input.nowMs - sinceMs);
  const stale = ageMs >= thresholds.staleMs;

  if (!stale) {
    return {
      action: 'none',
      nextBehindIdleSinceMs: sinceMs,
      ageMs,
      stale: false,
      message:
        `behindCount=${behind} deploying=false for ${formatAge(ageMs)} ` +
        `(stale after ${formatAge(thresholds.staleMs)})`,
      thresholds,
    };
  }

  // Past stale window. Fire if first page or cooldown elapsed.
  const lastAlerted = input.lastAlertedAtMs;
  const cooldownOk =
    lastAlerted == null ||
    !Number.isFinite(lastAlerted) ||
    input.nowMs - lastAlerted >= thresholds.cooldownMs;

  if (!input.firing || cooldownOk) {
    return {
      action: 'alert',
      nextBehindIdleSinceMs: sinceMs,
      ageMs,
      stale: true,
      message:
        `STALE DEPLOY: behindCount=${behind} with deploying=false for ${formatAge(ageMs)} ` +
        `(threshold ${formatAge(thresholds.staleMs)}) — auto-advance idle`,
      thresholds,
    };
  }

  return {
    action: 'none',
    nextBehindIdleSinceMs: sinceMs,
    ageMs,
    stale: true,
    message:
      `behindCount=${behind} still stale for ${formatAge(ageMs)}; ` +
      `residual already paged (cooldown ${formatAge(thresholds.cooldownMs)})`,
    thresholds,
  };
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
}
