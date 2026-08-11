/**
 * Discord/operator page when hungSuspect residual stays high after the TTL
 * reclaim window (issue #1993).
 *
 * The hungSuspect TTL reclaim (#1935) already terminates aged silent tasks on
 * the liveness tick. When residual occupancy remains high afterward (reclaim
 * could not free enough slots — human-gated exemptions, false negatives, or
 * fresh hangs), unattended operators offline on Discord get no page.
 *
 * This module is **page-only**: it never terminates extra tasks. It evaluates
 * residual count after each reclaim and:
 *
 * - fires an operational alert (key `hung:residual`) once residual has stayed
 *   ≥ N without decreasing for M minutes;
 * - re-pages at most once per cooldown while residual remains high;
 * - emits a matching `recovered` clear when hungSuspect returns to 0;
 * - includes last-pass skip-reason dominance + sample task ids so remote
 *   operators can heal without `/api/health` spelunking (issue #2232).
 *
 * Wire via detectorBroadcast (index.ts) so the operational-alert bridge
 * spools operator signals to Discord (issue #1716).
 */

import type { ServerMessage } from '../shared/contracts/messages.js';
import { DEFAULT_HUNG_SUSPECT_CAPACITY_COUNT_BOUND } from '../core/capacity-ledger.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/** Operational-alert / operator-signal key (issue #1993, offline recovery card). */
export const HUNG_RESIDUAL_ALERT_KEY = 'hung:residual' as const;

export const HUNG_RESIDUAL_METRIC = 'hung_suspect_residual' as const;

/**
 * Minimum residual hungSuspect count before paging. Reuses the capacity-finding
 * absolute bound (default 3) so health findings and Discord pages agree.
 */
export const DEFAULT_HUNG_RESIDUAL_COUNT_BOUND = DEFAULT_HUNG_SUSPECT_CAPACITY_COUNT_BOUND;

/**
 * How long residual must stay ≥ bound without decreasing before the first
 * page. Default 30m sits just above the hungSuspect TTL (25m) so reclaim has
 * had a full window to act before we page noise from legitimate long tools.
 */
export const DEFAULT_HUNG_RESIDUAL_STALE_MS = 30 * 60_000;

/** Re-page cooldown while residual remains high (default 1h). */
export const DEFAULT_HUNG_RESIDUAL_COOLDOWN_MS = 60 * 60_000;

/** Cap sample task ids in the Discord page body (issue #2232). */
export const HUNG_RESIDUAL_SAMPLE_TASK_ID_CAP = 5;

/**
 * Display label for the open-PR fail-safe skip family (confirmed + unknown +
 * legacy). Matches doctor / health vocabulary so operators can cross-check
 * `kookr doctor` and `GET /api/health`.
 */
export const OPEN_PR_FAILSAFE_DOMINANT_LABEL = 'open_pr_failsafe' as const;

