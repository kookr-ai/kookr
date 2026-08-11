import { describe, expect, it } from 'vitest';
import { PROMPT_DETECTED_FROM } from './completion/delivered-task-completion.js';
import {
  OpenPrFailsafeReasonMetrics,
  evaluateTaskOpenPrHold,
  isBotPrAuthor,
  isDeliveryOpenPr,
  type OpenPrHoldCandidate,
} from './open-pr-hold.js';

function pr(partial: Partial<OpenPrHoldCandidate> & Pick<OpenPrHoldCandidate, 'number'>): OpenPrHoldCandidate {
  return {
    detectedFrom: 'agent-session-1',
    isOpen: false,
    ...partial,
  };
}

describe('isBotPrAuthor', () => {
  it('detects known bot logins and [bot] suffix', () => {
    expect(isBotPrAuthor('dependabot[bot]')).toBe(true);
    expect(isBotPrAuthor('renovate')).toBe(true);
    expect(isBotPrAuthor('imgbot[bot]')).toBe(true);
    expect(isBotPrAuthor('human-dev')).toBe(false);
    expect(isBotPrAuthor(null)).toBe(false);
  });
});

describe('evaluateTaskOpenPrHold (issue #2225)', () => {
  it('clears hold when there are no PR refs', () => {
    expect(evaluateTaskOpenPrHold({ prs: [] })).toEqual({
      isHolding: false,
      reason: 'no_pr_refs',
    });
  });

  it('AC2: prompt-cited-only linkage does not block reclaim (stale/wrong PR)', () => {
    const evaluation = evaluateTaskOpenPrHold({
      prs: [
        pr({
          number: 99,
          owner: 'kookr-ai',
          repo: 'kookr',
          detectedFrom: PROMPT_DETECTED_FROM,
          isOpen: true,
          author: 'someone',
          headBranch: 'dependabot/npm_and_yarn/foo',
        }),
      ],
    });
    expect(evaluation.isHolding).toBe(false);
    expect(evaluation.reason).toBe('prompt_cited_only');
  });

  it('AC2: closed-but-not-unlinked agent PR clears hold', () => {
    const evaluation = evaluateTaskOpenPrHold({
      prs: [
        pr({
          number: 42,
          isOpen: false,
          author: 'agent-bot',
          headBranch: 'fix/issue-1',
        }),
      ],
    });
    expect(evaluation.isHolding).toBe(false);
    expect(evaluation.reason).toBe('all_closed_or_merged');
  });

  it('AC2: bot/foreign open PR on another branch clears hold', () => {
    const evaluation = evaluateTaskOpenPrHold({
      prs: [
        pr({
          number: 7,
          isOpen: true,
          author: 'dependabot[bot]',
          headBranch: 'dependabot/npm_and_yarn/lodash-4.17.21',
        }),
      ],
      taskBranch: 'fix/issue-2225-phantom-reclaim',
    });
    expect(evaluation.isHolding).toBe(false);
    expect(evaluation.reason).toBe('bot_or_foreign_open');
  });

  it('bot open PR whose head matches task branch still holds as delivery', () => {
    const evaluation = evaluateTaskOpenPrHold({
      prs: [
        pr({
          number: 8,
          isOpen: true,
          author: 'dependabot[bot]',
          headBranch: 'fix/issue-2225-phantom-reclaim',
        }),
      ],
      taskBranch: 'fix/issue-2225-phantom-reclaim',
    });
    expect(evaluation.isHolding).toBe(true);
    expect(evaluation.reason).toBe('delivery_open');
  });

  it('agent-authored open PR with mismatched head is foreign (evaluate path)', () => {
    const evaluation = evaluateTaskOpenPrHold({
      prs: [
        pr({
          number: 9,
          isOpen: true,
          author: 'jean',
          headBranch: 'other-branch',
        }),
      ],
      taskBranch: 'fix/mine',
    });
    expect(evaluation.isHolding).toBe(false);
    expect(evaluation.reason).toBe('bot_or_foreign_open');
  });

  it('holds on confirmed agent-authored delivery open PR', () => {
    const evaluation = evaluateTaskOpenPrHold({
      prs: [
        pr({
          number: 88,
          owner: 'kookr-ai',
          repo: 'kookr',
          isOpen: true,
          author: 'jean',
          headBranch: 'fix/issue-2225-phantom-reclaim',
        }),
      ],
      taskBranch: 'fix/issue-2225-phantom-reclaim',
    });
    expect(evaluation.isHolding).toBe(true);
    expect(evaluation.reason).toBe('delivery_open');
    expect(evaluation.sample?.prNumber).toBe(88);
  });

  it('fail-safe holds on unfetched agent-authored PR state', () => {
    const evaluation = evaluateTaskOpenPrHold({
      prs: [pr({ number: 12, isOpen: undefined })],
    });
    expect(evaluation.isHolding).toBeUndefined();
    expect(evaluation.reason).toBe('delivery_state_unknown');
  });

  it('prompt open PR does not hold when an agent closed PR is also present', () => {
    const evaluation = evaluateTaskOpenPrHold({
      prs: [
        pr({
          number: 1,
          detectedFrom: PROMPT_DETECTED_FROM,
          isOpen: true,
        }),
        pr({ number: 2, isOpen: false }),
      ],
    });
    expect(evaluation.isHolding).toBe(false);
    expect(evaluation.reason).toBe('all_closed_or_merged');
  });

  it('mismatched agent head branch is foreign (not delivery)', () => {
    expect(
      isDeliveryOpenPr(
        pr({
          number: 3,
          isOpen: true,
          author: 'jean',
          headBranch: 'other-branch',
        }),
        'fix/mine',
      ),
    ).toBe(false);
  });
});

describe('OpenPrFailsafeReasonMetrics', () => {
  it('AC1: records hold reasons with sample taskIds and PR linkage', () => {
    const metrics = new OpenPrFailsafeReasonMetrics();
    metrics.recordHold('task-a', {
      isHolding: true,
      reason: 'delivery_open',
      sample: { prNumber: 10, owner: 'o', repo: 'r' },
    });
    metrics.recordHold('task-b', {
      isHolding: undefined,
      reason: 'delivery_state_unknown',
      sample: { prNumber: 11 },
    });
    // clear reasons must not increment
    metrics.recordHold('task-c', {
      isHolding: false,
      reason: 'prompt_cited_only',
      sample: { prNumber: 12 },
    });

    const snap = metrics.getSnapshot();
    expect(snap.delivery_open.count).toBe(1);
    expect(snap.delivery_open.sampleTaskIds).toEqual(['task-a']);
    expect(snap.delivery_open.samples[0]?.prNumber).toBe(10);
    expect(snap.delivery_state_unknown.count).toBe(1);
    expect(snap.delivery_state_unknown.sampleTaskIds).toEqual(['task-b']);
    expect(snap.prompt_cited_only.count).toBe(0);
  });
});
