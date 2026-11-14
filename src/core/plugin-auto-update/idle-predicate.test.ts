import { describe, test, expect } from 'vitest';
import {
  busyTasksForPlugin,
  isPluginIdle,
  loadoutIncludesPlugin,
  type IdlePredicateTaskView,
} from './idle-predicate.js';
import type { TaskLoadoutRecord } from '../../shared/contracts/plugins.js';

function record(partial: {
  enabledOverrides?: Record<string, boolean>;
  enabledSet?: string[];
}): TaskLoadoutRecord {
  return {
    resolved: {
      enabledOverrides: partial.enabledOverrides ?? {},
      deniedSkills: [],
      ...(partial.enabledSet ? { enabledSet: partial.enabledSet } : {}),
    },
    winningLevel: 'project',
    mode: 'bypass',
    settingsHash: null,
    settingsPath: null,
    recordedAt: '2026-01-01T00:00:00.000Z',
  };
}

const P = 'stripe@mkt';

describe('loadoutIncludesPlugin', () => {
  test('bypass allowlist membership counts as included', () => {
    expect(loadoutIncludesPlugin(record({ enabledSet: [P] }), P)).toBe(true);
    expect(loadoutIncludesPlugin(record({ enabledSet: ['other@mkt'] }), P)).toBe(false);
  });
  test('explicit enabled override counts as included', () => {
    expect(loadoutIncludesPlugin(record({ enabledOverrides: { [P]: true } }), P)).toBe(true);
  });
  test('explicit disabled override is NOT included', () => {
    expect(loadoutIncludesPlugin(record({ enabledOverrides: { [P]: false } }), P)).toBe(false);
  });
  test('unmentioned plugin is NOT included', () => {
    expect(loadoutIncludesPlugin(record({ enabledOverrides: { 'x@mkt': true } }), P)).toBe(false);
  });
});

describe('busyTasksForPlugin / isPluginIdle', () => {
  test('a terminal task never blocks', () => {
    const tasks: IdlePredicateTaskView[] = [{ id: 't1', isTerminal: true, loadout: undefined }];
    expect(busyTasksForPlugin(P, tasks)).toEqual([]);
    expect(isPluginIdle(P, tasks)).toBe(true);
  });

  test('a non-terminal task with UNKNOWN loadout depends on everything (busy)', () => {
    const tasks: IdlePredicateTaskView[] = [{ id: 't1', isTerminal: false, loadout: undefined }];
    expect(busyTasksForPlugin(P, tasks)).toEqual(['t1']);
    expect(busyTasksForPlugin('anything@else', tasks)).toEqual(['t1']);
    expect(isPluginIdle(P, tasks)).toBe(false);
  });

  test('a recorded loadout that includes P is busy; one that does not is idle', () => {
    const tasks: IdlePredicateTaskView[] = [
      { id: 'uses-P', isTerminal: false, loadout: record({ enabledSet: [P] }) },
      { id: 'uses-other', isTerminal: false, loadout: record({ enabledSet: ['other@mkt'] }) },
      { id: 'disables-P', isTerminal: false, loadout: record({ enabledOverrides: { [P]: false } }) },
    ];
    expect(busyTasksForPlugin(P, tasks)).toEqual(['uses-P']);
    expect(isPluginIdle(P, tasks)).toBe(false);
    expect(isPluginIdle('unused@mkt', tasks)).toBe(true);
  });

  test('busy ids are returned sorted', () => {
    const tasks: IdlePredicateTaskView[] = [
      { id: 'b', isTerminal: false, loadout: undefined },
      { id: 'a', isTerminal: false, loadout: record({ enabledSet: [P] }) },
    ];
    expect(busyTasksForPlugin(P, tasks)).toEqual(['a', 'b']);
  });
});

describe('busyTasksForPlugin — non-Claude tasks', () => {
  test('a running non-Claude task with no record does not block an update', () => {
    expect(busyTasksForPlugin('p@m', [{ id: 'codex', isTerminal: false, loadout: undefined, agentType: 'codex-cli' }])).toEqual([]);
  });
  test('a running Claude task with no record still blocks (conservative)', () => {
    expect(busyTasksForPlugin('p@m', [{ id: 'cc', isTerminal: false, loadout: undefined, agentType: 'claude-code' }])).toEqual(['cc']);
  });
  test('unknown agent type stays conservative', () => {
    expect(busyTasksForPlugin('p@m', [{ id: 'x', isTerminal: false, loadout: undefined }])).toEqual(['x']);
  });
});