export interface HungSuspectResidualAlerterDeps {
  /**
   * Broadcast path — prefer `detectorBroadcast` so fire/clear edges spool to
   * the operator-signal outbox (Discord). Must not throw.
   */
  broadcast: (msg: ServerMessage) => void;
  /** Live residual count bound. Falls back to {@link DEFAULT_HUNG_RESIDUAL_COUNT_BOUND}. */
  getCountBound?: () => number;
  /** Live stale window (ms). Falls back to {@link DEFAULT_HUNG_RESIDUAL_STALE_MS}. */
  getStaleMs?: () => number;
  /** Live re-page cooldown (ms). Falls back to {@link DEFAULT_HUNG_RESIDUAL_COOLDOWN_MS}. */
  getCooldownMs?: () => number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** One last-pass reclaim candidate (mirrors hungSuspectTtlReclaim.lastOutcomes). */
export interface HungResidualOutcomeSample {
  taskId: string;
  outcome: string;
}

export interface EvaluateHungResidualInput {
  /** Current hungSuspect count after this tick's reclaim. */
  residualCount: number;
  /** Tasks reclaimed this tick (informational; in details only). */
  reclaimedCount?: number;
  /**
   * Last reclaim pass per-candidate outcomes (issue #2232). When present the
   * page names the dominant skip reason and sample task ids so Discord-limited
   * operators can heal (refresh GitHub PR state vs close stranded PRs).
   */
  lastOutcomes?: ReadonlyArray<HungResidualOutcomeSample>;
}

export interface HungSuspectResidualAlerterStats {
  /** True while an unrecovered residual episode is open. */
  firing: boolean;
  /** Residual count last observed. */
  lastCount: number;
  /** When residual first hit the bound without a later decrease, or null. */
  residualHighSinceMs: number | null;
  /** When the last fire/re-page was emitted, or null. */
  lastAlertedAtMs: number | null;
}

/**
 * Collapse open-PR fail-safe outcome variants into one dominance bucket.
 * Issue #2228 split confirmed vs unknown; #2232 pages on the family.
 * Legacy `skipped_open_pr_failsafe` kept for older health snapshots.
 */
export function isOpenPrFailsafeOutcome(outcome: string): boolean {
  return (
    outcome === 'skipped_open_pr_failsafe'
    || outcome === 'skipped_open_pr_confirmed'
    || outcome === 'skipped_open_pr_unknown'
  );
}

/**
 * Last-pass open_pr fail-safe dominates when it is the plurality among
 * `lastOutcomes` (ties for first still count — residual is still held by the
 * fail-safe). Empty last pass → not dominated (cannot attribute residual yet).
 *
 * Same threshold as `kookr doctor` ops.hung-reclaim (issue #2231 / #2232).
 */
export function isOpenPrFailsafeDominatedLastPass(
  lastOutcomes: ReadonlyArray<{ outcome: string }>,
): boolean {
  if (lastOutcomes.length === 0) return false;
  let openPr = 0;
  const otherCounts = new Map<string, number>();
  for (const entry of lastOutcomes) {
    if (isOpenPrFailsafeOutcome(entry.outcome)) {
      openPr += 1;
      continue;
    }
    otherCounts.set(entry.outcome, (otherCounts.get(entry.outcome) ?? 0) + 1);
  }
  if (openPr === 0) return false;
  const maxOther = otherCounts.size === 0
    ? 0
    : Math.max(...otherCounts.values());
  return openPr >= maxOther;
}

export interface HungResidualSkipBreakdown {
  /** Outcomes considered this pass (denominator). */
  total: number;
  /**
   * Dominant skip/selected label for the page. Open-PR family collapses to
   * {@link OPEN_PR_FAILSAFE_DOMINANT_LABEL}. Null when lastOutcomes empty.
   */
  dominantReason: string | null;
  /** Count for {@link dominantReason} (open-PR family summed when applicable). */
  dominantCount: number;
  /** True when open_pr fail-safe is the plurality (ties count). */
  openPrFailsafeDominated: boolean;
  /** Aggregate open-PR family count this pass. */
  openPrFailsafeCount: number;
  /**
   * Sample task ids for the dominant bucket (prefer open-PR holds when that
   * family dominates). Capped at {@link HUNG_RESIDUAL_SAMPLE_TASK_ID_CAP}.
   */
  sampleTaskIds: string[];
  /** Per-label counts after open-PR collapse (for tests / diagnostics). */
  counts: Record<string, number>;
}

/**
 * Summarize last-pass reclaim outcomes for the residual page (issue #2232).
 * Pure — no I/O, never terminates tasks.
 */
export function summarizeHungResidualSkipBreakdown(
  lastOutcomes: ReadonlyArray<HungResidualOutcomeSample> | undefined,
): HungResidualSkipBreakdown {
  const outcomes = lastOutcomes ?? [];
  const counts = new Map<string, number>();
  const taskIdsByLabel = new Map<string, string[]>();

  for (const entry of outcomes) {
    const label = isOpenPrFailsafeOutcome(entry.outcome)
      ? OPEN_PR_FAILSAFE_DOMINANT_LABEL
      : entry.outcome;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (entry.taskId) {
      const ids = taskIdsByLabel.get(label) ?? [];
      if (ids.length < HUNG_RESIDUAL_SAMPLE_TASK_ID_CAP && !ids.includes(entry.taskId)) {
        ids.push(entry.taskId);
        taskIdsByLabel.set(label, ids);
      }
    }
  }

  const total = outcomes.length;
  const openPrFailsafeCount = counts.get(OPEN_PR_FAILSAFE_DOMINANT_LABEL) ?? 0;
  const openPrFailsafeDominated = isOpenPrFailsafeDominatedLastPass(outcomes);

  let dominantReason: string | null = null;
  let dominantCount = 0;
  for (const [label, count] of counts) {
    if (
      count > dominantCount
      || (count === dominantCount && label === OPEN_PR_FAILSAFE_DOMINANT_LABEL)
    ) {
      dominantReason = label;
      dominantCount = count;
    }
  }

  // When open_pr is plurality (including ties), prefer that label even if a
  // lexicographically later non-open_pr bucket tied in the loop above.
  if (openPrFailsafeDominated) {
    dominantReason = OPEN_PR_FAILSAFE_DOMINANT_LABEL;
    dominantCount = openPrFailsafeCount;
  }

  const sampleTaskIds = dominantReason
    ? [...(taskIdsByLabel.get(dominantReason) ?? [])]
    : [];

  const countsRecord: Record<string, number> = {};
  for (const [label, count] of counts) countsRecord[label] = count;

  return {
    total,
    dominantReason,
    dominantCount,
    openPrFailsafeDominated,
    openPrFailsafeCount,
    sampleTaskIds,
    counts: countsRecord,
  };
}

/**
 * Edge-triggered residual page after hungSuspect TTL reclaim (issue #1993).
 * Holds episode state in process memory — a restart resets the wait window
 * (same trade-off as schedule dead-man / lesson-spool alerts).
 */
export class HungSuspectResidualAlerter {
  private firing = false;
  private residualHighSinceMs: number | null = null;
  private lastCount = 0;
  private lastAlertedAtMs: number | null = null;
  private readonly deps: HungSuspectResidualAlerterDeps;

