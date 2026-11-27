// @vitest-environment happy-dom

// App hands Lucy's panel the Talk shortcut and tells it when global shortcuts are blocked (#4010, #4058).
// AvatarDock's own tests pass these props by hand, so without this file deleting either prop in App stays green.
// It also covers what only App can do for "Lucy's room": read `/?lucy=room` before the first paint, pass the
// room's shortcut, keep the dashboard's own shortcuts quiet while she covers it (room or sheet), and make the dashboard
// inert under her while leaving the dialogs, the palette and the toasts live (#4154), also a dialog that a
// dashboard component has open (#4166).

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import type { AvatarDockProps } from './avatar/AvatarDock.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';
import { AVATAR_PANEL_KEY, AVATAR_ROOM_KEY, __resetAvatarPanelPrefsForTests, getAvatarRoom, setAvatarPageCovered, setAvatarRoom } from './store/avatar-panel-prefs.js';
import { __resetOperatorAsksForTests, handleOperatorAsks } from './store/operator-asks.js';
import { __resetLucyPermissionForTests, handleLucyPermissionCards } from './store/lucy-permission.js';
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
        prefs.setAvatarPageCovered(true);
        return () => prefs.setAvatarPageCovered(false);
      }, [room]);
      return react.createElement('section', { 'data-testid': 'mock-dock' });
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
// The real Diagnostics panel loads stats that the stubbed fetch cannot give; only where it renders matters here.
vi.mock('./components/OperationsPanel.js', () => ({
  OperationsPanel: () => React.createElement('div', { className: 'dialog-overlay', 'data-testid': 'operations-panel' }),
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

  test('hands the dock the number of things waiting on the operator: questions and permission prompts', async () => {
    __resetOperatorAsksForTests();
    __resetLucyPermissionForTests();
    await renderApp();
    expect(dock.props!.needsYouCount).toBe(0);
    await act(async () => {
      handleOperatorAsks([{
        id: 'a1b2c3d4e5f6', taskId: 't1', taskName: 'Fix login', question: 'Ship?', options: ['Yes'], allowText: false,
        state: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 600_000,
      }]);
      handleLucyPermissionCards({
        type: 'lucyPermissionCards',
        cards: [{ promptId: 'p1', taskId: 't2', agentId: 'ag2', toolName: 'Bash', command: 'ls', since: Date.now() }],
      });
    });
    expect(dock.props!.needsYouCount).toBe(2);
    expect(dock.props!.permissionCount).toBe(1);
    __resetOperatorAsksForTests();
    __resetLucyPermissionForTests();
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

  test('while Lucy covers the dashboard it is inert, and the dialogs, the palette, the toasts and her dock stay live (#4154)', async () => {
    await renderApp();
    // Diagnostics and the command palette open, as an operator may have them when she takes the window.
    await click('[data-testid="mock-operations"]');
    await click('[data-testid="mock-palette"]');
    const inertAncestor = (selector: string): Element | null => {
      const element = document.querySelector(selector);
      expect(element, selector).not.toBeNull();
      return element!.closest('[inert]');
    };
    const dashboardParts = ['[data-testid="skip-to-content"]', '[data-testid="top-bar"]', '#main-content', '[data-testid="findings-panel"]'];
    const liveParts = ['[data-testid="operations-panel"]', '[data-testid="command-palette"]', '[data-testid="toast-live-polite"]', '[data-testid="toast-live-assertive"]', '[data-testid="mock-dock"]'];

    // Not covered: nothing is inert.
    for (const selector of [...dashboardParts, ...liveParts]) expect(inertAncestor(selector), selector).toBeNull();

    await act(async () => { setAvatarRoom(true); });
    await flush();
    for (const selector of dashboardParts) expect(inertAncestor(selector), selector).not.toBeNull();
    for (const selector of liveParts) expect(inertAncestor(selector), selector).toBeNull();
    // The wrapper takes no part in the layout: `.app` lays out the dashboard's parts as before.
    const wrapper = container.querySelector<HTMLElement>('[data-testid="app-dashboard"]')!;
    expect(wrapper.style.display).toBe('contents');

    await act(async () => { setAvatarRoom(false); });
    await flush();
    for (const selector of dashboardParts) expect(inertAncestor(selector), selector).toBeNull();
  });

  test('a room flag whose dock is not on screen leaves the dashboard live', async () => {
    sessionStorage.setItem(AVATAR_ROOM_KEY, '1');
    __resetAvatarPanelPrefsForTests();
    dock.throws = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await renderApp();
      expect(container.querySelector('[data-testid="top-bar"]')!.closest('[inert]')).toBeNull();
    } finally {
      dock.throws = false;
    }
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

  describe('dialogs and focus while she covers the page (#4166)', () => {
    /** The full-width sheet of a narrow window, as the real dock reports it: it covers the page, with no room. */
    const coverAsSheet = async (on: boolean) => {
      await act(async () => { setAvatarPageCovered(on); });
      await flush();
    };
    /** A dialog that a component inside the dashboard renders (Share task), with a button in it. */
    const openShareDialog = async (marker: 'class' | 'aria-modal' = 'class') => {
      const overlay = document.createElement('div');
      if (marker === 'class') overlay.className = 'dialog-overlay';
      else overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('data-testid', 'share-dialog');
      overlay.appendChild(document.createElement('button'));
      await act(async () => { container.querySelector('[data-testid="findings-panel"]')!.appendChild(overlay); });
      await flush();
      return overlay;
    };
    const closeShareDialog = async (overlay: HTMLElement) => {
      await act(async () => { overlay.remove(); });
      await flush();
    };
    const topBarInert = () => container.querySelector('[data-testid="top-bar"]')!.closest('[inert]') !== null;

    test('the full-width sheet holds the dashboard’s shortcuts back, as the room does', async () => {
      await renderApp();
      await select('ag1');
      await coverAsSheet(true);
      const escape = await press({ key: 'Escape' });
      expect(selected()).toBe('ag1');
      expect(escape.defaultPrevented).toBe(false);
      expect(dock.props!.shortcutsBlocked).toBe(false);

      await coverAsSheet(false);
      await press({ key: 'Escape' });
      expect(selected()).toBeNull();
    });

    test('a dialog of a dashboard component keeps the dashboard live while she covers it, and it goes inert once the dialog closes', async () => {
      await renderApp();
      for (const marker of ['class', 'aria-modal'] as const) {
        const share = await openShareDialog(marker);
        // The sheet comes up under the open dialog (a resize): its buttons must keep working.
        await coverAsSheet(true);
        expect(share.closest('[inert]'), marker).toBeNull();
        expect(topBarInert(), marker).toBe(false);
        expect(dock.props!.dialogOpen, marker).toBe(true);

        await closeShareDialog(share);
        expect(topBarInert(), marker).toBe(true);
        expect(dock.props!.dialogOpen, marker).toBe(false);
        await coverAsSheet(false);
        expect(topBarInert(), marker).toBe(false);
      }
    });

    test('the dock can ask whether a dashboard component has a dialog open; App’s own dialogs are not one', async () => {
      await renderApp();
      const ask = dock.props!.dashboardDialogOpen!;
      expect(ask()).toBe(false);
      // Diagnostics is App's own dialog, outside the dashboard: the room may still be entered over it.
      await click('[data-testid="mock-operations"]');
      expect(container.querySelector('[data-testid="operations-panel"]')).not.toBeNull();
      expect(ask()).toBe(false);
      await click('[data-testid="mock-operations"]');
      const share = await openShareDialog();
      expect(ask()).toBe(true);
      await closeShareDialog(share);
      expect(ask()).toBe(false);
    });

    test('tells the dock while a dialog is open over the page, so it can take focus back when the last one closes', async () => {
      await renderApp();
      expect(dock.props!.dialogOpen).toBe(false);
      await click('[data-testid="mock-operations"]');
      expect(dock.props!.dialogOpen).toBe(true);
      // The palette opened over Diagnostics: still a dialog open.
      await click('[data-testid="mock-palette"]');
      await click('[data-testid="mock-operations"]');
      expect(container.querySelector('[data-testid="operations-panel"]')).toBeNull();
      expect(dock.props!.dialogOpen).toBe(true);
      await press({ key: 'k', ctrlKey: true });
      expect(container.querySelector('[data-testid="command-palette"]')).toBeNull();
      expect(dock.props!.dialogOpen).toBe(false);
      // A modal of App's (the bug report).
      await click('[data-testid="mock-palette"]');
      await click('[data-command="bug-report"]');
      await press({ key: 'k', ctrlKey: true });
      expect(dock.props!.dialogOpen).toBe(true);
    });
  });
});
