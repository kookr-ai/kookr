import { describe, test, expect } from 'vitest';
import {
  canonicalizeScope,
  isProjectInScope,
  type Scope,
} from './viewer-scope.js';

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