  constructor(deps: HungSuspectResidualAlerterDeps) {
    this.deps = deps;
  }

  /**
   * Evaluate residual after reclaim. Page-only — never mutates tasks.
   * Safe to call every liveness tick.
   */
  evaluate(input: EvaluateHungResidualInput): void {
    const nowMs = this.deps.now?.() ?? Date.now();
    const bound = this.resolveCountBound();
    const residual = Math.max(0, Math.floor(input.residualCount));
    const reclaimed = Math.max(0, Math.floor(input.reclaimedCount ?? 0));

    if (residual === 0) {
      if (this.firing) {
        this.emit(buildHungResidualRecoveryAlert());
      }
      this.firing = false;
      this.residualHighSinceMs = null;
      this.lastCount = 0;
      // lastAlertedAtMs is retained for diagnostics only. After clear, a new
      // episode must wait a full stale window before paging again (!firing
      // short-circuits the cooldown gate on the next fire).
      return;
    }

    if (residual < bound) {
      // Below page threshold but not zero: do not fire; do not clear (clear is
      // only at 0). Reset the high-since clock so a later climb to ≥bound must
      // wait a full stale window again.
      this.residualHighSinceMs = null;
      this.lastCount = residual;
      return;
    }

    // residual ≥ bound
    if (
      this.residualHighSinceMs === null
      || residual < this.lastCount
    ) {
      // Fresh high period, or reclaim/other action reduced residual — restart
      // the "did not reduce for M minutes" clock.
      this.residualHighSinceMs = nowMs;
    }
    this.lastCount = residual;

    const staleMs = this.resolveStaleMs();
    if (nowMs - this.residualHighSinceMs < staleMs) {
      return;
    }

    const cooldownMs = this.resolveCooldownMs();
    const canPage =
      !this.firing
      || this.lastAlertedAtMs === null
      || nowMs - this.lastAlertedAtMs >= cooldownMs;
    if (!canPage) return;

    this.firing = true;
    this.lastAlertedAtMs = nowMs;
    this.emit(
      buildHungResidualAlert({
        residualCount: residual,
        countBound: bound,
        staleMs,
        reclaimedCount: reclaimed,
        lastOutcomes: input.lastOutcomes,
      }),
    );
  }

