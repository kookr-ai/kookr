import { describe, expect, test } from 'vitest';
import type { AgentState } from '../shared/protocol.js';
import {
  FINDING_TYPE_FILTER_KEY,
  activeFindingTypeFilter,
  countFindingsByType,
  filterFindingsBySelectedTypes,
  loadFindingTypeFilter,
  presentFindingTypes,
  saveFindingTypeFilter,
  toggleFindingTypeSelection,
} from './finding-type-filter.js';

function makeFinding(id: string, type: NonNullable<AgentState['anomaly']>['type']): AgentState {
  return {
    agentId: id,
    events: [],
    anomaly: {
      agentId: id,
      type,
      severity: 'warning',
      explanation: type,
      detectedAt: new Date('2026-08-13T00:00:00.000Z'),
    },
  };
}

describe('presentFindingTypes', () => {
  test('returns unique types in first-seen order and skips findings without an anomaly', () => {
    const findings = [
      makeFinding('a', 'permission_blocked'),
      makeFinding('b', 'budget_exceeded'),
      makeFinding('c', 'permission_blocked'),
      { agentId: 'd', events: [], anomaly: null } as AgentState,
    ];
    expect(presentFindingTypes(findings)).toEqual(['permission_blocked', 'budget_exceeded']);
  });
});

describe('countFindingsByType', () => {
  test('counts findings per type and skips findings without an anomaly', () => {
    const findings = [
      makeFinding('a', 'permission_blocked'),
      makeFinding('b', 'budget_exceeded'),
      makeFinding('c', 'permission_blocked'),
      { agentId: 'd', events: [], anomaly: null } as AgentState,
    ];
    const counts = countFindingsByType(findings);
    expect(counts.get('permission_blocked')).toBe(2);
    expect(counts.get('budget_exceeded')).toBe(1);
    expect(counts.size).toBe(2);
  });

  test('returns an empty map when there are no findings', () => {
    expect(countFindingsByType([]).size).toBe(0);
  });
});

describe('filterFindingsBySelectedTypes', () => {
  const findings = [
    makeFinding('perm', 'permission_blocked'),
    makeFinding('budget', 'budget_exceeded'),
    makeFinding('idle', 'needs_input'),
  ];

  test('empty selection shows every finding', () => {
    expect(filterFindingsBySelectedTypes(findings, [])).toEqual(findings);
  });

  test('one selected type hides the other cards (OR with a single member)', () => {
    expect(filterFindingsBySelectedTypes(findings, ['permission_blocked']).map((agent) => agent.agentId))
      .toEqual(['perm']);
  });

  test('multi-select is OR: any selected type stays visible', () => {
    expect(filterFindingsBySelectedTypes(findings, ['permission_blocked', 'needs_input']).map((agent) => agent.agentId))
      .toEqual(['perm', 'idle']);
  });

  test('stale selection whose types are no longer present falls back to show-all', () => {
    expect(filterFindingsBySelectedTypes(findings, ['stale_agent'])).toEqual(findings);
  });
});

describe('activeFindingTypeFilter', () => {
  test('drops stored types that are not on the current rail', () => {
    expect(activeFindingTypeFilter(['permission_blocked', 'stale_agent'], ['budget_exceeded', 'permission_blocked']))
      .toEqual(['permission_blocked']);
  });

  test('empty selection stays empty', () => {
    expect(activeFindingTypeFilter([], ['permission_blocked'])).toEqual([]);
  });
});

describe('finding type filter persistence', () => {
  test('round-trips a type list and treats malformed storage as show-all', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    };

    saveFindingTypeFilter(['permission_blocked', 'budget_exceeded'], storage);
    expect(store.get(FINDING_TYPE_FILTER_KEY)).toBe('["permission_blocked","budget_exceeded"]');
    expect(loadFindingTypeFilter(storage)).toEqual(['permission_blocked', 'budget_exceeded']);

    saveFindingTypeFilter([], storage);
    expect(store.has(FINDING_TYPE_FILTER_KEY)).toBe(false);
    expect(loadFindingTypeFilter(storage)).toEqual([]);

    store.set(FINDING_TYPE_FILTER_KEY, '{not-json');
    expect(loadFindingTypeFilter(storage)).toEqual([]);
    store.set(FINDING_TYPE_FILTER_KEY, '{"nope":true}');
    expect(loadFindingTypeFilter(storage)).toEqual([]);
  });
});

describe('toggleFindingTypeSelection', () => {
  test('adds then removes a type without disturbing other selections', () => {
    const added = toggleFindingTypeSelection(['budget_exceeded'], 'permission_blocked');
    expect(added).toEqual(['budget_exceeded', 'permission_blocked']);
    expect(toggleFindingTypeSelection(added, 'permission_blocked')).toEqual(['budget_exceeded']);
  });
});
