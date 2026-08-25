import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SELF_MERGE_RATE_CAP_PER_HOUR,
  SELF_MERGE_RATE_CAP_WINDOW_MS,
  checkSelfMergeRateCap,
  evaluateIndependentReview,
  isSelfAdvancingDisabled,
  verifySelfMergeGrant,
} from './self-advancing-authority.js';

describe('isSelfAdvancingDisabled — global env kill switch', () => {
  test('absent → not disabled', () => {
    expect(isSelfAdvancingDisabled({})).toBe(false);
  });

  test('explicit off spellings → not disabled', () => {
    for (const v of ['0', 'false', 'no', 'off', '', '  ', 'OFF', 'False']) {
      expect(isSelfAdvancingDisabled({ KOOKR_SELF_ADVANCING_DISABLED: v })).toBe(false);
    }
  });

  test('truthy spellings → disabled', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'anything']) {
      expect(isSelfAdvancingDisabled({ KOOKR_SELF_ADVANCING_DISABLED: v })).toBe(true);
    }
  });
});

describe('verifySelfMergeGrant — namespace-verified at merge time', () => {
  test('grants when head branch is in namespace and umbrella marker present', () => {
    const d = verifySelfMergeGrant({
      prHeadBranch: 'refactor/alerts-#2711-p2',
      chainNamespace: 'refactor/alerts-#2711',
      umbrellaHasChainMarker: true,
    });
    expect(d.granted).toBe(true);
  });

  test('grants on exact namespace match', () => {
    expect(
      verifySelfMergeGrant({
        prHeadBranch: 'refactor/alerts-#2711',
        chainNamespace: 'refactor/alerts-#2711',
        umbrellaHasChainMarker: true,
      }).granted,
    ).toBe(true);
  });

  test('denies a branch outside the namespace even with the marker', () => {
    const d = verifySelfMergeGrant({
      prHeadBranch: 'feature/unrelated',
      chainNamespace: 'refactor/alerts-#2711',
      umbrellaHasChainMarker: true,
    });
    expect(d.granted).toBe(false);
    expect(d.reason).toContain('outside chain namespace');
  });

  test('denies when the umbrella marker is missing (stray policy on unrelated child)', () => {
    const d = verifySelfMergeGrant({
      prHeadBranch: 'refactor/alerts-#2711-p2',
      chainNamespace: 'refactor/alerts-#2711',
      umbrellaHasChainMarker: false,
    });
    expect(d.granted).toBe(false);
    expect(d.reason).toContain('chain marker');
  });

  test('denies an empty chain namespace (never an accidental wildcard)', () => {
    const d = verifySelfMergeGrant({
      prHeadBranch: 'refactor/alerts-#2711-p2',
      chainNamespace: '',
      umbrellaHasChainMarker: true,
    });
    expect(d.granted).toBe(false);
  });

  test('denies a same-prefix-but-different-issue branch (no accidental substring match)', () => {
    const d = verifySelfMergeGrant({
      prHeadBranch: 'refactor/alerts-#27110',
      chainNamespace: 'refactor/alerts-#2711',
      umbrellaHasChainMarker: true,
    });
    // '-#27110' starts with 'refactor/alerts-#2711' + '0', not a separator, so
    // it must NOT match. Guarded by requiring a '/' or '-' boundary.
    expect(d.granted).toBe(false);
  });
});

describe('checkSelfMergeRateCap — per-chain circuit breaker', () => {
  const now = 1_000_000_000_000;

  test('allows when under the cap', () => {
    const d = checkSelfMergeRateCap({ recentMergeTimestamps: [now - 1000], now });
    expect(d.allowed).toBe(true);
    expect(d.countInWindow).toBe(1);
  });

  test('blocks at the cap within the window', () => {
    const ts = Array.from({ length: DEFAULT_SELF_MERGE_RATE_CAP_PER_HOUR }, (_, i) => now - i * 1000);
    const d = checkSelfMergeRateCap({ recentMergeTimestamps: ts, now });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('rate cap reached');
  });

  test('the cap edge is exact: cap-1 allowed, cap blocked (no off-by-one)', () => {
    const belowTs = Array.from({ length: DEFAULT_SELF_MERGE_RATE_CAP_PER_HOUR - 1 }, (_, i) => now - i * 1000);
    expect(checkSelfMergeRateCap({ recentMergeTimestamps: belowTs, now }).allowed).toBe(true);
    const atTs = Array.from({ length: DEFAULT_SELF_MERGE_RATE_CAP_PER_HOUR }, (_, i) => now - i * 1000);
    expect(checkSelfMergeRateCap({ recentMergeTimestamps: atTs, now }).allowed).toBe(false);
  });

  test('ignores merges outside the window', () => {
    const old = now - SELF_MERGE_RATE_CAP_WINDOW_MS - 1;
    const ts = Array.from({ length: DEFAULT_SELF_MERGE_RATE_CAP_PER_HOUR }, () => old);
    const d = checkSelfMergeRateCap({ recentMergeTimestamps: ts, now });
    expect(d.allowed).toBe(true);
    expect(d.countInWindow).toBe(0);
  });

  test('respects a custom cap', () => {
    const d = checkSelfMergeRateCap({ recentMergeTimestamps: [now], now, maxPerWindow: 1 });
    expect(d.allowed).toBe(false);
  });
});

