import { describe, expect, test } from 'vitest';
import { isPrMergeCommand } from './pr-merge-command.js';
import { classifyMergeTrailCommand } from './merge-required.js';

describe('isPrMergeCommand', () => {
  test.each([
    'gh pr merge 12 --squash --delete-branch',
    'pnpm merge 3699 --repo kookr-ai/kookr',
    'bash scripts/kookr-merge.sh 42',
    'cd /repo && GH_PROMPT_DISABLED=1 gh  pr   merge 7',
  ])('recognises a merge: %s', (cmd) => {
    expect(isPrMergeCommand(cmd)).toBe(true);
  });

  test.each([
    'gh pr create --base main',
    'gh pr view 12 --json mergedAt',
    'git merge --no-edit origin/main',
    'pnpm mergeable-check',
  ])('ignores a non-merge: %s', (cmd) => {
    expect(isPrMergeCommand(cmd)).toBe(false);
  });

  test('the merge-required classifier still ranks a blocker marker above a merge', () => {
    expect(classifyMergeTrailCommand("pnpm merge 1; printf 'PR-BLOCKER: x'")).toBe('pr-blocker');
    expect(classifyMergeTrailCommand('pnpm merge 1')).toBe('pr-merge');
  });
});
