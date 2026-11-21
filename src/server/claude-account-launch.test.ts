import { describe, expect, test } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import {
  emptyClaudeAccountRegistry,
  withAccount,
  withDefaultAccount,
  type ClaudeAccountRegistry,
} from '../core/claude-accounts.js';
import { resolveClaudeAccountLaunch } from './claude-account-launch.js';

const TOKEN_A = 'sk-ant-oat01-' + 'a'.repeat(40);
const TOKEN_B = 'sk-ant-oat01-' + 'b'.repeat(40);

function twoAccounts(defaultName?: string): ClaudeAccountRegistry {
  const registry = withAccount(withAccount(emptyClaudeAccountRegistry(), 'work', TOKEN_A), 'personal', TOKEN_B);
  return defaultName ? withDefaultAccount(registry, defaultName) : registry;
}

describe('resolveClaudeAccountLaunch', () => {
  test('the first launch pins the default, so a later default change does not move the task', () => {
    const store = new TaskStore();
    const task = store.createTask('do it', '/repo');
    let registry = twoAccounts('work');

    expect(resolveClaudeAccountLaunch(store, task.id, () => registry)).toEqual({
      account: 'work',
      env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', KOOKR_CLAUDE_ACCOUNT: 'work' },
    });
    expect(store.getTask(task.id)?.metadata?.claudeAccount).toBe('work');

    registry = withDefaultAccount(registry, 'personal');
    expect(resolveClaudeAccountLaunch(store, task.id, () => registry).account).toBe('work');
  });

  test('with no registered accounts nothing is pinned and no env is injected', () => {
    const store = new TaskStore();
    const task = store.createTask('do it', '/repo');

    expect(resolveClaudeAccountLaunch(store, task.id, emptyClaudeAccountRegistry)).toEqual({ account: 'host', env: {} });
    expect(store.getTask(task.id)?.metadata).toBeUndefined();
  });

  test('an unpinned task pins host when accounts exist but none is the default', () => {
    const store = new TaskStore();
    const task = store.createTask('do it', '/repo');

    expect(resolveClaudeAccountLaunch(store, task.id, () => twoAccounts()).account).toBe('host');
    expect(store.getTask(task.id)?.metadata?.claudeAccount).toBe('host');
  });

  test('a host-pinned task launches even when the registry is unreadable', () => {
    const store = new TaskStore();
    const task = store.createTask('do it', '/repo');
    store.setClaudeAccount(task.id, 'host');

    const result = resolveClaudeAccountLaunch(store, task.id, () => {
      throw new Error('corrupt');
    });
    expect(result).toEqual({ account: 'host', env: {} });
  });

  test('a task pinned to a removed account fails its launch', () => {
    const store = new TaskStore();
    const task = store.createTask('do it', '/repo');
    store.setClaudeAccount(task.id, 'gone');

    expect(() => resolveClaudeAccountLaunch(store, task.id, () => twoAccounts())).toThrow(/no longer registered/);
  });
});