describe('evaluateIndependentReview — unforgeable, capped verdict gate', () => {
  const lineage = ['task-impl', 'task-parent'];

  test('independent PASS → merge-allowed', () => {
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerTaskId: 'task-reviewer',
      reviewerRan: true,
      verdict: 'PASS',
      reviewAttempts: 1,
      reviewHeadSha: 'head-1',
      currentHeadSha: 'head-1',
    });
    expect(d.decision).toBe('merge-allowed');
  });

  test('independent BLOCK → correction/review retry while budget remains', () => {
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerTaskId: 'task-reviewer',
      reviewerRan: true,
      verdict: 'BLOCK',
      reviewAttempts: 1,
      reviewHeadSha: 'head-1',
      currentHeadSha: 'head-1',
    });
    expect(d.decision).toBe('retry-review');
    expect(d.reason).toMatch(/correction\/review attempt 2\/10/);
  });

  test('independent BLOCK at the configured cap is a concrete blocker', () => {
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerTaskId: 'task-reviewer',
      reviewerRan: true,
      verdict: 'BLOCK',
      reviewAttempts: 2,
      maxReviewAttempts: 2,
      reviewHeadSha: 'head-1',
      currentHeadSha: 'head-1',
    });
    expect(d.decision).toBe('human-required');
    expect(d.reason).toMatch(/BLOCK.*2\/2/);
  });

  test('reviewer in implementer lineage → human-required (not independent)', () => {
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerTaskId: 'task-impl',
      reviewerRan: true,
      verdict: 'PASS',
      reviewAttempts: 1,
    });
    expect(d.decision).toBe('human-required');
    expect(d.reason).toContain('lineage');
  });

  test('reviewer ran but reported no task id → human-required', () => {
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerRan: true,
      verdict: 'PASS',
      reviewAttempts: 1,
    });
    expect(d.decision).toBe('human-required');
  });

  test('identity check precedes BLOCK: in-lineage reviewer returning BLOCK → human-required', () => {
    // Pins the check ordering: an in-lineage verdict can never authorize OR
    // definitively block — it is not independent, so it escalates to a human.
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerTaskId: 'task-impl',
      reviewerRan: true,
      verdict: 'BLOCK',
      reviewAttempts: 1,
    });
    expect(d.decision).toBe('human-required');
    expect(d.reason).toContain('lineage');
  });

  test('ran without a verdict and cap exhausted → human-required', () => {
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerTaskId: 'task-reviewer',
      reviewerRan: true,
      reviewAttempts: 2,
      maxReviewAttempts: 2,
    });
    expect(d.decision).toBe('human-required');
  });

  test('reviewer failed to run, attempts left → retry-review (not BLOCK)', () => {
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerRan: false,
      reviewAttempts: 1,
    });
    expect(d.decision).toBe('retry-review');
  });

  test('default review budget is ten attempts', () => {
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerRan: false,
      reviewAttempts: 9,
    });
    expect(d.decision).toBe('retry-review');
  });

  test('stale PASS cannot authorize a merge and is re-reviewed while budget remains', () => {
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerTaskId: 'task-reviewer',
      reviewerRan: true,
      verdict: 'PASS',
      reviewAttempts: 1,
      reviewHeadSha: 'old-head',
      currentHeadSha: 'new-head',
    });
    expect(d.decision).toBe('retry-review');
  });

  test('stale PASS at the configured cap is a discoverable blocker', () => {
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerTaskId: 'task-reviewer',
      reviewerRan: true,
      verdict: 'PASS',
      reviewAttempts: 2,
      maxReviewAttempts: 2,
      reviewHeadSha: 'old-head',
      currentHeadSha: 'new-head',
    });
    expect(d.decision).toBe('human-required');
    expect(d.reason).toMatch(/current PR head/);
  });

  test('reviewer failed to run, cap exhausted → human-required', () => {
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerRan: false,
      reviewAttempts: 2,
      maxReviewAttempts: 2,
    });
    expect(d.decision).toBe('human-required');
    expect(d.reason).toContain('attempts');
  });

  test('rejects a configured cap above the shared maximum', () => {
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerRan: false,
      reviewAttempts: 1,
      maxReviewAttempts: 21,
    });
    expect(d.decision).toBe('human-required');
    expect(d.reason).toMatch(/shared autonomous review cap/);
  });

  test('does not allow a PASS after the configured attempt cap', () => {
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerTaskId: 'task-reviewer',
      reviewerRan: true,
      verdict: 'PASS',
      reviewAttempts: 3,
      maxReviewAttempts: 2,
      reviewHeadSha: 'head-1',
      currentHeadSha: 'head-1',
    });
    expect(d.decision).toBe('human-required');
    expect(d.reason).toMatch(/exceeds/);
  });

  test('reviewer ran without a verdict, attempts left → retry-review', () => {
    const d = evaluateIndependentReview({
      implementerLineage: lineage,
      reviewerTaskId: 'task-reviewer',
      reviewerRan: true,
      reviewAttempts: 1,
    });
    expect(d.decision).toBe('retry-review');
  });
});
