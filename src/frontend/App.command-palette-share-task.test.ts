// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../shared/protocol.js';
import { App } from './App.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';

const { sendMock, detailPanelProps } = vi.hoisted(() => ({
  sendMock: vi.fn(() => true),
  // Captures the most recent props App passed to DetailPanel, so we can assert
  // the palette action's run handler actually threaded through to the nonce
  // prop without mounting the heavy real component.
  detailPanelProps: { current: null as { shareRequestNonce?: number } | null },
}));

vi.mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({ send: sendMock }),
}));
vi.mock('./hooks/useNotifications.js', () => ({ useNotifications: () => {} }));
vi.mock('./hooks/useAudibleAlert.js', () => ({
  useAudibleAlert: () => {},
  isSoundEnabled: () => true,
  setSoundEnabled: vi.fn(),
}));
vi.mock('./telemetry.js', () => ({
  initTelemetry: vi.fn(),
  track: vi.fn(),
  trackClick: vi.fn(),
}));
// DetailPanel is heavy; stub it but record its props to verify App's wiring.
vi.mock('./components/DetailPanel.js', () => ({
  DetailPanel: (props: { shareRequestNonce?: number }) => {
    detailPanelProps.current = props;
    return React.createElement('div', { 'data-testid': 'detail-panel' });
  },
}));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Shared task',
    events: [],
    anomaly: null,
    agentType: 'codex-cli',
    cwd: '/tmp/kookr',
    startedAt: '2026-05-17T12:00:00.000Z',
    taskStatus: 'inProgress',
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openPalette(container: Element): Promise<HTMLInputElement> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    await flush();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]');
    if (input) return input;
  }
  throw new Error('command palette did not open');
}

// #2754: the App-level wiring the CommandPalette component tests can't reach —
// App gates the "Share this task" palette entry on whether a task is selected.
describe('App command-palette "Share this task" entry (#2754)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    sendMock.mockClear();
    detailPanelProps.current = null;
    syncGlobalStore();
    useKookrStore.setState({ serverCwd: '/server/cwd', sttUrl: '', projectSummariesHydrated: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('appears when a task is selected and keeps the instance viewer entry', async () => {
    useKookrStore.setState({
      agents: [makeAgent()],
      selectedAgentId: 'agent-1',
      selectedTaskId: 'task-1',
    });

    await act(async () => { root.render(React.createElement(App)); });
    await openPalette(container);

    expect(container.querySelector('[data-action-id="share-task"]')).not.toBeNull();
    // The pre-existing instance-wide viewer entry is unchanged.
    expect(container.querySelector('[data-action-id="share-viewer"]')).not.toBeNull();
  });

  test('is absent when no task is selected', async () => {
    useKookrStore.setState({
      agents: [makeAgent()],
      selectedAgentId: null,
      selectedTaskId: null,
    });

    await act(async () => { root.render(React.createElement(App)); });
    await openPalette(container);

    expect(container.querySelector('[data-action-id="share-task"]')).toBeNull();
    expect(container.querySelector('[data-action-id="share-viewer"]')).not.toBeNull();
  });

  test('running the action bumps the nonce prop passed to DetailPanel', async () => {
    useKookrStore.setState({
      agents: [makeAgent()],
      selectedAgentId: 'agent-1',
      selectedTaskId: 'task-1',
    });

    await act(async () => { root.render(React.createElement(App)); });
    await openPalette(container);

    const before = detailPanelProps.current?.shareRequestNonce ?? 0;
    const row = container.querySelector<HTMLButtonElement>('[data-action-id="share-task"]');
    expect(row).not.toBeNull();
    await act(async () => { row!.click(); });
    await flush();

    // The run handler flowed through App state into DetailPanel's nonce prop —
    // the seam the DetailPanel-level test can't reach.
    expect(detailPanelProps.current?.shareRequestNonce).toBe(before + 1);
    // The palette closed after running the action.
    expect(container.querySelector('[data-testid="command-palette-input"]')).toBeNull();
  });
});
