import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Severity tier order (issue #1658).
 *
 * The harness has emission/flow control (drain-coupled budget, backpressure
 * slot reservation) but no *admission ranking*: in daily task selection a real
 * production bug is a peer of a cosmetic idea issue. A 2026-07-28 window on a
 * downstream repo admitted ~28 `idea-scout` issues alongside 5 `auto-triage`
 * prod bugs — one a live capability outage — yet only one PR merged. The
 * triage/severity labels already existed; nothing consumed them for scheduling.
 *
 * This module is the executable form of the ordering the issue-batch selectors
 * (`plugin/playbooks/implement-github-issue.md` and
 * `plugin/playbooks/parallel-issue-batch.md`) follow so a blank-shape scan
 * proposes prod-bug/outage issues *first* and idea/micro-hardening issues
 * *last*, instead of treating them as peers:
 *
 *   1. fast-lane issues (carry a {@link SeverityTierOrder.fastLaneLabels}
 *      label), most-severe label first;
 *   2. unclassified issues, in their original input order (stable);
 *   3. deferred issues (carry a {@link SeverityTierOrder.deferLabels} label and
 *      no fast-lane label), in their original input order (stable), last.
 *
 * Membership is driven entirely by labels so an issue joins a tier — and a new
 * severity label joins the vocabulary via the JSON — with no code change. This
 * is ranking only: it never closes, edits, or hides an issue (auto-close stays
 * human-gated, out of scope for #1658).
 *
 * The canonical data lives in `plugin/playbooks/severity-tier-order.json`,
 * committed next to the playbooks that reference it. This mirrors
 * `backlog-drain-order.ts` (#1568), which layers a safety deferral for gated
 * issues; the two orderings are orthogonal — apply the safety drain-tier
 * deferral first, then this severity ordering among the remaining safe set.
 */
export interface SeverityTierOrder {
  /**
   * Labels that promote an issue to the fast lane, most-severe first. A
   * candidate's fast-lane rank is the position of its earliest matching label
   * here, so `outage` (index 0) is proposed before a plain `prod-bug`.
   */
  fastLaneLabels: string[];
  /**
   * Labels that defer an issue to the end (idea / micro-hardening). A fast-lane
   * label always wins over a defer label, so a prod bug that is also tagged as
   * an idea is still worked first.
   */
  deferLabels: string[];
}

/** A candidate issue as seen by the selector: its number and its labels. */
export interface SeverityCandidate {
  number: number;
  labels: string[];
}

/** Absolute path to the canonical committed severity-tier-order file. */
export function severityTierOrderPath(): string {
  // Mirror src/core/plugin-paths.ts: __dirname under CJS build, cwd fallback.
  const here = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  return join(here, '..', '..', 'plugin', 'playbooks', 'severity-tier-order.json');
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)
  );
}

/**
 * Parse and validate a raw severity-tier-order object. Throws on a malformed
 * file so a typo (missing tier, non-string label, a label listed as both
 * fast-lane and defer) fails loudly instead of silently reordering nothing.
 */
export function parseSeverityTierOrder(raw: unknown): SeverityTierOrder {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('severity-tier-order: expected a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyStringArray(obj.fastLaneLabels) || obj.fastLaneLabels.length === 0) {
    // A non-empty fast lane is required: an empty fastLaneLabels would silently
    // disable the prod-bug/outage promotion this file exists to provide — the
    // exact "reorder nothing" no-op the fail-loud contract above guards against.
    throw new Error(
      'severity-tier-order: fastLaneLabels must be a non-empty array of non-empty strings',
    );
  }
  if (!isNonEmptyStringArray(obj.deferLabels)) {
    throw new Error('severity-tier-order: deferLabels must be an array of non-empty strings');
  }
  const fastLane = obj.fastLaneLabels as string[];
  const defer = obj.deferLabels as string[];
  const overlap = fastLane.filter((l) => defer.includes(l));
  if (overlap.length > 0) {
    throw new Error(
      `severity-tier-order: label(s) listed as both fast-lane and defer: ${overlap.join(', ')}`,
    );
  }
  return { fastLaneLabels: fastLane, deferLabels: defer };
}

/** Load and validate the canonical committed severity-tier-order file. */
export function loadSeverityTierOrder(path: string = severityTierOrderPath()): SeverityTierOrder {
  return parseSeverityTierOrder(JSON.parse(readFileSync(path, 'utf-8')));
}

/** True when a candidate carries any fast-lane label (prod bug / outage). */
export function isFastLaneCandidate(
  candidate: SeverityCandidate,
  order: SeverityTierOrder,
): boolean {
  return candidate.labels.some((l) => order.fastLaneLabels.includes(l));
}

/**
 * True when a candidate is deferred: it carries a defer label *and* no
 * fast-lane label. Fast-lane wins so a prod bug that is also an idea is not
 * buried.
 */
export function isDeferredCandidate(
  candidate: SeverityCandidate,
  order: SeverityTierOrder,
): boolean {
  return (
    !isFastLaneCandidate(candidate, order) &&
    candidate.labels.some((l) => order.deferLabels.includes(l))
  );
}

/**
 * The candidate's fast-lane rank: the smallest index of any of its labels in
 * {@link SeverityTierOrder.fastLaneLabels}. Lower is more severe (proposed
 * first). Returns `Infinity` for a non-fast-lane candidate.
 */
export function fastLaneRank(candidate: SeverityCandidate, order: SeverityTierOrder): number {
  let best = Infinity;
  for (const label of candidate.labels) {
    const idx = order.fastLaneLabels.indexOf(label);
    if (idx !== -1 && idx < best) best = idx;
  }
  return best;
}

/**
 * Order candidates for the selector so prod-bug/outage issues are proposed
 * before any idea/micro-hardening issue:
 *
 *   1. fast-lane issues, most-severe fast-lane label first (ties keep input
 *      order — the sort is stable);
 *   2. unclassified issues, in their original input order (stable);
 *   3. deferred issues, in their original input order (stable), last.
 *
 * The relative order within groups 2 and 3 is preserved so this only *layers*
 * the severity preference on top of whatever order the selector already
 * produced. Pure ranking — no candidate is dropped, closed, or mutated.
 */
export function orderCandidatesBySeverityTier<T extends SeverityCandidate>(
  candidates: T[],
  order: SeverityTierOrder,
): T[] {
  const fastLane: Array<{ candidate: T; rank: number; seq: number }> = [];
  const rest: T[] = [];
  const deferred: T[] = [];
  candidates.forEach((candidate, seq) => {
    if (isFastLaneCandidate(candidate, order)) {
      fastLane.push({ candidate, rank: fastLaneRank(candidate, order), seq });
    } else if (isDeferredCandidate(candidate, order)) {
      deferred.push(candidate);
    } else {
      rest.push(candidate);
    }
  });
  // Sort fast lane by severity (rank), keeping input order for equal ranks.
  fastLane.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
  return [...fastLane.map((f) => f.candidate), ...rest, ...deferred];
}
