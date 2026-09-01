import { describe, expect, it } from 'vitest';
import {
  decidePostResumeRefill,
  POST_RESUME_REFILL_MIN_FREE_SLOTS,
  postResumeRefillIdempotencyKey,
  type PostResumeRefillInput,
} from './post-resume-refill.js';

function base(overrides: Partial<PostResumeRefillInput> = {}): PostResumeRefillInput {
  return {
    resumed: true,
    transitionId: 'pause-rec-abc',
    lastRefilledTransitionId: null,
    safeModeEngaged: false,
    paused: false,
    accepting: true,
    freeGeneralSlots: 5,
    pendingQueueDepth: 0,
    eligibleLeafCount: 4,
    spawnBudget: 3,
    substrateBlock: null,
    ...overrides,
  };
}

describe('decidePostResumeRefill', () => {
  it('launches min(leaves, budget, free) on a clean paused→live edge', () => {
    // leaves=4, budget=3, free=5 → 3
    expect(decidePostResumeRefill(base())).toEqual({ action: 'launch', count: 3 });
    // free is the binding constraint
    expect(decidePostResumeRefill(base({ freeGeneralSlots: 3, spawnBudget: 9, eligibleLeafCount: 9 })))
      .toEqual({ action: 'launch', count: 3 });
    // leaves is the binding constraint
    expect(decidePostResumeRefill(base({ eligibleLeafCount: 1, spawnBudget: 9, freeGeneralSlots: 9 })))
      .toEqual({ action: 'launch', count: 1 });
  });

  describe('does not launch (skip) when the transition does not warrant a refill', () => {
    it('resume did not take effect', () => {
      expect(decidePostResumeRefill(base({ resumed: false })))
        .toEqual({ action: 'skip', reason: 'not_resumed' });
    });

    it('no transition id (SAFE MODE flipped with no record and no synthesized id)', () => {
      expect(decidePostResumeRefill(base({ transitionId: null })))
        .toEqual({ action: 'skip', reason: 'not_resumed' });
      expect(decidePostResumeRefill(base({ transitionId: '   ' })))
        .toEqual({ action: 'skip', reason: 'not_resumed' });
    });

    it('already refilled this exact transition (at most one pass per transition)', () => {
      expect(
        decidePostResumeRefill(base({ transitionId: 'T1', lastRefilledTransitionId: 'T1' })),
      ).toEqual({ action: 'skip', reason: 'already_refilled_transition' });
    });

    it('a DIFFERENT prior transition does not suppress a fresh transition', () => {
      expect(
        decidePostResumeRefill(base({ transitionId: 'T2', lastRefilledTransitionId: 'T1' })),
      ).toEqual({ action: 'launch', count: 3 });
    });

    it('SAFE MODE engaged', () => {
      expect(decidePostResumeRefill(base({ safeModeEngaged: true })))
        .toEqual({ action: 'skip', reason: 'safe_mode' });
    });

    it('orchestration still paused', () => {
      expect(decidePostResumeRefill(base({ paused: true })))
        .toEqual({ action: 'skip', reason: 'still_paused' });
    });

    it('operator drain (not accepting)', () => {
      expect(decidePostResumeRefill(base({ accepting: false })))
        .toEqual({ action: 'skip', reason: 'operator_drain' });
    });

    it('insufficient free slots — no genuine post-resume idle capacity', () => {
      expect(decidePostResumeRefill(base({ freeGeneralSlots: POST_RESUME_REFILL_MIN_FREE_SLOTS - 1 })))
        .toEqual({ action: 'skip', reason: 'insufficient_free_slots' });
      expect(decidePostResumeRefill(base({ freeGeneralSlots: Number.NaN })))
        .toEqual({ action: 'skip', reason: 'insufficient_free_slots' });
    });

    it('queue already has launchable work — refill only fills genuine idle', () => {
      expect(decidePostResumeRefill(base({ pendingQueueDepth: 2 })))
        .toEqual({ action: 'skip', reason: 'queue_not_empty' });
    });
  });

  describe('guard precedence (earlier guard wins when conditions overlap)', () => {
    it('already_refilled_transition beats every later gate', () => {
      expect(
        decidePostResumeRefill(
          base({ transitionId: 'T1', lastRefilledTransitionId: 'T1', safeModeEngaged: true, paused: true }),
        ),
      ).toEqual({ action: 'skip', reason: 'already_refilled_transition' });
    });

    it('safe_mode beats paused/drain/capacity', () => {
      expect(
        decidePostResumeRefill(base({ safeModeEngaged: true, paused: true, accepting: false, freeGeneralSlots: 0 })),
      ).toEqual({ action: 'skip', reason: 'safe_mode' });
    });

    it('still_paused beats a substrate block (a paused fleet is never "blocked")', () => {
      expect(
        decidePostResumeRefill(base({ paused: true, substrateBlock: 'disk_floor' })),
      ).toEqual({ action: 'skip', reason: 'still_paused' });
    });

    it('insufficient_free_slots beats intentional_idle/refill_blocked (no idle capacity to reason about)', () => {
      expect(
        decidePostResumeRefill(base({ freeGeneralSlots: 0, eligibleLeafCount: 0, substrateBlock: 'disk_floor' })),
      ).toEqual({ action: 'skip', reason: 'insufficient_free_slots' });
    });
  });

  describe('idle vs blocked classification', () => {
    it('records intentional_idle when no eligible leaves exist', () => {
      expect(decidePostResumeRefill(base({ eligibleLeafCount: 0 })))
        .toEqual({ action: 'intentional_idle' });
      expect(decidePostResumeRefill(base({ eligibleLeafCount: Number.NaN })))
        .toEqual({ action: 'intentional_idle' });
    });

    it('records refill_blocked with the substrate reason when leaves are blocked', () => {
      for (const reason of ['disk_floor', 'provider_admission', 'claim_contended'] as const) {
        expect(decidePostResumeRefill(base({ substrateBlock: reason })))
          .toEqual({ action: 'refill_blocked', reason });
      }
    });

    it('blocks (not idle) when leaves exist but spawn budget is exhausted', () => {
      expect(decidePostResumeRefill(base({ spawnBudget: 0 })))
        .toEqual({ action: 'refill_blocked', reason: 'claim_contended' });
    });

    it('prefers intentional_idle over refill_blocked when there is simply nothing to launch', () => {
      // No leaves AND a substrate block → the honest classification is that the
      // fleet is idle by design; there is nothing that the substrate blocked.
      expect(decidePostResumeRefill(base({ eligibleLeafCount: 0, substrateBlock: 'disk_floor' })))
        .toEqual({ action: 'intentional_idle' });
    });

    it('honors a custom minFreeSlots floor', () => {
      expect(decidePostResumeRefill(base({ freeGeneralSlots: 4, minFreeSlots: 6 })))
        .toEqual({ action: 'skip', reason: 'insufficient_free_slots' });
      expect(decidePostResumeRefill(base({ freeGeneralSlots: 6, minFreeSlots: 6, eligibleLeafCount: 1, spawnBudget: 1 })))
        .toEqual({ action: 'launch', count: 1 });
    });
  });
});

describe('postResumeRefillIdempotencyKey', () => {
  it('is stable and distinct per transition+leaf', () => {
    expect(postResumeRefillIdempotencyKey('pause-rec-abc', '#2797'))
      .toBe('post-resume-refill:pause-rec-abc:2797');
    // same transition, different leaf → different key
    expect(postResumeRefillIdempotencyKey('T1', 'jeanibarz/lucy#10'))
      .not.toBe(postResumeRefillIdempotencyKey('T1', 'jeanibarz/lucy#11'));
    // same transition+leaf → identical key (a replayed tick collapses)
    expect(postResumeRefillIdempotencyKey('T1', 'issue-10'))
      .toBe(postResumeRefillIdempotencyKey('T1', 'issue-10'));
  });
});
