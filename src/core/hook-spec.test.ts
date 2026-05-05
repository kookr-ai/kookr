import { describe, test, expect } from 'vitest';
import { HOOK_EVENTS, LOAD_BEARING_HOOKS, HOOK_DESCRIPTIONS } from './hook-spec.js';

describe('hook-spec', () => {
  test('HOOK_EVENTS contains exactly the 12 known hook events', () => {
    expect(HOOK_EVENTS).toEqual([
      'SessionStart',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
      'Stop',
      'StopFailure',
      'Notification',
      'UserPromptSubmit',
      'SubagentStart',
      'SubagentStop',
      'SessionEnd',
    ]);
  });

  test('HOOK_EVENTS has no duplicates', () => {
    expect(new Set(HOOK_EVENTS).size).toBe(HOOK_EVENTS.length);
  });

  test('LOAD_BEARING_HOOKS matches the accepted list from rfc-hook-state-detection.md', () => {
    expect([...LOAD_BEARING_HOOKS].sort()).toEqual([
      'Notification',
      'PermissionRequest',
      'PostToolUse',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'StopFailure',
      'UserPromptSubmit',
    ]);
  });

  test('LOAD_BEARING_HOOKS has 9 members and only contains events in HOOK_EVENTS', () => {
    expect(LOAD_BEARING_HOOKS.size).toBe(9);
    for (const event of LOAD_BEARING_HOOKS) {
      expect(HOOK_EVENTS).toContain(event);
    }
  });

  test('the three non-load-bearing hooks are PostToolUseFailure, SubagentStart, SubagentStop', () => {
    const nonLoadBearing = HOOK_EVENTS.filter((e) => !LOAD_BEARING_HOOKS.has(e));
    expect(nonLoadBearing).toEqual(['PostToolUseFailure', 'SubagentStart', 'SubagentStop']);
  });

  test('HOOK_DESCRIPTIONS covers all HOOK_EVENTS', () => {
    for (const event of HOOK_EVENTS) {
      expect(HOOK_DESCRIPTIONS[event]).toBeDefined();
      expect(HOOK_DESCRIPTIONS[event].length).toBeGreaterThan(0);
    }
  });

  test('HOOK_DESCRIPTIONS has no extra keys beyond HOOK_EVENTS', () => {
    expect(Object.keys(HOOK_DESCRIPTIONS).sort()).toEqual([...HOOK_EVENTS].sort());
  });
});
