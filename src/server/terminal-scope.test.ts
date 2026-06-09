import { describe, expect, test, vi } from 'vitest';

import type { Actor } from './auth.js';
import type { Scope } from './viewer-data-policy.js';
import { createTerminalScopeChecker } from './terminal-scope.js';

const OWNER: Actor = { kind: 'owner' };
function viewer(scope: Scope): Actor {
  return { kind: 'viewer', grantId: 'g1', scope };
}

describe('createTerminalScopeChecker', () => {
  test('owners always pass without any session lookup', () => {
    const resolve = vi.fn();
    const check = createTerminalScopeChecker(resolve);
    expect(check(OWNER, 'kookr-anything')).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  test('an all-scoped viewer passes without a session lookup', () => {
    const resolve = vi.fn();
    const check = createTerminalScopeChecker(resolve);
    expect(check(viewer({ kind: 'all' }), 'kookr-x')).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  test('a projects-scoped viewer passes for an in-scope session', () => {
    const check = createTerminalScopeChecker((name) => (name === 'kookr-a' ? 'p1' : undefined));
    expect(check(viewer({ kind: 'projects', projectIds: ['p1', 'p2'] }), 'kookr-a')).toBe(true);
  });

  test('a projects-scoped viewer is denied for an out-of-scope session', () => {
    const check = createTerminalScopeChecker(() => 'p9');
    expect(check(viewer({ kind: 'projects', projectIds: ['p1'] }), 'kookr-a')).toBe(false);
  });

  test('fail-closed: unknown session (no owning task) is denied', () => {
    const check = createTerminalScopeChecker(() => undefined);
    expect(check(viewer({ kind: 'projects', projectIds: ['p1'] }), 'kookr-missing')).toBe(false);
  });

  test('fail-closed: a task with no project assignment is denied', () => {
    // resolveSessionProjectId returns undefined for an unassigned task.
    const check = createTerminalScopeChecker(() => undefined);
    expect(check(viewer({ kind: 'projects', projectIds: ['p1'] }), 'kookr-unassigned')).toBe(false);
  });

  test('fail-closed: an empty projects scope reaches no session', () => {
    const check = createTerminalScopeChecker(() => 'p1');
    expect(check(viewer({ kind: 'projects', projectIds: [] }), 'kookr-a')).toBe(false);
  });
});