  /** Observable episode state for tests / diagnostics. */
  stats(): HungSuspectResidualAlerterStats {
    return {
      firing: this.firing,
      lastCount: this.lastCount,
      residualHighSinceMs: this.residualHighSinceMs,
      lastAlertedAtMs: this.lastAlertedAtMs,
    };
  }

  private emit(alert: Extract<ServerMessage, { type: 'alert' }>): void {
    try {
      this.deps.broadcast(alert);
    } catch (err) {
      console.warn(
        '[hung-suspect-residual] broadcast threw (ignored):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private resolveCountBound(): number {
    const value = this.deps.getCountBound?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
      return Math.floor(value);
    }
    return DEFAULT_HUNG_RESIDUAL_COUNT_BOUND;
  }

  private resolveStaleMs(): number {
    const value = this.deps.getStaleMs?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    return DEFAULT_HUNG_RESIDUAL_STALE_MS;
  }

  private resolveCooldownMs(): number {
    const value = this.deps.getCooldownMs?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    return DEFAULT_HUNG_RESIDUAL_COOLDOWN_MS;
  }
}

export function buildHungResidualAlert(args: {
  residualCount: number;
  countBound: number;
  staleMs: number;
  reclaimedCount: number;
  lastOutcomes?: ReadonlyArray<HungResidualOutcomeSample>;
}): Extract<ServerMessage, { type: 'alert' }> {
  const staleMin = Math.round(args.staleMs / 60_000);
  const breakdown = summarizeHungResidualSkipBreakdown(args.lastOutcomes);
  const skipContext = formatSkipContextForPage(breakdown);
  const openPrNote = breakdown.openPrFailsafeDominated
    ? ' open_pr_failsafe-dominated'
    : '';

  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary:
      `hungSuspect residual high: ${args.residualCount} task(s) still hung after TTL reclaim window`
      + openPrNote,
    details:
      `Issue #1993/#2232: hungSuspect residual stayed ≥ ${args.countBound} for ≥ ${staleMin}m `
      + `without decreasing after the hungSuspect TTL reclaim (#1935). `
      + `Current residual=${args.residualCount}; reclaimed this tick=${args.reclaimedCount}. `
      + `${skipContext} `
      + 'Page only — no extra terminations. '
      + (breakdown.openPrFailsafeDominated
        ? 'Heal: refresh GitHub PR state for residual task ids, or complete/merge/cancel stranded open-PR work so fail-safe releases slots. '
        : 'Free slots manually (complete/cancel dead tasks) or inspect exemptions (needs_input, permission_blocked, open PR, provider pause). ')
      + 'Health: GET /api/health → hungSuspectTtlReclaim.lastOutcomes / capacity.byClass.hungSuspect.',
    severity: 'warning',
    operationalAlert: {
      key: HUNG_RESIDUAL_ALERT_KEY,
      metric: HUNG_RESIDUAL_METRIC,
      state: 'fired',
    },
  };
}

/** Format skip dominance + sample task ids for the page body (issue #2232). */
export function formatSkipContextForPage(breakdown: HungResidualSkipBreakdown): string {
  if (breakdown.total === 0 || breakdown.dominantReason === null) {
    return 'Last reclaim pass had no lastOutcomes (cannot attribute skip reason yet).';
  }
  const sample = breakdown.sampleTaskIds.length > 0
    ? ` Sample task ids: ${breakdown.sampleTaskIds.join(', ')}.`
    : '';
  return (
    `Dominant skip reason: ${breakdown.dominantReason} `
    + `(${breakdown.dominantCount}/${breakdown.total} last pass).`
    + sample
  );
}

export function buildHungResidualRecoveryAlert(): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: 'Recovered: hungSuspect residual cleared',
    details:
      'hungSuspect count returned to 0 after a residual-high episode. '
      + 'Capacity slots held by hung-suspect tasks are free again.',
    severity: 'info',
    operationalAlert: {
      key: HUNG_RESIDUAL_ALERT_KEY,
      metric: HUNG_RESIDUAL_METRIC,
      state: 'recovered',
    },
  };
}
