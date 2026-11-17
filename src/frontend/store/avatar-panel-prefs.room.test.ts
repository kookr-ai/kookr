// @vitest-environment happy-dom

// "Lucy's room" in the preferences store: a per-tab flag in sessionStorage (never in the shared preferences),
// and the `/?lucy=room` address that opens the dashboard with her in the room.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tracked = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../telemetry.js', () => ({ track: (event: Record<string, unknown>) => { tracked.push(event); } }));

import {
  AVATAR_PANEL_KEY,
  AVATAR_ROOM_KEY,
  __resetAvatarPanelPrefsForTests,
  applyAvatarRoomAddress,
  getAvatarPanelPrefs,
  getAvatarRoom,
  leaveAvatarRoomToShowTask,
  parseAvatarRoomQuery,
  setAvatarRoom,
  stripAvatarRoomQuery,
  updateAvatarPanelPrefs,
} from './avatar-panel-prefs.js';

const savedPrefs = (): unknown => JSON.parse(localStorage.getItem(AVATAR_PANEL_KEY) ?? 'null');
const address = (): string => `${window.location.pathname}${window.location.search}${window.location.hash}`;
const panelActions = (): unknown[] => tracked.filter((event) => event.type === 'lucy_panel_action').map((event) => event.action);

/** Start a tab with these saved preferences (and, optionally, the room flag), as a page load would find them. */
function startWith(prefs: Record<string, unknown> | null, room?: string): void {
  if (prefs !== null) localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify(prefs));
  if (room !== undefined) sessionStorage.setItem(AVATAR_ROOM_KEY, room);
  __resetAvatarPanelPrefsForTests();
  tracked.length = 0;
}

