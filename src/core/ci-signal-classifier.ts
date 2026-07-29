/**
 * CI-signal-absent classifier and merge gate (issue #1688).
 *
 * During the 2026-07-28→29 window GitHub Actions was billing-blocked at the
 * account level: every CI run failed in ~3s with 0 steps executed. Despite CI
 * producing *no verification signal*, the merge path merged ~41 PRs — treating
 * *absence of signal* as *bypassable noise*. The merge path had no degraded
 * mode: it either blocked forever or merged blind.
 *
 * This module is the pure, durable core of the fix. It draws a distinction the
 * old red/green view could not:
 *
 *   - `ci-passed`        — CI ran and the run is green (or benignly skipped).
 *   - `ci-failed`        — CI ran your code and it went red. A real result.
 *   - `ci-signal-absent` — CI produced *no* verification signal at all: the job
 *                          never executed (billing/spending-limit block, runner
 *                          startup failure), 0 steps ran, or the run finished
 *                          below a duration floor without succeeding. This is
 *                          NOT a pass and NOT a bypassable red — it is the
 *                          absence of information.
 *
 * {@link classifyCiSignal} detects the signal-absent regime by *class*, not by
 * red/green. {@link decideMergeGate} then flips merge policy to graceful
 * degradation: under `ci-signal-absent` a PR merges only after the repo's own
 * test suite passes locally in the worktree, and that merge is tagged
 * {@link VERIFIED_LOCALLY_LABEL} and handed to the retro-verify queue (#1689)
 * so it is re-checked once CI capacity returns. It never merges on absent
 * signal alone.
 *
 * The concrete wiring — reading a live GitHub run into a {@link CiRunObservation},
 * running the local suite, attaching the label, and enqueuing into the
 * retro-verify queue — lives in the daemon/merge path and is injected by the
 * caller, the same durable-core / wiring split as the retro-verify queue
 * (#1689) and the environment-blocker registry (#1690).
 */

/** The three signal classes a completed CI run maps to. */
export type CiSignalClass = 'ci-passed' | 'ci-failed' | 'ci-signal-absent';

/**
 * GitHub check/run conclusions, plus `startup_failure` — the conclusion GitHub
 * reports when the runner never started the job (the billing-block case), which
 * is not in the narrower {@link import('./github-types.js').GitHubCheck}
 * conclusion union.
 */
export type CiConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'timed_out'
  | 'skipped'
  | 'startup_failure'
  | 'action_required'
  | null;

/**
 * A completed CI run reduced to the fields that decide its signal class. The
 * caller derives these from `gh` (statusCheckRollup, run timing, job steps, and
 * annotations); every field beyond `conclusion` is optional because different
 * providers surface different subsets.
 */
export interface CiRunObservation {
  /** Overall conclusion as reported by the provider. `null` when unknown. */
  conclusion: CiConclusion;
  /** Wall-clock run duration in seconds. `undefined` when unknown. */
  durationSeconds?: number;
  /**
   * Number of steps that actually executed across the run's jobs. `0` is the
   * fingerprint of a job that never really ran (billing block, startup
   * failure). `undefined` when the provider did not report step counts.
   */
  stepsExecuted?: number;
  /**
   * Free-text annotations attached to the run — failure annotations, and
   * critically the account-level billing/spending-limit notice GitHub emits
   * when a run is blocked before execution.
   */
  annotations?: string[];
}

/** The verdict of classifying one CI run. */
export interface CiSignalClassification {
  class: CiSignalClass;
  /** Convenience: `true` iff `class === 'ci-signal-absent'`. */
  signalAbsent: boolean;
  /** Short, machine-and-human-readable reason for the classification. */
  reason: string;
}

/** Tuning knobs for {@link classifyCiSignal}. */
export interface ClassifyCiSignalOptions {
  /**
   * A run that finishes at or below this many seconds without succeeding is
   * treated as signal-absent — real CI that runs a test suite takes longer,
   * so a sub-floor non-success is the fingerprint of a run that never executed
   * your code. Default {@link DEFAULT_CI_DURATION_FLOOR_SECONDS}.
   */
  durationFloorSeconds?: number;
}

/** Default sub-floor duration (seconds) below which a non-success run is signal-absent. */
export const DEFAULT_CI_DURATION_FLOOR_SECONDS = 10;

/**
 * Matches the account-level annotations that mean "the run was blocked before
 * it executed", not "your code failed". Deliberately broad: GitHub's exact
 * wording ("recent account payments have failed", "spending limit needs to be
 * increased") varies, and the same regime shows up as generic
 * billing/payment/quota notices.
 */
const BILLING_ANNOTATION_RE =
  /spending limit|recent account payments|account payment|billing|payment (?:has |method )?fail|exceeded (?:your |the )?(?:included )?(?:quota|minutes)|out of (?:credit|minutes)|not started because/i;

function hasBillingAnnotation(annotations: string[] | undefined): boolean {
  if (!annotations) return false;
  return annotations.some((a) => BILLING_ANNOTATION_RE.test(a));
}

/**
 * Classify a completed CI run into one of {@link CiSignalClass}.
 *
 * Signal-absent triggers are checked *first* and take priority over the run's
 * red/green conclusion — a billing-blocked run typically reports `failure`, yet
 * it carries no verification signal and must not be treated as an ordinary red.
 * The triggers, any of which is sufficient:
 *   1. An account-level billing/spending-limit annotation.
 *   2. `stepsExecuted === 0` — the job never really ran.
 *   3. `conclusion === 'startup_failure'` — the runner never started the job.
 *   4. A sub-floor duration paired with a non-success conclusion (a fast green
 *      run genuinely passed, so success is never downgraded on duration alone).
 *
 * Otherwise: `success`/`skipped`/`neutral` → `ci-passed`; everything else
 * (including a `null`/unknown conclusion) → `ci-failed`.
 */
