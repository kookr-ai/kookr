import { describe, expect, test } from 'vitest';
import type { PhaseLedgerPhase } from '../core/phase-ledger-codec.js';
import {
  auditReviewGate,
  phaseReviewGateAuditInput,
  phaseReviewGateAuditStatus,
  type ReviewGateAuditInput,
} from './review-gate-audit.js';

function mergedPhaseReview(overrides: Partial<ReviewGateAuditInput> = {}): ReviewGateAuditInput {
  return {
    merged: true,
    implementerTaskId: 'owner-1',
    reviewerTaskId: 'reviewer-2',
    reviewVerdict: 'pass',
    reviewedAt: '2026-08-23T10:05:00.000Z',
    mergedAt: '2026-08-23T10:00:00.000Z',
    reviewHeadSha: 'head-abc',
    currentHeadSha: 'head-abc',
    reviewAttempts: 1,
    ...overrides,
  };
}

describe('auditReviewGate', () => {
  test('passes a valid independent verdict from a distinct task id at the current head', () => {
    const result = auditReviewGate(mergedPhaseReview());
    expect(result).toMatchObject({ status: 'pass', flagged: false });
  });

  test('flags a verdict produced by the implementer task itself (same task id)', () => {
    const result = auditReviewGate(mergedPhaseReview({ reviewerTaskId: 'owner-1' }));
    expect(result.status).toBe('missing');
    expect(result.flagged).toBe(true);
    expect(result.reason).toContain('implementer lineage');
  });

  test('flags a merged PR with no independent verdict at all (missing)', () => {
    const result = auditReviewGate(mergedPhaseReview({
      reviewerTaskId: undefined,
      reviewVerdict: undefined,
      reviewedAt: undefined,
    }));
    expect(result.status).toBe('missing');
    expect(result.flagged).toBe(true);
    expect(result.reason).toContain('missing');
  });

  test('flags a verdict recorded at or before the merge point', () => {
    const result = auditReviewGate(mergedPhaseReview({ reviewedAt: '2026-08-23T09:59:00.000Z' }));
    expect(result).toMatchObject({ status: 'missing', flagged: true });
    expect(result.reason).toContain('predates the merge');
  });

  test('flags a verdict recorded at exactly the merge point (inclusive boundary)', () => {
    const at = '2026-08-23T10:00:00.000Z';
    const result = auditReviewGate(mergedPhaseReview({ reviewedAt: at, mergedAt: at }));
    expect(result).toMatchObject({ status: 'missing', flagged: true });
    expect(result.reason).toContain('predates the merge');
  });

  test('flags a verdict bound to a stale head', () => {
    const result = auditReviewGate(mergedPhaseReview({ currentHeadSha: 'head-different' }));
    expect(result.flagged).toBe(true);
    expect(result.status).toBe('missing');
  });

  test('reports a recorded BLOCK verdict distinctly', () => {
    const result = auditReviewGate(mergedPhaseReview({ reviewVerdict: 'block' }));
    expect(result).toMatchObject({ status: 'block', flagged: true });
  });

  test('escalates a same-task verdict even without head shas provided', () => {
    const result = auditReviewGate(mergedPhaseReview({
      reviewerTaskId: 'owner-1',
      reviewHeadSha: undefined,
      currentHeadSha: undefined,
    }));
    expect(result.flagged).toBe(true);
    expect(result.status).toBe('missing');
  });

  test('requires no audit when the PR never merged', () => {
    const result = auditReviewGate({ merged: false });
    expect(result).toMatchObject({ status: 'not-required', flagged: false });
  });
});

describe('phaseReviewGateAuditInput / phaseReviewGateAuditStatus', () => {
  function phase(overrides: Partial<PhaseLedgerPhase> = {}): PhaseLedgerPhase {
    return { id: 'P1', dependsOn: [], status: 'merged', ...overrides } as PhaseLedgerPhase;
  }

  test('maps a merged, independently-reviewed phase to a pass', () => {
    const p = phase({
      prNumber: 10,
      taskId: 'owner-1',
      reviewerTaskId: 'reviewer-2',
      reviewVerdict: 'pass',
      reviewedAt: '2026-08-23T10:05:00.000Z',
      mergedAt: '2026-08-23T10:00:00.000Z',
      reviewHeadSha: 'head-abc',
    });
    expect(phaseReviewGateAuditStatus(p, 'head-abc')).toBe('pass');
    expect(auditReviewGate(phaseReviewGateAuditInput(p, 'head-abc')).flagged).toBe(false);
  });

  test('treats a phase without a PR as not requiring an audit', () => {
    expect(phaseReviewGateAuditStatus(phase({ status: 'pending' }))).toBe('not-required');
  });

  test('flags a same-task reviewer through the phase mapper', () => {
    const p = phase({
      prNumber: 10,
      taskId: 'owner-1',
      reviewerTaskId: 'owner-1',
      reviewVerdict: 'pass',
      reviewedAt: '2026-08-23T10:05:00.000Z',
      mergedAt: '2026-08-23T10:00:00.000Z',
      reviewHeadSha: 'head-abc',
    });
    expect(auditReviewGate(phaseReviewGateAuditInput(p, 'head-abc')).flagged).toBe(true);
  });
});