describe('Lucy’s room in the preferences store', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    __resetAvatarPanelPrefsForTests();
    tracked.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    __resetAvatarPanelPrefsForTests();
  });

  describe('the flag belongs to this tab', () => {
    test('she is not in the room unless this tab put her there', () => {
      startWith({ enabled: true, minimized: false });
      expect(getAvatarRoom()).toBe(false);
    });

    test('entering is kept in sessionStorage and not in the shared preferences; a reload of the tab comes back to it', () => {
      startWith({ enabled: true, minimized: false, width: 450 });
      setAvatarRoom(true);
      expect(getAvatarRoom()).toBe(true);
      expect(sessionStorage.getItem(AVATAR_ROOM_KEY)).toBe('1');
      // What the other tabs read is exactly what it was.
      expect(savedPrefs()).toEqual({ enabled: true, minimized: false, width: 450 });

      __resetAvatarPanelPrefsForTests();
      expect(getAvatarRoom()).toBe(true);

      setAvatarRoom(false);
      expect(sessionStorage.getItem(AVATAR_ROOM_KEY)).toBeNull();
      __resetAvatarPanelPrefsForTests();
      expect(getAvatarRoom()).toBe(false);
    });

    test('the module reads the flag when it is first loaded (a reload of the tab)', async () => {
      sessionStorage.setItem(AVATAR_ROOM_KEY, '1');
      vi.resetModules();
      const fresh = await import('./avatar-panel-prefs.js');
      expect(fresh.getAvatarRoom()).toBe(true);
    });

    test('an older or foreign saved value never puts her in the room', () => {
      // Preferences saved before the room existed, and ones that carry fields this version does not know.
      startWith({ enabled: true, minimized: false, position: { x: 10, y: 20 } });
      expect(getAvatarRoom()).toBe(false);
      startWith({ enabled: true, minimized: false, room: true, layout: 'room', mode: 'room' });
      expect(getAvatarRoom()).toBe(false);
      expect(getAvatarPanelPrefs()).toEqual({ enabled: true, minimized: false });
      // Only the exact value this version writes counts.
      for (const junk of ['true', 'room', '0', '', ' 1', '{"room":true}']) {
        startWith({ enabled: true, minimized: false }, junk);
        expect(getAvatarRoom(), JSON.stringify(junk)).toBe(false);
      }
    });

    test('another tab changing the shared preferences does not move this tab in or out of the room', () => {
      startWith({ enabled: true, minimized: false }, '1');
      window.dispatchEvent(new StorageEvent('storage', { key: AVATAR_PANEL_KEY, newValue: JSON.stringify({ enabled: true, minimized: true, width: 500 }) }));
      expect(getAvatarPanelPrefs()).toEqual({ enabled: true, minimized: true, width: 500 });
      expect(getAvatarRoom()).toBe(true);
    });

    test('storage that cannot be read means the column; storage that refuses the write still switches this page', () => {
      vi.stubGlobal('sessionStorage', {
        getItem: () => { throw new Error('blocked'); },
        setItem: () => { throw new Error('blocked'); },
        removeItem: () => { throw new Error('blocked'); },
      });
      __resetAvatarPanelPrefsForTests();
      expect(getAvatarRoom()).toBe(false);
      setAvatarRoom(true);
      expect(getAvatarRoom()).toBe(true);
      setAvatarRoom(false);
      expect(getAvatarRoom()).toBe(false);
    });

    test('entering and leaving are recorded once per actual change', () => {
      startWith({ enabled: true, minimized: false });
      setAvatarRoom(true);
      setAvatarRoom(true);
      setAvatarRoom(false);
      setAvatarRoom(false);
      expect(tracked).toEqual([
        { type: 'lucy_panel_action', action: 'expand' },
        { type: 'lucy_panel_action', action: 'collapse' },
      ]);
    });

    test('switching the panel off takes the room with it, so switching it on again starts as the column', () => {
      startWith({ enabled: true, minimized: false }, '1');
      updateAvatarPanelPrefs({ enabled: false, minimized: false });
      expect(getAvatarRoom()).toBe(false);
      expect(sessionStorage.getItem(AVATAR_ROOM_KEY)).toBeNull();
      updateAvatarPanelPrefs({ enabled: true, minimized: false });
      expect(getAvatarRoom()).toBe(false);
      // Other changes to the preferences leave the room alone.
      setAvatarRoom(true);
      updateAvatarPanelPrefs({ width: 500 });
      updateAvatarPanelPrefs({ minimized: true });
      expect(getAvatarRoom()).toBe(true);
    });
  });

  describe('leaving the room to show a task', () => {
    test('outside the room it does nothing', () => {
      startWith({ enabled: true, minimized: true });
      leaveAvatarRoomToShowTask();
      expect(getAvatarPanelPrefs().minimized).toBe(true);
      expect(tracked).toEqual([]);
    });

    test('in the room it leaves, and she is the column beside the task even if she was a bubble before', () => {
      startWith({ enabled: true, minimized: true }, '1');
      leaveAvatarRoomToShowTask();
      expect(getAvatarRoom()).toBe(false);
      expect(savedPrefs()).toEqual({ enabled: true, minimized: false });
      expect(panelActions()).toEqual(['collapse']);
    });
  });

  describe('/?lucy=room', () => {
    test('reading the address', () => {
      expect(parseAvatarRoomQuery('?lucy=room')).toBe(true);
      expect(parseAvatarRoomQuery('lucy=room')).toBe(true);
      expect(parseAvatarRoomQuery('?task=abc&lucy=room')).toBe(true);
      expect(parseAvatarRoomQuery('?lucy=ROOM')).toBe(true);
      expect(parseAvatarRoomQuery('?lucy=%20room%20')).toBe(true);
      expect(parseAvatarRoomQuery('')).toBe(false);
      expect(parseAvatarRoomQuery('?lucy')).toBe(false);
      expect(parseAvatarRoomQuery('?lucy=column')).toBe(false);
      expect(parseAvatarRoomQuery('?lucyx=room')).toBe(false);
      expect(parseAvatarRoomQuery('?task=lucy=room')).toBe(false);
    });

    test('removing it leaves the other parameters and the hash as they are', () => {
      expect(stripAvatarRoomQuery('/?lucy=room')).toBe('/');
      expect(stripAvatarRoomQuery('/?task=abc&lucy=room#notes')).toBe('/?task=abc#notes');
      expect(stripAvatarRoomQuery('/dash/?lucy=room&debug=1')).toBe('/dash/?debug=1');
      // Not ours to remove.
      expect(stripAvatarRoomQuery('/?lucy=column&task=abc')).toBe('/?lucy=column&task=abc');
      expect(stripAvatarRoomQuery('/?task=abc')).toBe('/?task=abc');
    });

    test('it puts this tab in the room, is removed from the address, and a reload stays in the room', () => {
      startWith({ enabled: true, minimized: false });
      window.history.replaceState({ kept: true }, '', '/?task=abc&lucy=room#notes');

      expect(applyAvatarRoomAddress()).toBe(true);
      expect(getAvatarRoom()).toBe(true);
      expect(address()).toBe('/?task=abc#notes');
      expect(window.history.state).toEqual({ kept: true });
      expect(sessionStorage.getItem(AVATAR_ROOM_KEY)).toBe('1');
      expect(panelActions()).toEqual(['expand']);

      // Read once: the address no longer asks, and a reload keeps the room through sessionStorage.
      expect(applyAvatarRoomAddress()).toBe(false);
      __resetAvatarPanelPrefsForTests();
      expect(getAvatarRoom()).toBe(true);
    });

    test('a panel that is switched off is switched on, as Settings would, and opened', () => {
      startWith({ enabled: false, minimized: true });
      window.history.replaceState(null, '', '/?lucy=room');
      expect(applyAvatarRoomAddress()).toBe(true);
      expect(savedPrefs()).toEqual({ enabled: true, minimized: false });
      expect(getAvatarRoom()).toBe(true);
      expect(panelActions()).toEqual(['enable', 'expand']);
    });

    test('with nothing saved at all (a new browser) it also switches her on', () => {
      startWith(null);
      window.history.replaceState(null, '', '/?lucy=room');
      expect(applyAvatarRoomAddress()).toBe(true);
      expect(savedPrefs()).toEqual({ enabled: true, minimized: false });
      expect(getAvatarRoom()).toBe(true);
    });

    test('a panel that is on keeps its saved preferences, minimised included: other tabs are not changed', () => {
      startWith({ enabled: true, minimized: true, width: 500 });
      const before = localStorage.getItem(AVATAR_PANEL_KEY);
      window.history.replaceState(null, '', '/?lucy=room');
      expect(applyAvatarRoomAddress()).toBe(true);
      expect(getAvatarRoom()).toBe(true);
      expect(localStorage.getItem(AVATAR_PANEL_KEY)).toBe(before);
    });

    test('without the parameter, or with another value, nothing changes: not the room, not a panel that is off, not the address', () => {
      for (const url of ['/', '/?task=abc', '/?lucy=column', '/?lucy=']) {
        startWith({ enabled: false, minimized: false });
        window.history.replaceState(null, '', url);
        expect(applyAvatarRoomAddress(), url).toBe(false);
        expect(getAvatarRoom(), url).toBe(false);
        expect(getAvatarPanelPrefs().enabled, url).toBe(false);
        expect(address(), url).toBe(url);
        expect(tracked, url).toEqual([]);
      }
    });
  });
});
