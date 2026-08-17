import { describe, expect, test } from 'vitest';
import type { ActivityItem } from '../shared/protocol.js';
import {
  ACTIVITY_ROLE_FILTER_KEY,
  activityItemRole,
  filterActivityItems,
  loadActivityRoleFilter,
  saveActivityRoleFilter,
  shouldShowActivityFilterEmptyState,
} from './activity-role-filter.js';

const user: ActivityItem = { type: 'user_message', text: 'please fix the test' };
const delivery: ActivityItem = {
  type: 'user_input_delivery',
  delivery: {
    deliveryId: 'd1',
    sessionId: 's1',
    deliverySeq: 1,
    source: 'respond',
    text: 'try this patch',
    status: 'queued',
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  },
};
const agent: ActivityItem = { type: 'agent_message', text: 'done' };
const tools: ActivityItem = {
  type: 'tool_group',
  entries: [{ toolName: 'Bash', category: 'bash', count: 1, errors: 0, detail: 'npm test' }],
  totalCalls: 1,
  totalErrors: 0,
};
const notice: ActivityItem = {
  type: 'system_notice',
  subType: 'session_start',
  text: 'Session started',
};
const items = [user, delivery, agent, tools, notice];

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    store,
  };
}

describe('activityItemRole', () => {
  test('maps operator, assistant, and tool rows to their chips', () => {
    expect(activityItemRole(user)).toBe('you');
    expect(activityItemRole(delivery)).toBe('you');
    expect(activityItemRole({ type: 'user_paste_burst', lineCount: 2, lines: ['a', 'b'], contentKind: 'text' }))
      .toBe('you');
    expect(activityItemRole(agent)).toBe('agent');
    expect(activityItemRole(tools)).toBe('tools');
    expect(activityItemRole(notice)).toBe('other');
  });
});

describe('filterActivityItems', () => {
  test('All keeps every row including system notices', () => {
    expect(filterActivityItems(items, 'all')).toEqual(items);
  });

  test('Tools hides user and assistant rows and keeps tool rows', () => {
    expect(filterActivityItems(items, 'tools')).toEqual([tools]);
  });

  test('You keeps only operator-typed rows', () => {
    expect(filterActivityItems(items, 'you')).toEqual([user, delivery]);
  });

  test('Agent keeps only assistant text', () => {
    expect(filterActivityItems(items, 'agent')).toEqual([agent]);
  });
});

describe('shouldShowActivityFilterEmptyState', () => {
  test('stays hidden on All even when the stream is empty', () => {
    expect(shouldShowActivityFilterEmptyState({ filter: 'all', matchedCount: 0, isActive: false })).toBe(false);
  });

  test('appears when You or Agent match nothing', () => {
    expect(shouldShowActivityFilterEmptyState({ filter: 'you', matchedCount: 0, isActive: false })).toBe(true);
    expect(shouldShowActivityFilterEmptyState({ filter: 'agent', matchedCount: 0, isActive: true })).toBe(true);
  });

  test('does not claim Tools is empty while the live working row is the in-flight tool', () => {
    expect(shouldShowActivityFilterEmptyState({ filter: 'tools', matchedCount: 0, isActive: true })).toBe(false);
    expect(shouldShowActivityFilterEmptyState({ filter: 'tools', matchedCount: 0, isActive: false })).toBe(true);
  });

  test('stays hidden when the chip already matched at least one row', () => {
    expect(shouldShowActivityFilterEmptyState({ filter: 'tools', matchedCount: 1, isActive: false })).toBe(false);
    expect(shouldShowActivityFilterEmptyState({ filter: 'you', matchedCount: 2, isActive: true })).toBe(false);
  });
});

describe('activity role filter persistence', () => {
  test('round-trips a chip choice and treats malformed storage as All', () => {
    const storage = memoryStorage();

    saveActivityRoleFilter('tools', storage);
    expect(storage.store.get(ACTIVITY_ROLE_FILTER_KEY)).toBe('tools');
    expect(loadActivityRoleFilter(storage)).toBe('tools');

    storage.store.set(ACTIVITY_ROLE_FILTER_KEY, 'nope');
    expect(loadActivityRoleFilter(storage)).toBe('all');
    expect(loadActivityRoleFilter(null)).toBe('all');
  });
});
