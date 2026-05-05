import { describe, test, expect } from 'vitest';
import type { GitHubReference, GitHubPRState } from './github-types.js';
import { GitHubStateStore } from './github-state-store.js';

function makeRef(number = 42, taskId = 'task-1'): GitHubReference {
  return {
    type: 'pr',
    owner: 'kookr-ai',
    repo: 'kookr',
    number,
    url: `https://github.com/kookr-ai/kookr/pull/${number}`,
    detectedAt: new Date(),
    detectedFrom: 'agent-1',
    taskId,
  };
}

function makePRState(ref: GitHubReference): GitHubPRState {
  return {
    ref,
    title: `PR #${ref.number}`,
    status: 'open',
    author: 'jeanibarz',
    branch: 'feat-test',
    baseBranch: 'main',
    reviewDecision: null,
    reviewers: [],
    unresolvedThreads: [],
    totalComments: 0,
    checks: [],
    lastFetchedAt: new Date(),
  };
}

describe('GitHubStateStore', () => {
  test('addReference adds a new reference', () => {
    const store = new GitHubStateStore();
    const ref = makeRef();
    expect(store.addReference(ref)).toBe(true);
    expect(store.getAllReferences()).toHaveLength(1);
  });

  test('addReference deduplicates by owner/repo/number', () => {
    const store = new GitHubStateStore();
    const ref1 = makeRef(42);
    const ref2 = makeRef(42); // same number
    expect(store.addReference(ref1)).toBe(true);
    expect(store.addReference(ref2)).toBe(false);
    expect(store.getAllReferences()).toHaveLength(1);
  });

  test('getReferences filters by taskId', () => {
    const store = new GitHubStateStore();
    store.addReference(makeRef(1, 'task-1'));
    store.addReference(makeRef(2, 'task-2'));
    expect(store.getReferences('task-1')).toHaveLength(1);
    expect(store.getReferences('task-2')).toHaveLength(1);
  });

  test('updatePRState stores and returns previous state', () => {
    const store = new GitHubStateStore();
    const ref = makeRef();
    store.addReference(ref);

    const state1 = makePRState(ref);
    expect(store.updatePRState(state1)).toBeNull(); // first time

    const state2 = { ...makePRState(ref), totalComments: 5 };
    const prev = store.updatePRState(state2);
    expect(prev).not.toBeNull();
    expect(prev!.totalComments).toBe(0);
  });

  test('getPRState returns current state', () => {
    const store = new GitHubStateStore();
    const ref = makeRef();
    store.addReference(ref);
    store.updatePRState(makePRState(ref));

    const state = store.getPRState({ owner: 'kookr-ai', repo: 'kookr', number: 42 });
    expect(state).not.toBeNull();
    expect(state!.title).toBe('PR #42');
  });

  test('addChange and consumeChanges work correctly', () => {
    const store = new GitHubStateStore();
    const ref = makeRef();

    store.addChange('task-1', { type: 'ci_failed', ref, check: { name: 'CI', conclusion: 'failure' } });
    store.addChange('task-1', { type: 'pr_merged', ref });

    const changes = store.consumeChanges('task-1');
    expect(changes).toHaveLength(2);

    // Consumed — should be empty now
    expect(store.consumeChanges('task-1')).toHaveLength(0);
  });

  test('peekChanges does not clear changes', () => {
    const store = new GitHubStateStore();
    const ref = makeRef();

    store.addChange('task-1', { type: 'pr_merged', ref });
    expect(store.peekChanges('task-1')).toHaveLength(1);
    expect(store.peekChanges('task-1')).toHaveLength(1); // still there
  });

  test('getTaskState aggregates PRs, issues, and changes', () => {
    const store = new GitHubStateStore();
    const ref = makeRef(42, 'task-1');
    store.addReference(ref);
    store.updatePRState(makePRState(ref));

    const state = store.getTaskState('task-1');
    expect(state.taskId).toBe('task-1');
    expect(state.prs).toHaveLength(1);
    expect(state.issues).toHaveLength(0);
  });

  test('getTaskIdsWithReferences returns unique task IDs', () => {
    const store = new GitHubStateStore();
    store.addReference(makeRef(1, 'task-1'));
    store.addReference(makeRef(2, 'task-1'));
    store.addReference(makeRef(3, 'task-2'));

    const taskIds = store.getTaskIdsWithReferences();
    expect(taskIds).toHaveLength(2);
    expect(taskIds).toContain('task-1');
    expect(taskIds).toContain('task-2');
  });

  test('removeTask clears all data for a task', () => {
    const store = new GitHubStateStore();
    const ref = makeRef(42, 'task-1');
    store.addReference(ref);
    store.updatePRState(makePRState(ref));
    store.addChange('task-1', { type: 'pr_merged', ref });

    store.removeTask('task-1');
    expect(store.getReferences('task-1')).toHaveLength(0);
    expect(store.getPRState({ owner: 'kookr-ai', repo: 'kookr', number: 42 })).toBeNull();
    expect(store.peekChanges('task-1')).toHaveLength(0);
  });
});
