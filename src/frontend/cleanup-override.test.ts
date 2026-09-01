import { describe, test, expect } from 'vitest';
import { resolveCleanupOverride } from './cleanup-override.js';
import type { WorktreeCleanupVerdict } from '../shared/contracts/worktree-cleanup-verdict.js';

function verdict(removable: boolean): WorktreeCleanupVerdict {
  return {
    worktreePath: '/wt/feature',
    worktreeName: 'feature',
    branch: 'feature',
    removable,
    ...(removable ? {} : { blocker: 'uncommitted-changes' as const }),
    evidence: {},
    checkedAt: '2026-07-17T00:00:00.000Z',
  };
}

const base = {
  verdicts: [verdict(true)] as WorktreeCleanupVerdict[] | null,
  inspectFailed: false,
  ralphActive: false,
  touched: false,
  savedDefault: true as boolean | undefined,
  checkboxValue: true,
};

describe('resolveCleanupOverride — probe in flight', () => {
  test('makes no claim, so the server default still applies', () => {
    // The dialog shows an indeterminate box at this point; sending false would
    // assert something the user was never told.
    expect(resolveCleanupOverride({ ...base, verdicts: null })).toBeUndefined();
  });
});

describe('resolveCleanupOverride — inspection failed', () => {
  test('defers to the server rather than silently disabling cleanup', () => {
    // The regression this guards: sending `false` would let a transient git
    // failure override a user whose saved setting is "clean up".
    expect(resolveCleanupOverride({ ...base, verdicts: [], inspectFailed: true })).toBeUndefined();
  });

  test('still honours an explicit choice', () => {
    expect(resolveCleanupOverride({
      ...base, verdicts: [], inspectFailed: true, touched: true, checkboxValue: false,
    })).toBe(false);
    expect(resolveCleanupOverride({
      ...base, verdicts: [], inspectFailed: true, touched: true, checkboxValue: true,
    })).toBe(true);
  });
});

describe('resolveCleanupOverride — Ralph loop', () => {
  test('refuses immediately, without waiting for a probe', () => {
    // ralphActive is known client-side; gating it behind the probe would leave
    // the in-flight window making no claim at all.
    expect(resolveCleanupOverride({ ...base, verdicts: null, ralphActive: true })).toBe(false);
  });

  test('refuses even when the server reports the worktree removable', () => {
    expect(resolveCleanupOverride({ ...base, verdicts: [verdict(true)], ralphActive: true })).toBe(false);
  });

  test('refuses even when the user checked the box before the loop started', () => {
    expect(resolveCleanupOverride({
      ...base, ralphActive: true, touched: true, checkboxValue: true,
    })).toBe(false);
  });

  test('refuses when the inspection also failed', () => {
    // Both conditions at once: the loop is known client-side, so it decides
    // even though removability is unknown. The UI must agree — see the
    // matching CleanupWorktreeOption case.
    expect(resolveCleanupOverride({
      ...base, verdicts: [], inspectFailed: true, ralphActive: true,
    })).toBe(false);
    expect(resolveCleanupOverride({
      ...base, verdicts: [], inspectFailed: true, ralphActive: true, touched: true, checkboxValue: true,
    })).toBe(false);
  });
});

describe('resolveCleanupOverride — blocked', () => {
  test('says "no" explicitly instead of omitting the field', () => {
    // Omitting it would let the server default contradict the "kept — …" the
    // user just read.
    expect(resolveCleanupOverride({ ...base, verdicts: [verdict(false)] })).toBe(false);
  });

  test('a task with no worktrees claims nothing to remove', () => {
    expect(resolveCleanupOverride({ ...base, verdicts: [] })).toBe(false);
  });

  test('mixed verdicts stay live while any worktree is removable', () => {
    expect(resolveCleanupOverride({
      ...base, verdicts: [verdict(false), verdict(true)], checkboxValue: true,
    })).toBe(true);
  });
});

describe('resolveCleanupOverride — worktree already gone', () => {
  function gone(): WorktreeCleanupVerdict {
    return { ...verdict(false), blocker: 'not-found' };
  }

  test('still vetoes, even though the dialog calls it an outcome rather than a refusal', () => {
    // The dialog shows a disabled box for an all-gone task, so the wire must
    // say no. Deferring to the server's setting would let the cleanup
    // re-inspect at execution and act on what it finds then — and `not-found`
    // rests on a single `existsSync`, which also reads false for a briefly
    // unreachable mount. A real worktree would be removed with `force: true`
    // right after the user was told there was nothing to clean up.
    expect(resolveCleanupOverride({ ...base, verdicts: [gone()] })).toBe(false);
  });

  test('a real blocker alongside it still vetoes', () => {
    expect(resolveCleanupOverride({ ...base, verdicts: [gone(), verdict(false)] })).toBe(false);
  });

  test('a removable worktree alongside it still honours the checkbox', () => {
    expect(resolveCleanupOverride({
      ...base, verdicts: [gone(), verdict(true)], checkboxValue: true,
    })).toBe(true);
    expect(resolveCleanupOverride({
      ...base, verdicts: [gone(), verdict(true)], checkboxValue: false,
    })).toBe(false);
  });

  test('a running loop vetoes it too, without consulting the verdict', () => {
    expect(resolveCleanupOverride({
      ...base, verdicts: [gone()], ralphActive: true, touched: true, checkboxValue: true,
    })).toBe(false);
  });
});

describe('resolveCleanupOverride — removable', () => {
  test('sends the checkbox value once the saved default is known', () => {
    expect(resolveCleanupOverride({ ...base, checkboxValue: true })).toBe(true);
    expect(resolveCleanupOverride({ ...base, checkboxValue: false })).toBe(false);
  });

  test('defers to the server when the saved default has not loaded and the user has not chosen', () => {
    expect(resolveCleanupOverride({ ...base, savedDefault: undefined })).toBeUndefined();
  });

  test('an explicit choice wins even before the saved default loads', () => {
    expect(resolveCleanupOverride({
      ...base, savedDefault: undefined, touched: true, checkboxValue: false,
    })).toBe(false);
  });
});
