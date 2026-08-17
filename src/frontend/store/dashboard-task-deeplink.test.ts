// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createKookrStore } from './useStore.js';

describe('dashboard ?task= deep link', () => {
  let localStore: Map<string, string>;

  beforeEach(() => {
    localStore = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStore.get(key) ?? null,
      setItem: (key: string, value: string) => localStore.set(key, value),
      removeItem: (key: string) => localStore.delete(key),
      clear: () => localStore.clear(),
    });
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
  });

  test('selects the named task on first snapshot even when storage has another task', () => {
    localStore.set('kookr-selected-task', JSON.stringify({
      taskId: 'task-stored',
      agentId: 'agent-stored',
      selectedAt: 123,
    }));
    window.history.replaceState(null, '', '/?task=task-deep');
    const store = createKookrStore();

    store.getState().handleSnapshot([
      { agentId: 'agent-stored', taskId: 'task-stored', events: [], anomaly: null },
      { agentId: 'agent-deep', taskId: 'task-deep', events: [], anomaly: null },
    ]);

    expect(store.getState().selectedAgentId).toBe('agent-deep');
    expect(store.getState().selectedTaskId).toBe('task-deep');
    expect(window.location.search).toBe('');
    expect(JSON.parse(localStore.get('kookr-selected-task') ?? 'null')).toMatchObject({
      taskId: 'task-deep',
      agentId: 'agent-deep',
    });
  });

  test('unknown task id with no stored selection leaves the dashboard unselected', () => {
    window.history.replaceState(null, '', '/?task=task-missing');
    const store = createKookrStore();

    store.getState().handleSnapshot([
      { agentId: 'agent-live', taskId: 'task-live', events: [], anomaly: null },
    ]);

    expect(store.getState().selectedAgentId).toBeNull();
    expect(store.getState().selectedTaskId).toBeNull();
    expect(window.location.search).toBe('');
  });

  test('unknown task id falls back to the stored selection and does not clear it', () => {
    localStore.set('kookr-selected-task', JSON.stringify({
      taskId: 'task-stored',
      agentId: 'agent-stored',
      selectedAt: 123,
    }));
    window.history.replaceState(null, '', '/?task=task-missing');
    const store = createKookrStore();

    store.getState().handleSnapshot([
      { agentId: 'agent-stored', taskId: 'task-stored', events: [], anomaly: null },
    ]);

    expect(store.getState().selectedAgentId).toBe('agent-stored');
    expect(store.getState().selectedTaskId).toBe('task-stored');
    expect(window.location.search).toBe('');
  });

  test('does not override a selection already made before the first snapshot', () => {
    window.history.replaceState(null, '', '/?task=task-deep');
    const store = createKookrStore();
    store.getState().selectAgent('agent-1', 'task-1');

    store.getState().handleSnapshot([
      { agentId: 'agent-1', taskId: 'task-1', events: [], anomaly: null },
      { agentId: 'agent-deep', taskId: 'task-deep', events: [], anomaly: null },
    ]);

    expect(store.getState().selectedAgentId).toBe('agent-1');
    expect(store.getState().selectedTaskId).toBe('task-1');
    expect(window.location.search).toBe('');
  });

  test('does not re-apply the query after hydration', () => {
    window.history.replaceState(null, '', '/?task=task-deep');
    const store = createKookrStore();
    store.getState().handleSnapshot([
      { agentId: 'agent-1', taskId: 'task-1', events: [], anomaly: null },
      { agentId: 'agent-deep', taskId: 'task-deep', events: [], anomaly: null },
    ]);
    store.getState().selectAgent('agent-1');
    window.history.replaceState(null, '', '/?task=task-deep');

    store.getState().handleSnapshot([
      { agentId: 'agent-1', taskId: 'task-1', events: [], anomaly: null },
      { agentId: 'agent-deep', taskId: 'task-deep', events: [], anomaly: null },
    ]);

    expect(store.getState().selectedAgentId).toBe('agent-1');
    expect(store.getState().selectedTaskId).toBe('task-1');
    // Query is left alone after hydration; only the first snapshot consumes it.
    expect(window.location.search).toBe('?task=task-deep');
  });

  test('keeps sibling query params when dropping task=', () => {
    window.history.replaceState(null, '', '/?task=task-deep&debug=1');
    const store = createKookrStore();

    store.getState().handleSnapshot([
      { agentId: 'agent-deep', taskId: 'task-deep', events: [], anomaly: null },
    ]);

    expect(store.getState().selectedAgentId).toBe('agent-deep');
    expect(window.location.search).toBe('?debug=1');
  });

  test('keeps the hash when consuming task=', () => {
    window.history.replaceState(null, '', '/?task=task-deep#pane');
    const store = createKookrStore();

    store.getState().handleSnapshot([
      { agentId: 'agent-deep', taskId: 'task-deep', events: [], anomaly: null },
    ]);

    expect(store.getState().selectedAgentId).toBe('agent-deep');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#pane');
  });
});
