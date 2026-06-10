import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { clearSelectedTask, loadSelectedTask, saveSelectedTask } from './selected-task-storage.js';

describe('selected task storage', () => {
  let localStore: Map<string, string>;

  beforeEach(() => {
    localStore = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStore.get(key) ?? null,
      setItem: (key: string, value: string) => localStore.set(key, value),
      removeItem: (key: string) => localStore.delete(key),
      clear: () => localStore.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('saves and loads the selected task', () => {
    saveSelectedTask('task-1', 'agent-1', 123);

    expect(loadSelectedTask()).toEqual({
      taskId: 'task-1',
      agentId: 'agent-1',
      selectedAt: 123,
    });
  });

  test('supports agent-only selections when task id is unavailable', () => {
    saveSelectedTask(null, 'agent-1', 456);

    expect(loadSelectedTask()).toEqual({
      taskId: null,
      agentId: 'agent-1',
      selectedAt: 456,
    });
  });

  test('clears the selected task', () => {
    saveSelectedTask('task-1', 'agent-1', 123);

    clearSelectedTask();

    expect(loadSelectedTask()).toBeNull();
  });

  test('removes invalid stored data', () => {
    localStore.set('kookr-selected-task', JSON.stringify({ taskId: '', agentId: '', selectedAt: 123 }));

    expect(loadSelectedTask()).toBeNull();
    expect(localStore.has('kookr-selected-task')).toBe(false);
  });

  test('falls back safely when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      removeItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      clear: () => {},
    });

    expect(loadSelectedTask()).toBeNull();
    expect(() => saveSelectedTask('task-1', 'agent-1')).not.toThrow();
    expect(() => clearSelectedTask()).not.toThrow();
  });
});
