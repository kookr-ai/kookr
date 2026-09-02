/**
 * Launch and selection helpers for the issue-proposal-refinement playbook.
 *
 * The playbook agent executes these rules in bash against GitHub. This module
 * is the executable spec those steps must match, so selector, trust, retry-cap,
 * budget, and handoff mistakes fail in unit tests instead of only in a live
 * loop.
 */

import { MAX_AUTONOMOUS_REVIEW_ITERATION_CAP } from './autonomous-review-policy.js';

const RESERVED_FILTER_TOKENS = new Set(['repo:', 'state:', 'is:', 'archived:', 'linked:']);

export type IssueSelector =
  | { kind: 'blank' }
  | { kind: 'list'; numbers: number[] }
  | { kind: 'filter'; query: string };

export type TotalLimit = { kind: 'all' } | { kind: 'count'; n: number };

export type ClosePolicy = 'never' | 'allow-evidenced';

export type RefinementHandoff =
  | 'continue-batch'
  | 'spawn-successor'
  | 'stop-limit'
  | 'stop-exhausted'
  | 'stop-no-continuation'
  | 'stop-blocker';

export interface RefinementHandoffInput {
  launchMode: 'standard' | 'looped';
  /** Successful dispositions completed in this task, including the current one. */
  batchCompletedAfter: number;
  batchSize: number;
  /** Successful dispositions across the whole continuation chain, including this task. */
  totalProcessedAfter: number;
  limit: TotalLimit;
  remainingEligibleCount: number;
  selfContinuation: boolean;
  hardBlocker: boolean;
}

function firstPayloadLine(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    // `#2884` is an issue-number selector, not a comment. Only skip `#` lines
    // that are not a hash-prefixed integer (optional leading `#` then digits).
    if (trimmed === '' || (trimmed.startsWith('#') && !/^#\d/.test(trimmed))) continue;
    return trimmed;
  }
  return '';
}

/**
 * Parse the playbook selector: blank (all eligible open issues), an explicit
 * issue-number list, or a GitHub search filter. Rejects filters that try to
 * override repo/state via reserved tokens so the playbook's `--state open` is
 * the only state source.
 */
export function parseIssueSelector(raw: string): IssueSelector {
  const line = firstPayloadLine(raw);
  if (line === '') return { kind: 'blank' };

  const tokens = line.split(/[,\s]+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return { kind: 'blank' };

  if (tokens.every((token) => /^#?\d+$/.test(token))) {
    const numbers: number[] = [];
    const seen = new Set<number>();
    for (const token of tokens) {
      const n = Number(token.replace(/^#/, ''));
      if (n <= 0 || !Number.isSafeInteger(n)) {
        throw new Error(`issue selector list contains a non-positive issue number: ${token}`);
      }
      if (!seen.has(n)) {
        seen.add(n);
        numbers.push(n);
      }
    }
    return { kind: 'list', numbers };
  }

  for (const token of line.split(/\s+/)) {
    if (RESERVED_FILTER_TOKENS.has(token)) {
      throw new Error(`issue selector filter must not include reserved token ${token}`);
    }
  }
  return { kind: 'filter', query: line };
}

export function parseTotalLimit(raw: string): TotalLimit {
  const trimmed = raw.trim();
  if (trimmed === 'all') return { kind: 'all' };
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error('limit must be "all" or a positive integer');
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) {
    throw new Error('limit must be a safe positive integer');
  }
  return { kind: 'count', n };
}

export function parseBatchSize(raw: string): number {
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`batchSize must be an integer from 1 through ${MAX_AUTONOMOUS_REVIEW_ITERATION_CAP}`);
  }
  const n = Number(trimmed);
  if (n < 1 || n > MAX_AUTONOMOUS_REVIEW_ITERATION_CAP) {
    throw new Error(`batchSize must be an integer from 1 through ${MAX_AUTONOMOUS_REVIEW_ITERATION_CAP}`);
  }
  return n;
}

export function parseBooleanFlag(raw: string, name: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  throw new Error(`${name} must be exactly true or false`);
}

export function parseClosePolicy(raw: string): ClosePolicy {
  const trimmed = raw.trim();
  if (trimmed === 'never' || trimmed === 'allow-evidenced') return trimmed;
  throw new Error('closePolicy must be exactly never or allow-evidenced');
}

export function isTrustedIssueAuthor(
  author: string,
  currentUser: string,
  allowOtherAuthors: boolean,
): boolean {
  if (allowOtherAuthors) return true;
  return author === currentUser;
}

/** Canonical issue id used by Ralph burned-out target lists: digits only, no leading `#`. */
export function canonicalizeIssueTarget(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#+/, '');
}

export function parseBurnedOutTargets(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '(none)') return [];
  return trimmed
    .split(/[,\s]+/)
    .map((token) => canonicalizeIssueTarget(token))
    .filter((token) => token.length > 0);
}

export function filterBurnedCandidates(candidates: number[], burnedRaw: string): number[] {
  const burned = new Set(parseBurnedOutTargets(burnedRaw));
  return candidates.filter((n) => !burned.has(String(n)));
}

/** Remaining finite budget, or `undefined` when the limit is unbounded. */
export function remainingLimitBudget(limit: TotalLimit, processed: number): number | undefined {
  if (limit.kind === 'all') return undefined;
  return Math.max(0, limit.n - processed);
}

function hasRemainingBudget(limit: TotalLimit, processed: number): boolean {
  return remainingLimitBudget(limit, processed) !== 0;
}

/**
 * Decide what happens after one durable disposition.
 *
 * A standard launch is always a batch boundary after that one issue. A looped
 * launch stays on the current task until `batchSize` successful dispositions,
 * then either spawns a successor or stops.
 */
export type RefinementSweepLabel =
  | 'done'
  | 'in-flight'
  | 'blocked'
  | 'pending'
  | 'stale-open-but-shipped';

export interface RefinementSweepIssue {
  state: 'open' | 'closed';
  claimedByOtherTask: boolean;
  matchingMarker: boolean;
  hardBlocked: boolean;
  /** Out-of-band evidence the proposal was already refined, without a matching marker. */
  refinedOutOfBand: boolean;
}

/**
 * Read-only end-of-chain classification. Never mutates GitHub; `stale-open-but-shipped`
 * is a drift report for a human, not a license to rewrite the issue.
 */
export function classifyRefinementSweep(issue: RefinementSweepIssue): RefinementSweepLabel {
  if (issue.claimedByOtherTask) return 'in-flight';
  if (issue.hardBlocked) return 'blocked';
  if (issue.state === 'closed' || issue.matchingMarker) return 'done';
  if (issue.refinedOutOfBand) return 'stale-open-but-shipped';
  return 'pending';
}

export function decideRefinementHandoff(input: RefinementHandoffInput): RefinementHandoff {
  if (input.hardBlocker) return 'stop-blocker';
  if (!hasRemainingBudget(input.limit, input.totalProcessedAfter)) return 'stop-limit';
  if (input.remainingEligibleCount <= 0) return 'stop-exhausted';

  const atBatchBoundary = input.launchMode === 'standard'
    || input.batchCompletedAfter >= input.batchSize;
  if (!atBatchBoundary) return 'continue-batch';
  if (input.selfContinuation) return 'spawn-successor';
  return 'stop-no-continuation';
}
