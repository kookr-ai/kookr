// @vitest-environment happy-dom

// App hands Lucy's panel the Talk shortcut and tells it when global shortcuts are blocked (#4010, #4058).
// AvatarDock's own tests pass these props by hand, so without this file deleting either prop in App stays green.
// It also covers what only App can do for "Lucy's room": read `/?lucy=room` before the first paint, pass the
// room's shortcut, and keep the dashboard's own shortcuts quiet while the room covers it.

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import type { AvatarDockProps } from './avatar/AvatarDock.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';
import { AVATAR_PANEL_KEY, AVATAR_ROOM_KEY, __resetAvatarPanelPrefsForTests, getAvatarRoom, setAvatarRoom } from './store/avatar-panel-prefs.js';
import { __resetViewerSessionForTests } from './viewer-session.js';
import { detectShortcutPlatform, getDefaultShortcutBindings } from '../shared/contracts/shortcut-bindings.js';

const dock = vi.hoisted(() => ({ props: null as Partial<AvatarDockProps> | null, throws: false }));

// Stands in for the real dock: like it, it tells the store when the room is on screen, and only then. (It keys
// that on the saved flag; the real dock's own report is pinned in AvatarDock.room.test.tsx, next to a probe.)
vi.mock('./avatar/AvatarDock.js', async () => {
  const react = await import('react');
  const prefs = await import('./store/avatar-panel-prefs.js');
  return {
    AvatarDock: (props: Partial<AvatarDockProps>) => {
      if (dock.throws) throw new Error('the dock broke');
      dock.props = props;
      const room = prefs.useAvatarRoom();
      react.useLayoutEffect(() => {
        if (!room) return undefined;
        prefs.setAvatarRoomShown(true);
        return () => prefs.setAvatarRoomShown(false);
      }, [room]);
      return null;
    },
  };
});

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
    window.history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetAvatarPanelPrefsForTests();
    __resetViewerSessionForTests();
  });

  const renderApp = async () => {
    await act(async () => { root.render(React.createElement(App)); });
    await flush();
  };
  const press = async (init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    // From the page, as a real key press is: the handler looks at the element it came from.
    await act(async () => { document.body.dispatchEvent(event); });
    await flush();
    return event;
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

  test('passes the platform’s binding for Lucy’s room', async () => {
    await renderApp();
    expect(dock.props!.roomShortcut).toEqual(getDefaultShortcutBindings(detectShortcutPlatform()).lucy_room_toggle);
  });

  test('while Lucy’s room covers the dashboard its own shortcuts do nothing, and hers are not blocked', async () => {
    await renderApp();
    await select('ag1');

    // Outside the room Escape deselects the task, as always.
    await press({ key: 'Escape' });
    expect(selected()).toBeNull();

    await select('ag1');
    await act(async () => { setAvatarRoom(true); });
    await flush();
    const escape = await press({ key: 'Escape' });
    expect(selected()).toBe('ag1');
    expect(escape.defaultPrevented).toBe(false);
    // The Talk and room shortcuts live in the dock and keep working: the room is not a dialog.
    expect(dock.props!.shortcutsBlocked).toBe(false);

    // Back in the dashboard the shortcut works again.
    await act(async () => { setAvatarRoom(false); });
    await flush();
    await press({ key: 'Escape' });
    expect(selected()).toBeNull();
  });

  test('when the dock is not on screen (it threw) a room flag left in the tab does not take the dashboard’s shortcuts away', async () => {
    sessionStorage.setItem(AVATAR_ROOM_KEY, '1');
    __resetAvatarPanelPrefsForTests();
    dock.throws = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await renderApp();
      expect(container.querySelector('[data-testid="top-bar"]')).not.toBeNull();
      expect(dock.props).toBeNull();
      await select('ag1');
      await press({ key: 'Escape' });
      expect(selected()).toBeNull();
    } finally {
      dock.throws = false;
    }
  });

  test('a room flag left over in a tab whose panel is switched off changes nothing', async () => {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: false, minimized: false }));
    sessionStorage.setItem(AVATAR_ROOM_KEY, '1');
    __resetAvatarPanelPrefsForTests();
    await renderApp();
    expect(dock.props).toBeNull();
    await select('ag1');
    await press({ key: 'Escape' });
    expect(selected()).toBeNull();
  });

  test('/?lucy=room opens the dashboard with her in the room, switches her panel on if it was off, and leaves the address clean', async () => {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: false, minimized: true }));
    __resetAvatarPanelPrefsForTests();
    window.history.replaceState(null, '', '/?lucy=room');

    await renderApp();
    expect(dock.props).not.toBeNull();
    expect(getAvatarRoom()).toBe(true);
    expect(window.location.search).toBe('');
    expect(JSON.parse(localStorage.getItem(AVATAR_PANEL_KEY)!)).toEqual({ enabled: true, minimized: false });
  });

  test('without the parameter a panel that is off stays off', async () => {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: false, minimized: false }));
    __resetAvatarPanelPrefsForTests();
    await renderApp();
    expect(dock.props).toBeNull();
    expect(getAvatarRoom()).toBe(false);
  });
});
