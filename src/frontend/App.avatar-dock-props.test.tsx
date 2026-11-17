// @vitest-environment happy-dom

// App hands Lucy's panel the Talk shortcut and tells it when global shortcuts are blocked (#4010, #4058).
// AvatarDock's own tests pass these props by hand, so without this file deleting either prop in App stays green.

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import type { AvatarDockProps } from './avatar/AvatarDock.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';
import { AVATAR_PANEL_KEY, __resetAvatarPanelPrefsForTests } from './store/avatar-panel-prefs.js';
import { __resetViewerSessionForTests } from './viewer-session.js';
import { detectShortcutPlatform, getDefaultShortcutBindings } from '../shared/contracts/shortcut-bindings.js';

const dock = vi.hoisted(() => ({ props: null as Partial<AvatarDockProps> | null }));

vi.mock('./avatar/AvatarDock.js', () => ({
  AvatarDock: (props: Partial<AvatarDockProps>) => {
    dock.props = props;
    return null;
  },
}));

vi.mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({ send: () => true }),
}));
vi.mock('./hooks/useNotifications.js', () => ({ useNotifications: () => {} }));
vi.mock('./hooks/useTabAttentionBadge.js', () => ({ useTabAttentionBadge: () => {} }));
vi.mock('./hooks/useAudibleAlert.js', () => ({ useAudibleAlert: () => {} }));
vi.mock('./hooks/useTaskCompletionChime.js', () => ({ useTaskCompletionChime: () => {} }));
vi.mock('./telemetry.js', () => ({ track: vi.fn() }));

// The real top bar and palette are not under test; these stand-ins expose the two ways shortcuts get blocked.
vi.mock('./components/TopBar.js', () => ({
  TopBar: (props: { onOperations: () => void; onCommandPalette: () => void }) => React.createElement(
    'div',
    { 'data-testid': 'top-bar' },
    React.createElement('button', { 'data-testid': 'mock-operations', onClick: props.onOperations }, 'Diagnostics'),
    React.createElement('button', { 'data-testid': 'mock-palette', onClick: props.onCommandPalette }, 'Palette'),
  ),
}));
vi.mock('./components/CommandPalette.js', () => ({
  CommandPalette: (props: { actions: Array<{ id: string; run: () => void }> }) => React.createElement(
    'div',
    { 'data-testid': 'command-palette' },
    props.actions.map((action) => React.createElement('button', { key: action.id, 'data-command': action.id, onClick: action.run }, action.id)),
  ),
}));
vi.mock('./components/DetailPanel.js', () => ({
  DetailPanel: () => React.createElement('div', { 'data-testid': 'detail-panel' }),
}));
vi.mock('./components/FindingsPanel.js', () => ({
  FindingsPanel: () => React.createElement('div', { 'data-testid': 'findings-panel' }),
}));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  useKookrStore.setState(Object.fromEntries(Object.entries(freshState).filter(([, value]) => typeof value !== 'function')));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('App passes the Talk shortcut and the shortcut block to Lucy’s panel (#4058)', () => {
  let container: HTMLDivElement;
  let root: Root;

  const click = async (selector: string) => {
    const button = container.querySelector<HTMLButtonElement>(selector);
    expect(button, selector).not.toBeNull();
    await act(async () => { button!.click(); });
    await flush();
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('kookr:onboarding:seen-v2', 'true');
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: false, position: null }));
    __resetAvatarPanelPrefsForTests();
    __resetViewerSessionForTests();
    dock.props = null;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    } as Response)));
    syncGlobalStore();
    useKookrStore.setState({ agents: [], agentsHydrated: true, projectSummariesHydrated: true, sttUrl: '' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetAvatarPanelPrefsForTests();
    __resetViewerSessionForTests();
  });

  const renderApp = async () => {
    await act(async () => { root.render(React.createElement(App)); });
    await flush();
  };
  const select = async (agentId: string | null) => {
    await act(async () => { useKookrStore.setState({ selectedAgentId: agentId }); });
  };
  const selected = () => useKookrStore.getState().selectedAgentId;

  test('passes the platform’s Talk binding, and blocks it while Diagnostics or the bug report is open', async () => {
    await act(async () => { root.render(React.createElement(App)); });
    await flush();

    expect(dock.props).not.toBeNull();
    expect(dock.props!.talkShortcut).toEqual(getDefaultShortcutBindings(detectShortcutPlatform()).lucy_talk_toggle);
    expect(dock.props!.shortcutsBlocked).toBe(false);

    // Diagnostics (the operations view) swallows global shortcuts.
    await click('[data-testid="mock-operations"]');
    expect(dock.props!.shortcutsBlocked).toBe(true);
    await click('[data-testid="mock-operations"]');
    expect(dock.props!.shortcutsBlocked).toBe(false);

    // So does the bug-report dialog, opened here from the command palette.
    await click('[data-testid="mock-palette"]');
    await click('[data-command="bug-report"]');
    expect(dock.props!.shortcutsBlocked).toBe(true);
  });

  test('"Open task" selects the task and leaves it selected, also when a project drawer was open; a task with no live agent is refused', async () => {
    await act(async () => {
      useKookrStore.setState({ agents: [{ agentId: 'ag1', taskId: 't1', projectId: 'billing' } as never] });
    });
    await renderApp();
    const openTask = dock.props!.onOpenTask!;

    let opened = false;
    await act(async () => { opened = openTask('t1'); });
    expect(opened).toBe(true);
    expect(selected()).toBe('ag1');
    expect(useKookrStore.getState().selectedTaskId).toBe('t1');

    // With a project drawer open: the drawer closes and the task stays selected.
    await select(null);
    await act(async () => { useKookrStore.setState({ selectedProject: 'billing' }); });
    await act(async () => { opened = dock.props!.onOpenTask!('t1'); });
    expect(opened).toBe(true);
    expect(selected()).toBe('ag1');
    expect(useKookrStore.getState().selectedProject).toBeNull();

    await select(null);
    await act(async () => { opened = dock.props!.onOpenTask!('gone'); });
    expect(opened).toBe(false);
    expect(selected()).toBeNull();
  });
});