export function classifyCiSignal(
  obs: CiRunObservation,
  opts: ClassifyCiSignalOptions = {},
): CiSignalClassification {
  const floor = opts.durationFloorSeconds ?? DEFAULT_CI_DURATION_FLOOR_SECONDS;
  const isSuccess = obs.conclusion === 'success';

  if (hasBillingAnnotation(obs.annotations)) {
    return {
      class: 'ci-signal-absent',
      signalAbsent: true,
      reason: 'account-level billing/spending-limit annotation — run never executed',
    };
  }
  if (obs.stepsExecuted === 0) {
    return {
      class: 'ci-signal-absent',
      signalAbsent: true,
      reason: '0 steps executed — job never ran',
    };
  }
  if (obs.conclusion === 'startup_failure') {
    return {
      class: 'ci-signal-absent',
      signalAbsent: true,
      reason: 'runner startup failure — job never started',
    };
  }
  if (
    !isSuccess &&
    typeof obs.durationSeconds === 'number' &&
    obs.durationSeconds <= floor
  ) {
    return {
      class: 'ci-signal-absent',
      signalAbsent: true,
      reason: `run finished in ${obs.durationSeconds}s (<= ${floor}s floor) without succeeding — no signal`,
    };
  }

  if (isSuccess || obs.conclusion === 'skipped' || obs.conclusion === 'neutral') {
    return {
      class: 'ci-passed',
      signalAbsent: false,
      reason: `conclusion=${obs.conclusion}`,
    };
  }

  return {
    class: 'ci-failed',
    signalAbsent: false,
    reason: `conclusion=${obs.conclusion ?? 'null'}`,
  };
}

/** The label attached to a merge that was gated on local verification. */
export const VERIFIED_LOCALLY_LABEL = 'verified-locally';

/** Result of running the repo's own suite locally in the worktree. */
export interface LocalVerification {
  /** Whether the local suite was actually run. */
  ran: boolean;
  /** Whether it passed. Only meaningful when `ran` is `true`. */
  passed: boolean;
  /** Optional summary (command, failing test name) for the finding. */
  summary?: string;
}

/** The action {@link decideMergeGate} directs the caller to take. */
export type MergeGateAction =
  /** CI is green — merge normally. */
  | 'merge'
  /** Signal-absent CI, local suite green — merge tagged `verified-locally`. */
  | 'merge-verified-locally'
  /** CI ran and went red — do not merge. */
  | 'block-ci-failed'
  /** Signal-absent CI and no local verification supplied — run the local suite first. */
  | 'block-local-required'
  /** Signal-absent CI and the local suite failed — do not merge. */
  | 'block-local-failed';

/** The merge-gate decision for one PR. */
export interface MergeGateDecision {
  action: MergeGateAction;
  /** Whether the caller may merge now. */
  merge: boolean;
  /** Label to attach on merge (only set for `merge-verified-locally`). */
  label?: string;
  /**
   * Whether this merge must be enqueued into the retro-verify queue (#1689) so
   * it is re-checked when CI capacity returns. True only for a locally-verified
   * merge made under signal-absent CI.
   */
  enqueueRetroVerify: boolean;
  /** Finding surfaced when the merge is blocked or degraded; unset on a clean merge. */
  finding?: string;
  reason: string;
}

/**
 * Decide the merge gate for a PR, given its CI signal class and (when CI is
 * signal-absent) the result of running the local suite.
 *
 * The gate never merges on *absent* signal alone:
 *   - `ci-passed`        → merge.
 *   - `ci-failed`        → block, surface a finding. Never merge over a real red.
 *   - `ci-signal-absent` → require a local gate. Merge (tagged
 *                          {@link VERIFIED_LOCALLY_LABEL}, enqueued for
 *                          retro-verify) only when the local suite passed;
 *                          otherwise block and surface a finding.
 */
export function decideMergeGate(input: {
  ci: CiSignalClassification;
  local?: LocalVerification;
}): MergeGateDecision {
  const { ci, local } = input;

  if (ci.class === 'ci-passed') {
    return {
      action: 'merge',
      merge: true,
      enqueueRetroVerify: false,
      reason: `CI passed (${ci.reason})`,
    };
  }

  if (ci.class === 'ci-failed') {
    return {
      action: 'block-ci-failed',
      merge: false,
      enqueueRetroVerify: false,
      finding: `CI failed (${ci.reason}) — not merging over a real red check.`,
      reason: `CI failed (${ci.reason})`,
    };
  }

  // ci.class === 'ci-signal-absent'
  if (!local || !local.ran) {
    return {
      action: 'block-local-required',
      merge: false,
      enqueueRetroVerify: false,
      finding:
        `CI produced no verification signal (${ci.reason}). ` +
        'Run the repo test suite locally in the worktree before merging — absent signal is never a pass.',
      reason: `signal-absent, local verification not run (${ci.reason})`,
    };
  }

  if (local.passed) {
    return {
      action: 'merge-verified-locally',
      merge: true,
      label: VERIFIED_LOCALLY_LABEL,
      enqueueRetroVerify: true,
      reason: `signal-absent CI, local suite passed — merging as ${VERIFIED_LOCALLY_LABEL} (${ci.reason})`,
    };
  }

  return {
    action: 'block-local-failed',
    merge: false,
    enqueueRetroVerify: false,
    finding:
      `CI produced no signal (${ci.reason}) and the local suite failed` +
      (local.summary ? `: ${local.summary}` : '') +
      ' — not merging.',
    reason: `signal-absent CI, local suite failed (${ci.reason})`,
  };
}
