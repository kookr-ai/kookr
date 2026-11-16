/**
 * Delivery state of a task's pull request (issue #3915): is the change in an
 * open PR, in the integration branch awaiting the train, on `main`, or
 * reverted by the train? Pure: every fact is gathered by the server's tracker
 * (src/server/pr-delivery-tracker.ts) from what it already has (the PR state
 * the GitHub scanner fetched, local git refs, the train's event log) and
 * passed in here, so the rules are tested without git or the network.
 */
import type { PrDeliveryRevert, PrDeliveryState } from '../shared/contracts/pr-delivery.js';
import { TRAIN_TARGET_BRANCH } from './integration-branch.js';

/** Facts about one PR, as the tracker found them. */
export interface PrDeliveryFacts {
  pr: {
    status: 'open' | 'closed' | 'merged' | 'draft';
    baseBranch: string;
    openedAt?: string;
    mergedAt?: string;
    mergeCommit?: string;
  };
  /** The repository's integration branch, or null when it has none (no train). */
  integrationBranch: string | null;
  /**
   * When the integration branch was turned on (the commit that added
   * `.kookr/delivery-gate.json` to `main`). A PR merged into `main` after this
   * skipped the train; one merged before it predates the train. Unknown: never flagged.
   */
  integrationSince?: string;
  /**
   * Whether `main` contains the merge commit: true, false, or null when git
   * cannot tell (the commit is not fetched locally, or git failed).
   */
  onMain: boolean | null;
  /** When `main` was first seen containing the merge commit, when known. */
  onMainAt?: string;
  /** The train's revert of the merge commit, when there is one. */
  revert: (PrDeliveryRevert & { at?: string }) | null;
}

/**
 * The delivery state, or null when there is nothing to say beyond the PR's own
 * status: no integration branch, a closed PR, a base branch the train does not
 * handle, or a merged PR whose position git cannot confirm. A null keeps the
 * card's plain `#n · merged` chip rather than guessing.
 */
export function derivePrDeliveryState(facts: PrDeliveryFacts): PrDeliveryState | null {
  const { pr, integrationBranch } = facts;
  if (!integrationBranch) return null;
  const base = { integrationBranch, ...(pr.openedAt ? { openedAt: pr.openedAt } : {}) };

  if (pr.status === 'open' || pr.status === 'draft') return { ...base, stage: 'pr-open' };
  if (pr.status !== 'merged') return null;

  const merged = { ...base, ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}) };
  const onMainAt = facts.onMainAt ? { onMainAt: facts.onMainAt } : {};

  if (pr.baseBranch === TRAIN_TARGET_BRANCH) {
    // Merged straight into main. It is on main by definition; it skipped the
    // train only if it merged after the train was turned on.
    const skipped = isAfter(pr.mergedAt, facts.integrationSince);
    return { ...merged, ...onMainAt, stage: 'on-main', ...(skipped ? { skippedTrain: true } : {}) };
  }
  if (pr.baseBranch !== integrationBranch) return null;

  // A reverted change reaches main together with its revert, so a revert
  // outranks main's ancestry.
  if (facts.revert) {
    const { at, ...revert } = facts.revert;
    return { ...merged, stage: 'reverted', ...(at ? { revertedAt: at } : {}), revert };
  }
  if (facts.onMain === true) return { ...merged, ...onMainAt, stage: 'on-main' };
  if (facts.onMain === false) return { ...merged, stage: 'in-staging' };
  return null;
}

function isAfter(time: string | undefined, since: string | undefined): boolean {
  if (!time || !since) return false;
  const a = Date.parse(time);
  const b = Date.parse(since);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

/** One line of the train's `events.jsonl`. */
export interface TrainEventLine {
  at?: string;
  kind?: string;
  detail?: string;
}

/**
 * The fix-task facts of the train's `reverted` event for `commit`, or null when
 * the log has none. The detail is written by `integration-train-core.ts`:
 * `reverted <commit> as <revert> on <branch>; <fix note>`, where the fix note is
 * `fix task <key> spawned (automatic re-land <k> of <n>)`,
 * `fix task <key> could not be spawned`, or `fix budget exhausted for ...`.
 */
export function revertFactsFromTrainEvents(
  events: readonly TrainEventLine[],
  commit: string,
): Pick<PrDeliveryRevert, 'attempt' | 'maxAttempts' | 'fixTaskKey' | 'needsHuman'> & { at?: string } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== 'reverted' || typeof event.detail !== 'string') continue;
    if (!event.detail.startsWith(`reverted ${commit} `)) continue;
    const at = typeof event.at === 'string' ? { at: event.at } : {};
    const spawned = /fix task (\S+) spawned \(automatic re-land (\d+) of (\d+)\)/.exec(event.detail);
    if (spawned) {
      return {
        ...at,
        fixTaskKey: spawned[1]!,
        attempt: Number(spawned[2]),
        maxAttempts: Number(spawned[3]),
        needsHuman: false,
      };
    }
    const failed = /fix task (\S+) could not be spawned/.exec(event.detail);
    if (failed) return { ...at, fixTaskKey: failed[1]!, needsHuman: true };
    if (/fix budget exhausted/.test(event.detail)) return { ...at, needsHuman: true };
    return { ...at, needsHuman: false };
  }
  return null;
}

/** Parse `events.jsonl` text, skipping lines that are not JSON objects. */
export function parseTrainEvents(text: string): TrainEventLine[] {
  const out: TrainEventLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object') out.push(parsed as TrainEventLine);
    } catch {
      // A torn or foreign line; the rest of the log still counts.
    }
  }
  return out;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const MAX_FAILING_TESTS = 5;

/**
 * The failing tests of a verify log, deduplicated, at most five. Reads vitest's
 * summary lines, which `scripts/verify.sh` prefixes with its lane:
 * `[unit_lane]  FAIL  |serial| src/a.test.ts > suite > test`. ANSI colours,
 * the lane prefix and the `|project|` tag are stripped.
 */
export function failingTestsFromVerifyLog(log: string): string[] {
  const seen = new Set<string>();
  for (const raw of log.split('\n')) {
    const line = raw.replace(ANSI, '').trim().replace(/^\[[\w-]+\]\s*/, '');
    const m = /^FAIL\s+(?:\|[^|\s]+\|\s+)?(\S.*)$/.exec(line);
    if (!m) continue;
    const test = m[1]!.trim();
    if (!test || seen.has(test)) continue;
    seen.add(test);
    if (seen.size >= MAX_FAILING_TESTS) break;
  }
  return [...seen];
}
