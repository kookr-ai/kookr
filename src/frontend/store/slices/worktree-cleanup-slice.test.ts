import { describe, test, expect, beforeEach } from 'vitest';
import { useKookrStore } from '../useStore.js';
import { createWorktreeCleanupSlice } from './worktree-cleanup-slice.js';
import type { KookrStore, StoreSet } from '../store-types.js';
import type { WorktreeCleanupVerdict } from '../../../shared/contracts/worktree-cleanup-verdict.js';

function verdict(name: string): WorktreeCleanupVerdict {
  return {
    worktreePath: `/wt/${name}`,
    worktreeName: name,
    branch: 'feature',
    removable: true,
    evidence: {},
    checkedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  useKookrStore.getState().clearWorktreeCleanupVerdicts();
});

describe('worktree cleanup verdict slice', () => {
  test('starts with no verdicts', () => {
    const s = useKookrStore.getState();
    expect(s.cleanupVerdicts).toBeNull();
    expect(s.cleanupVerdictsTaskId).toBeNull();
  });

  test('beginning a probe clears prior verdicts so a stale answer is never shown as current', () => {
    useKookrStore.getState().handleWorktreeCleanupVerdicts('t1', [verdict('a')]);
    useKookrStore.getState().beginWorktreeCleanupInspect('t1');

    expect(useKookrStore.getState().cleanupVerdicts).toBeNull();
    expect(useKookrStore.getState().cleanupVerdictsRefreshing).toBe(false);
  });

  test('a refresh keeps the current verdicts on screen while re-probing', () => {
    useKookrStore.getState().beginWorktreeCleanupInspect('t1');
    useKookrStore.getState().handleWorktreeCleanupVerdicts('t1', [verdict('a')]);

    useKookrStore.getState().beginWorktreeCleanupInspect('t1', { refresh: true });

    expect(useKookrStore.getState().cleanupVerdicts).toHaveLength(1);
    expect(useKookrStore.getState().cleanupVerdictsRefreshing).toBe(true);
  });

  test('a reply for a different task is ignored', () => {
    // The dialog was closed and reopened on another task while a probe was in
    // flight; the late reply must not land on the new task's dialog.
    useKookrStore.getState().beginWorktreeCleanupInspect('t2');

    useKookrStore.getState().handleWorktreeCleanupVerdicts('t1', [verdict('stale')]);

    expect(useKookrStore.getState().cleanupVerdicts).toBeNull();
  });

  test('a reply for the current task lands and stops the refreshing state', () => {
    useKookrStore.getState().beginWorktreeCleanupInspect('t1', { refresh: true });

    useKookrStore.getState().handleWorktreeCleanupVerdicts('t1', [verdict('a')]);

    expect(useKookrStore.getState().cleanupVerdicts).toHaveLength(1);
    expect(useKookrStore.getState().cleanupVerdictsRefreshing).toBe(false);
  });

  test('an error is recorded alongside an empty verdict list', () => {
    useKookrStore.getState().beginWorktreeCleanupInspect('t1');

    useKookrStore.getState().handleWorktreeCleanupVerdicts('t1', [], 'git exploded');

    expect(useKookrStore.getState().cleanupVerdicts).toEqual([]);
    expect(useKookrStore.getState().cleanupVerdictsError).toBe('git exploded');
  });

  test('clearing resets everything so the next dialog starts clean', () => {
    useKookrStore.getState().beginWorktreeCleanupInspect('t1');
    useKookrStore.getState().handleWorktreeCleanupVerdicts('t1', [verdict('a')]);

    useKookrStore.getState().clearWorktreeCleanupVerdicts();

    const s = useKookrStore.getState();
    expect(s.cleanupVerdicts).toBeNull();
    expect(s.cleanupVerdictsTaskId).toBeNull();
    expect(s.cleanupVerdictsError).toBeNull();
    expect(s.cleanupVerdictsRefreshing).toBe(false);
  });
});

/**
 * Drive the factory directly, without zustand or the composed store.
 *
 * The suite above exercises the slice through `useKookrStore`, which is the
 * realistic path but routes around the module itself. These cover the reducer
 * logic in isolation — notably the functional `set` in
 * `handleWorktreeCleanupVerdicts`, whose stale-reply guard reads prior state.
 */
function standaloneSlice() {
  let state = {} as KookrStore;
  const set: StoreSet = ((partial) => {
    const next = typeof partial === 'function'
      ? (partial as (s: KookrStore) => Partial<KookrStore>)(state)
      : partial;
    state = { ...state, ...next };
  }) as StoreSet;
  const slice = createWorktreeCleanupSlice(set);
  state = { ...state, ...slice } as KookrStore;
  return { slice, get: () => state };
}

describe('createWorktreeCleanupSlice — standalone', () => {
  test('initial state makes no claim about any task', () => {
    const { slice } = standaloneSlice();

    expect(slice.cleanupVerdictsTaskId).toBeNull();
    expect(slice.cleanupVerdicts).toBeNull();
    expect(slice.cleanupVerdictsError).toBeNull();
    expect(slice.cleanupVerdictsRefreshing).toBe(false);
  });

  test('the stale-reply guard reads prior state through the functional set', () => {
    const { slice, get } = standaloneSlice();
    slice.beginWorktreeCleanupInspect('t1');

    slice.handleWorktreeCleanupVerdicts('other-task', [verdict('a')]);
    expect(get().cleanupVerdicts).toBeNull();

    slice.handleWorktreeCleanupVerdicts('t1', [verdict('a')]);
    expect(get().cleanupVerdicts).toHaveLength(1);
  });

  test('a refresh preserves verdicts while a fresh probe clears them', () => {
    const { slice, get } = standaloneSlice();
    slice.beginWorktreeCleanupInspect('t1');
    slice.handleWorktreeCleanupVerdicts('t1', [verdict('a')]);

    slice.beginWorktreeCleanupInspect('t1', { refresh: true });
    expect(get().cleanupVerdicts).toHaveLength(1);
    expect(get().cleanupVerdictsRefreshing).toBe(true);

    slice.beginWorktreeCleanupInspect('t1');
    expect(get().cleanupVerdicts).toBeNull();
    expect(get().cleanupVerdictsRefreshing).toBe(false);
  });
});
