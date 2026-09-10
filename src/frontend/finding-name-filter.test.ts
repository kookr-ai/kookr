import { describe, expect, test } from 'vitest';
import {
  FINDING_NAME_FILTER_KEY,
  filterFindingsByName,
  findingDisplayName,
  loadFindingNameFilter,
  saveFindingNameFilter,
} from './finding-name-filter.js';
import type { AgentState } from '../shared/protocol.js';

function makeFinding(agentId: string, taskName?: string): AgentState {
  return { agentId, taskId: `task-${agentId}`, taskName } as AgentState;
}

describe('findingDisplayName', () => {
  test('prefers the task name, falls back to the agent id', () => {
    expect(findingDisplayName(makeFinding('a1', 'Fix login'))).toBe('Fix login');
    expect(findingDisplayName(makeFinding('a1'))).toBe('a1');
  });

  test('an explicit empty task name is used as-is (matches the card display convention)', () => {
    // The rail card renders `taskName ?? agentId`, so an empty string is shown
    // verbatim there too — the filter deliberately mirrors that, not the id.
    expect(findingDisplayName(makeFinding('a1', ''))).toBe('');
  });
});

describe('filterFindingsByName', () => {
  const findings = [
    makeFinding('a1', 'Fix login flow'),
    makeFinding('a2', 'Add search box'),
    makeFinding('a3', 'refactor SEARCH index'),
    makeFinding('bare-id-only'),
  ];

  test('empty or whitespace query returns the list unchanged', () => {
    expect(filterFindingsByName(findings, '')).toEqual(findings);
    expect(filterFindingsByName(findings, '   ')).toEqual(findings);
  });

  test('matches case-insensitively as a substring', () => {
    expect(filterFindingsByName(findings, 'search').map((f) => f.agentId)).toEqual(['a2', 'a3']);
    expect(filterFindingsByName(findings, 'LOGIN').map((f) => f.agentId)).toEqual(['a1']);
  });

  test('falls back to the agent id when there is no task name', () => {
    expect(filterFindingsByName(findings, 'bare-id').map((f) => f.agentId)).toEqual(['bare-id-only']);
  });

  test('a no-match query returns an empty list', () => {
    expect(filterFindingsByName(findings, 'zzzz')).toEqual([]);
  });
});

describe('load/save persistence', () => {
  test('saves a non-empty query and reads it back', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    saveFindingNameFilter('deploy', storage);
    expect(store.get(FINDING_NAME_FILTER_KEY)).toBe('deploy');
    expect(loadFindingNameFilter(storage)).toBe('deploy');
  });

  test('an empty/whitespace query clears the stored key', () => {
    const store = new Map<string, string>([[FINDING_NAME_FILTER_KEY, 'old']]);
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    saveFindingNameFilter('   ', storage);
    expect(store.has(FINDING_NAME_FILTER_KEY)).toBe(false);
    expect(loadFindingNameFilter(storage)).toBe('');
  });

  test('load fails soft to empty string with no storage', () => {
    expect(loadFindingNameFilter(null)).toBe('');
  });

  test('load and save fail soft when storage access throws (private mode)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(loadFindingNameFilter(throwing)).toBe('');
    expect(() => saveFindingNameFilter('deploy', throwing)).not.toThrow();
    expect(() => saveFindingNameFilter('', throwing)).not.toThrow();
  });
});
