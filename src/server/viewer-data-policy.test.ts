import { describe, test, expect } from 'vitest';
import {
  canonicalizeScope,
  isPhase1UnsupportedViewerScope,
  isProjectInScope,
  isViewerAllowedRoute,
  type Scope,
} from './viewer-data-policy.js';

describe('canonicalizeScope', () => {
  test('leaves an `all` scope unchanged', () => {
    const scope: Scope = { kind: 'all' };
    expect(canonicalizeScope(scope)).toEqual({ kind: 'all' });
  });

  test('sorts and dedupes project ids', () => {
    expect(canonicalizeScope({ kind: 'projects', projectIds: ['b', 'a', 'b', 'c', 'a'] })).toEqual({
      kind: 'projects',
      projectIds: ['a', 'b', 'c'],
    });
  });

  test('two orderings canonicalize to the same value', () => {
    const a = canonicalizeScope({ kind: 'projects', projectIds: ['A', 'B'] });
    const b = canonicalizeScope({ kind: 'projects', projectIds: ['B', 'A'] });
    expect(a).toEqual(b);
  });
});

describe('isProjectInScope', () => {
  test('`all` scope sees every project', () => {
    expect(isProjectInScope({ kind: 'all' }, 'anything')).toBe(true);
  });

  test('`projects` scope sees only its listed projects', () => {
    const scope: Scope = { kind: 'projects', projectIds: ['p1', 'p2'] };
    expect(isProjectInScope(scope, 'p1')).toBe(true);
    expect(isProjectInScope(scope, 'p2')).toBe(true);
    expect(isProjectInScope(scope, 'p3')).toBe(false);
  });
});

describe('isViewerAllowedRoute', () => {
  test('only the session cookie-exchange route is allowed for viewers', () => {
    expect(isViewerAllowedRoute('/api/auth/session')).toBe(true);
  });

  test('all data routes — including /api/health — are denied to viewers', () => {
    for (const path of [
      '/api/health',
      '/api/snapshot',
      '/api/files/raw',
      '/api/task-relations',
      '/api/projects',
      '/api/ready',
    ]) {
      expect(isViewerAllowedRoute(path)).toBe(false);
    }
  });
});

describe('isPhase1UnsupportedViewerScope', () => {
  test('an `all` scope is serviceable in Phase 1', () => {
    expect(isPhase1UnsupportedViewerScope({ kind: 'all' })).toBe(false);
  });

  test('a `projects` scope is rejected in Phase 1 (scoped fan-out is #809)', () => {
    expect(isPhase1UnsupportedViewerScope({ kind: 'projects', projectIds: ['p1'] })).toBe(true);
    // Even an empty projects list is not an `all` grant and stays rejected.
    expect(isPhase1UnsupportedViewerScope({ kind: 'projects', projectIds: [] })).toBe(true);
  });
});
