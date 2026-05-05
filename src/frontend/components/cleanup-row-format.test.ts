import { describe, it, expect } from 'vitest';
import { formatCleanupSubtext, formatAge, formatAheadBehind, formatDirty } from './cleanup-row-format.js';
import type { CleanupCandidateAssessment } from '../../shared/protocol.js';

const BASE: CleanupCandidateAssessment = {
  projectId: 'p',
  worktreePath: '/w',
  branch: 'feat/x',
  classification: 'unique_commits',
  reasonCode: 'has_unique_commits',
  source: 'cleanup_inspector',
  observedAt: '2026-04-22T12:00:00Z',
  recoveryGuidance: '',
  capabilities: {
    canSafeRemove: false,
    canRemovePathKeepBranch: true,
    canReviewedDiscard: true,
    requiresDirtyRecovery: false,
    defaultActionLabel: 'Keep branch, remove path',
    riskSummary: '',
  },
};

const NOW = new Date('2026-04-22T12:00:00Z');

describe('formatCleanupSubtext', () => {
  it('renders real data for a unique_commits branch', () => {
    const out = formatCleanupSubtext({
      ...BASE,
      commitSummary: { aheadCount: 2, behindCount: 97, lastCommitAt: '2026-04-19T12:00:00Z' },
      dirtySummary: undefined,
    }, NOW);
    expect(out).toEqual({ text: '3 days ago · +2 / −97', failed: false });
  });

  it('renders a dirty indicator alongside ahead/behind', () => {
    const out = formatCleanupSubtext({
      ...BASE,
      classification: 'dirty',
      reasonCode: 'uncommitted_changes',
      commitSummary: { aheadCount: 1, behindCount: 3, lastCommitAt: '2026-04-17T00:00:00Z' },
      dirtySummary: { modified: 2, added: 0, deleted: 0, renamed: 0, untracked: 1 },
    }, NOW);
    expect(out?.text).toBe('5 days ago · +1 / −3 · M2 U1');
    expect(out?.failed).toBe(false);
  });

  it('renders failure marker when enrichmentFailed is set', () => {
    const out = formatCleanupSubtext({
      ...BASE,
      enrichmentFailed: true,
    }, NOW);
    expect(out).toEqual({ text: '(!) details unavailable', failed: true });
  });

  it('shows HEAD shortsha when branch is detached and no commit summary', () => {
    const out = formatCleanupSubtext({
      ...BASE,
      branch: '(detached at 2cf4d8f1)',
      classification: 'unknown',
      reasonCode: 'detached_head',
      headShortSha: '2cf4d8f',
      dirtySummary: { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 3 },
    }, NOW);
    expect(out?.text).toBe('HEAD 2cf4d8f · U3');
    expect(out?.failed).toBe(false);
  });

  it('returns null for protected / busy / checked_out_elsewhere / stale_worktree', () => {
    for (const cls of ['protected', 'busy', 'checked_out_elsewhere', 'stale_worktree'] as const) {
      expect(
        formatCleanupSubtext({ ...BASE, classification: cls }, NOW),
      ).toBeNull();
    }
  });

  it('identifies generated-only dirty summaries explicitly', () => {
    const out = formatCleanupSubtext({
      ...BASE,
      classification: 'generated_only',
      reasonCode: 'generated_artifacts',
      dirtySummary: { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 1 },
    }, NOW);
    expect(out?.text).toBe('generated U1');
    expect(out?.failed).toBe(false);
  });

  it('returns null for a clean worktree with no commit summary', () => {
    // Can happen for unknown classifications where no enrichment ran.
    const out = formatCleanupSubtext({
      ...BASE,
      classification: 'unknown',
      reasonCode: 'no_baseline',
    }, NOW);
    expect(out).toBeNull();
  });
});

describe('formatAge', () => {
  it('shows relative minutes under an hour', () => {
    expect(formatAge('2026-04-22T11:30:00Z', NOW)).toBe('30 min ago');
  });
  it('pluralizes hours correctly', () => {
    expect(formatAge('2026-04-22T10:00:00Z', NOW)).toBe('2 hours ago');
    expect(formatAge('2026-04-22T11:00:00Z', NOW)).toBe('1 hour ago');
  });
  it('pluralizes days correctly', () => {
    expect(formatAge('2026-04-21T12:00:00Z', NOW)).toBe('1 day ago');
    expect(formatAge('2026-04-19T12:00:00Z', NOW)).toBe('3 days ago');
  });
  it('switches to absolute after 30 days', () => {
    expect(formatAge('2026-03-01T12:00:00Z', NOW)).toBe('2026-03-01');
  });
  it('returns null for undefined', () => {
    expect(formatAge(undefined, NOW)).toBeNull();
  });
});

describe('formatAheadBehind', () => {
  it('uses + and U+2212 minus', () => {
    expect(formatAheadBehind({ aheadCount: 0, behindCount: 0 })).toBe('+0 / −0');
    expect(formatAheadBehind({ aheadCount: 42, behindCount: 3 })).toBe('+42 / −3');
  });
});

describe('formatDirty', () => {
  it('returns null for a clean worktree when not classified dirty', () => {
    expect(formatDirty({ modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0 }, 'unique_commits')).toBeNull();
  });
  it('returns "clean" for a dirty-classified zero-summary edge case', () => {
    expect(formatDirty({ modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0 }, 'dirty')).toBe('clean');
  });
  it('returns "uncommitted" placeholder for dirty with missing summary', () => {
    expect(formatDirty(undefined, 'dirty')).toBe('uncommitted');
  });
  it('formats mixed counts', () => {
    expect(formatDirty({ modified: 2, added: 1, deleted: 0, renamed: 0, untracked: 3 }, 'dirty')).toBe('M2 A1 U3');
  });
});
