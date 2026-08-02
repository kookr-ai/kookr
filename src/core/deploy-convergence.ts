// Deploy-convergence invariant (issue #1883).
//
// Merge velocity without deploy convergence is inventory, not throughput. A
// window can merge many kookr PRs and still serve pre-fix code if kookr-prod
// never advances past an old commit (#1883: on 2026-08-02 the live daemon was
// serving build `bec9bdcf` — 14 commits behind origin/main — while the
// queue-feeder levers #1849/#1855 that fix under-drive sat merged for hours).
// So a capacity diagnosis stays confounded: the operator can't tell "feeder not
// live" from "feeder live but empty backlog".
//
// This module is the pure classifier for the invariant: given the commit the
// serving process reports (probed over GET /api/health — the running server
// publishes the commit it was built from under `build.commitShort`, see
// buildRuntimeStatusSnapshot / the /api/health handler in
// src/server/routes/diagnostics-routes.ts), the target commit (origin/main
// HEAD), and whether the target is already included in the serving commit's
// ancestry, it decides whether prod has converged, is still inside the grace
// window, or has diverged long enough to be an incident. No I/O, no LLM, no git
// — the CLI (scripts/deploy-convergence-check.ts) gathers those and hands
// snapshots here. This mirrors lucy's deploy-convergence discipline (its #1842).

export interface ConvergenceThresholds {
  divergenceGraceMinutes: number;
}

/**
 * Explicit default grace window — documented in the deploy-convergence playbook.
 * Prod must include origin/main HEAD within this many minutes of the merge that
 * produced it; past that the divergence is treated as an incident, not lag.
 */
export const DEFAULT_CONVERGENCE_THRESHOLDS: Readonly<ConvergenceThresholds> = Object.freeze({
  divergenceGraceMinutes: 15,
});

/**
 * Normalize a commit SHA for comparison: trimmed, lowercased, hex only.
 * Returns null for anything that isn't a plausible SHA (empty, "unknown",
 * "dev", …). A dev build (`build.commitShort === 'dev'`) therefore normalizes to
 * null, which the probe treats as an un-checkable gap rather than a divergence.
 */
