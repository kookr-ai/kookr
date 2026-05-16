import { describe, expect, test } from 'vitest';
import { cleanupResultMessage } from './workspace-slice.js';
import type { CleanupResultSummary } from '../../../shared/contracts/workspace.js';

describe('cleanupResultMessage', () => {
  const cases: Array<{ result: CleanupResultSummary; expectedSeverity: 'info' | 'error'; expectedSubstring: string }> = [
    {
      result: { branch: 'feat/test', disposition: 'completed', pathRemoved: true, branchRemoved: true },
      expectedSeverity: 'info',
      expectedSubstring: 'Removed worktree and branch',
    },
    {
      result: {
        branch: 'feat/test',
        disposition: 'path_removed_branch_retained',
        pathRemoved: true,
        branchRemoved: false,
        retainedReason: 'ref_changed',
      },
      expectedSeverity: 'info',
      expectedSubstring: 'branch was retained',
    },
    {
      result: {
        branch: 'feat/test',
        disposition: 'prune_failed',
        pathRemoved: true,
        branchRemoved: false,
        errorKind: 'prune_failed',
      },
      expectedSeverity: 'error',
      expectedSubstring: 'prune failed',
    },
    {
      result: {
        branch: 'feat/test',
        disposition: 'branch_delete_failed',
        pathRemoved: true,
        branchRemoved: false,
        errorKind: 'branch_delete_failed',
      },
      expectedSeverity: 'error',
      expectedSubstring: 'branch deletion failed',
    },
  ];

  for (const { result, expectedSeverity, expectedSubstring } of cases) {
    test(`${result.disposition} → severity=${expectedSeverity}`, () => {
      const message = cleanupResultMessage(result);
      expect(message.severity).toBe(expectedSeverity);
      expect(message.summary).toContain(expectedSubstring);
      expect(message.summary).toContain('feat/test');
    });
  }
});
