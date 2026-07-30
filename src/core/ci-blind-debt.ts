/**
 * CI-blind-merge debt metric (issue #1703).
 *
 * While CI is signal-absent, merges can land via local verification (#1688) and
 * land in the retro-verify queue (#1689). Until that queue drains, `main` carries
 * unverified debt. This module turns the queue into a first-class metric
 * (`ci_blind_debt`) so operators and daily reports can see depth, age, and
 * per-repo concentration — and so the emission budget can withhold new feature
 * filings until verification debt is under a threshold.
 *
 * Pure: call with the entries already loaded from the retro-verify spool (or
 * any synthetic list in tests). No filesystem I/O here.
 */

import type { RetroVerifyEntry } from './retro-verify-queue.js';

export const CI_BLIND_DEBT_SCHEMA = 'ci-blind-debt.v1' as const;

/** Sample size kept on the status surface (bounded for /api/health payloads). */
export const DEFAULT_CI_BLIND_DEBT_SAMPLE_SIZE = 5;

export interface CiBlindDebtSample {
  sha: string;
  prNumber: number;
  repo: string;
  reason: string;
  createdAt: string;
  verifyFailed?: boolean;
}

/**
 * First-class metric: blind-merge inventory still awaiting retro-verification
 * (or awaiting P1 filing after a failed re-verify).
 */
export interface CiBlindDebt {
  schemaVersion: typeof CI_BLIND_DEBT_SCHEMA;
  /**
   * Count of merged commits still in the retro-verify queue. Equals
   * {@link queueDepth}; kept as an explicit field so daily reports and status
   * surfaces can name both halves of the acceptance criterion
   * ("blind-merge count + retro-verify queue depth").
   */
  blindMergeCount: number;
  /** Pending retro-verify queue depth (same population as blindMergeCount). */
  queueDepth: number;
  /** Subset already known-bad, waiting only on P1 filing. */
  verifyFailedCount: number;
  /** Age of the oldest pending entry in ms, when the queue is non-empty. */
  oldestAgeMs?: number;
  /** ISO timestamp of the oldest pending entry, when present. */
  oldestCreatedAt?: string;
  /** Per-repo pending counts (owner/repo → depth). */
  byRepo: Record<string, number>;
  /** Small sample of oldest entries for operator visibility. */
  sample: CiBlindDebtSample[];
  /** Wall-clock this snapshot was computed. */
  generatedAt: string;
}

/**
 * Build a {@link CiBlindDebt} snapshot from the current retro-verify queue.
 * Entries are treated as already-bounded/deduped by the queue reader.
 */
export function computeCiBlindDebt(
  entries: readonly RetroVerifyEntry[],
  opts: {
    now?: Date;
    sampleSize?: number;
  } = {},
): CiBlindDebt {
  const nowMs = (opts.now ?? new Date()).getTime();
  const sampleSize = Math.max(0, Math.floor(opts.sampleSize ?? DEFAULT_CI_BLIND_DEBT_SAMPLE_SIZE));
  const sorted = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const queueDepth = sorted.length;
  let verifyFailedCount = 0;
  const byRepo: Record<string, number> = {};

  for (const e of sorted) {
    if (e.verifyFailed) verifyFailedCount += 1;
    byRepo[e.repo] = (byRepo[e.repo] ?? 0) + 1;
  }

  let oldestAgeMs: number | undefined;
  let oldestCreatedAt: string | undefined;
  if (sorted.length > 0) {
    const oldest = sorted[0]!;
    oldestCreatedAt = oldest.createdAt;
    const createdMs = Date.parse(oldest.createdAt);
    if (Number.isFinite(createdMs)) {
      oldestAgeMs = Math.max(0, nowMs - createdMs);
    }
  }

  const sample: CiBlindDebtSample[] = sorted.slice(0, sampleSize).map((e) => ({
    sha: e.sha,
    prNumber: e.prNumber,
    repo: e.repo,
    reason: e.reason,
    createdAt: e.createdAt,
    ...(e.verifyFailed ? { verifyFailed: true } : {}),
  }));

  return {
    schemaVersion: CI_BLIND_DEBT_SCHEMA,
    blindMergeCount: queueDepth,
    queueDepth,
    verifyFailedCount,
    ...(oldestAgeMs !== undefined ? { oldestAgeMs } : {}),
    ...(oldestCreatedAt !== undefined ? { oldestCreatedAt } : {}),
    byRepo,
    sample,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * One-line audit / daily-report signal for ci_blind_debt. Always present so a
 * zero-debt day is still an explicit observation, not a missing field.
 */
export function formatCiBlindDebtLogLine(debt: CiBlindDebt): string {
  const oldest =
    debt.oldestAgeMs !== undefined
      ? ` oldestAgeMs=${debt.oldestAgeMs}`
      : '';
  const repos = Object.keys(debt.byRepo).length;
  return (
    `ci_blind_debt: blindMergeCount=${debt.blindMergeCount} ` +
    `queueDepth=${debt.queueDepth} verifyFailedCount=${debt.verifyFailedCount} ` +
    `repos=${repos}${oldest}`
  );
}