export function normalizeSha(sha: unknown): string | null {
  if (typeof sha !== 'string') return null;
  const trimmed = sha.trim().toLowerCase();
  if (!/^[0-9a-f]{4,40}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * True when two SHAs name the same commit, tolerating short-vs-full form by
 * comparing on the shorter length's prefix (git's own abbreviation rule).
 */
export function shasEqual(a: unknown, b: unknown): boolean {
  const na = normalizeSha(a);
  const nb = normalizeSha(b);
  if (!na || !nb) return false;
  const len = Math.min(na.length, nb.length);
  return na.slice(0, len) === nb.slice(0, len);
}

/**
 * Pull the serving commit SHA out of a GET /api/health body. Kookr already
 * publishes the commit the running server was built from in the `build` block
 * (`build.commitShort` / `build.commitHash`; see loadBuildInfo + the /api/health
 * handler). Falls back to top-level `sha`/`gitSha`/`commit` so a hand-built
 * snapshot or a differently-shaped health body still resolves.
 */
export function extractServingSha(health: unknown): string | null {
  if (!health || typeof health !== 'object') return null;
  const h = health as Record<string, unknown>;
  const build =
    h.build && typeof h.build === 'object' && !Array.isArray(h.build)
      ? (h.build as Record<string, unknown>)
      : null;
  if (build) {
    const fromBuild = normalizeSha(build.commitShort) || normalizeSha(build.commitHash);
    if (fromBuild) return fromBuild;
  }
  return normalizeSha(h.sha) || normalizeSha(h.gitSha) || normalizeSha(h.commit);
}

export interface DeliveryClassification {
  state: 'delivered' | 'merged' | 'unknown';
  delivered: boolean;
}

/**
 * Distinguish `merged` from `delivered` for a single commit/PR (#1883 AC): a
 * kookr PR is not "done" until the serving SHA includes its merge commit.
 * Callers that can compute git ancestry pass `servingIncludesCommit`; otherwise
 * this falls back to exact SHA identity (converged-on-HEAD is the common case).
 */
export function classifyDelivery({
  commitSha,
  servingSha,
  servingIncludesCommit = null,
}: {
  commitSha?: unknown;
  servingSha?: unknown;
  servingIncludesCommit?: boolean | null;
} = {}): DeliveryClassification {
  const commit = normalizeSha(commitSha);
  const serving = normalizeSha(servingSha);
  if (!commit || !serving) return { state: 'unknown', delivered: false };
  const included =
    servingIncludesCommit == null ? shasEqual(commit, serving) : Boolean(servingIncludesCommit);
  return included
    ? { state: 'delivered', delivered: true }
    : { state: 'merged', delivered: false };
}

export type ConvergenceState = 'converged' | 'diverging' | 'divergent' | 'unknown';
export type ConvergenceAction = 'none' | 'redeploy';

export interface ConvergenceResult {
  ok: boolean;
  state: ConvergenceState;
  converged: boolean;
  diverging: boolean;
  divergent: boolean;
  servingSha: string | null;
  targetSha: string | null;
  divergenceSince: string | null;
  divergenceAgeMinutes: number | null;
  graceMinutes: number;
  action: ConvergenceAction;
  message: string;
  thresholds: ConvergenceThresholds;
  evaluatedAt: string;
}

export interface ConvergenceBaseline {
  targetSha?: string | null;
  divergenceSince?: string | null;
}

/**
 * Evaluate the convergence invariant.
 *
 * `servingIncludesTarget` answers the real invariant — "does the commit prod is
 * serving include origin/main HEAD in its ancestry?" — which only git can decide
 * (the CLI runs `git merge-base --is-ancestor`). Identical SHAs short-circuit to
 * converged so the check works even before ancestry is available.
 *
 * Divergence age is measured from the merge itself when `targetCommittedAtMs` is
 * known (so "within N minutes of any merged kookr PR" holds even across check
 * downtime), falling back to the first tick that observed this divergence via
 * the persisted `previous` baseline.
 */
export function evaluateConvergence({
  servingSha,
  targetSha,
  servingIncludesTarget = null,
  targetCommittedAtMs = null,
  previous = null,
  thresholds: thresholdOverrides = {},
  nowMs = Date.now(),
}: {
  servingSha?: unknown;
  targetSha?: unknown;
  servingIncludesTarget?: boolean | null;
  targetCommittedAtMs?: number | null;
  previous?: ConvergenceBaseline | null;
  thresholds?: Partial<ConvergenceThresholds>;
  nowMs?: number;
} = {}): ConvergenceResult {
  const thresholds: ConvergenceThresholds = {
    ...DEFAULT_CONVERGENCE_THRESHOLDS,
    ...thresholdOverrides,
  };
  const graceMinutes = thresholds.divergenceGraceMinutes;
  const evaluatedAt = new Date(nowMs).toISOString();
  const serving = normalizeSha(servingSha);
  const target = normalizeSha(targetSha);

  const base = {
    servingSha: serving,
    targetSha: target,
    graceMinutes,
    thresholds,
    evaluatedAt,
  };

  // Probe gap: without both SHAs we can't assert the invariant either way. This
  // is an operational error (report/exit-1 in the CLI), not a converged state.
  if (!serving || !target) {
    return {
      ...base,
      ok: false,
      state: 'unknown',
      converged: false,
      diverging: false,
      divergent: false,
      divergenceSince: null,
      divergenceAgeMinutes: null,
      action: 'none',
      message: `convergence unknown: ${!serving ? 'serving' : 'target'} SHA unavailable (serving=${serving || 'null'} target=${target || 'null'})`,
    };
  }

  const converged =
    shasEqual(serving, target) ||
    (servingIncludesTarget == null ? false : Boolean(servingIncludesTarget));

  if (converged) {
    return {
      ...base,
      ok: true,
      state: 'converged',
      converged: true,
      diverging: false,
      divergent: false,
      divergenceSince: null,
      divergenceAgeMinutes: null,
      action: 'none',
      message: `prod serving ${serving} includes origin/main ${target} — converged`,
    };
  }

  // Diverged. Anchor the clock to the merge commit time when known, else to the
  // first tick that saw this exact divergence (persisted baseline), else now.
  const sameTargetAsBaseline =
    previous && shasEqual(previous.targetSha, target) && previous.divergenceSince;
  const baselineSinceMs = sameTargetAsBaseline
    ? Date.parse(previous.divergenceSince as string)
    : NaN;
  let startMs: number;
  if (typeof targetCommittedAtMs === 'number' && Number.isFinite(targetCommittedAtMs)) {
    startMs = targetCommittedAtMs;
  } else if (Number.isFinite(baselineSinceMs)) {
    startMs = baselineSinceMs;
  } else {
    startMs = nowMs;
  }
  const divergenceAgeMs = Math.max(0, nowMs - startMs);
  const divergenceAgeMinutes = Math.round(divergenceAgeMs / 60_000);
  const divergent = divergenceAgeMs >= graceMinutes * 60_000;

  return {
    ...base,
    ok: true,
    state: divergent ? 'divergent' : 'diverging',
    converged: false,
    diverging: !divergent,
    divergent,
    divergenceSince: new Date(startMs).toISOString(),
    divergenceAgeMinutes,
    action: divergent ? 'redeploy' : 'none',
    message: divergent
      ? `DIVERGENT: prod serving ${serving} is missing origin/main ${target}, diverged ${divergenceAgeMinutes}m (grace ${graceMinutes}m) — redeploy`
      : `diverging: prod serving ${serving} not yet on origin/main ${target}, ${divergenceAgeMinutes}m into ${graceMinutes}m grace`,
  };
}

export interface PersistedConvergenceBaseline {
  evaluatedAt: string;
  servingSha: string | null;
  targetSha: string | null;
  state: ConvergenceState;
  divergenceSince: string | null;
}

/**
 * Baseline to persist between ticks so divergence age can accrue from the first
 * observation when the merge commit time isn't available.
 */
export function buildConvergenceBaseline(result: ConvergenceResult): PersistedConvergenceBaseline {
  return {
    evaluatedAt: result.evaluatedAt,
    servingSha: result.servingSha,
    targetSha: result.targetSha,
    state: result.state,
    // Only meaningful while diverged; converged ticks clear it so the next
    // divergence starts a fresh clock.
    divergenceSince: result.converged ? null : result.divergenceSince,
  };
}

/**
 * Compact one-line receipt for logs / playbook state.
 */
export function formatConvergenceReceipt(result: ConvergenceResult): string {
  if (!result.ok) return `deploy-convergence: unknown · ${result.message}`;
  if (result.converged) {
    return `deploy-convergence: converged · serving=${result.servingSha} main=${result.targetSha}`;
  }
  const tag = result.divergent ? 'DIVERGENT' : 'diverging';
  return `deploy-convergence: ${tag} · serving=${result.servingSha} main=${result.targetSha} age=${result.divergenceAgeMinutes}m grace=${result.graceMinutes}m action=${result.action}`;
}
