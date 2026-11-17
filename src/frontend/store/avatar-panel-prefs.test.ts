import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tracked = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../telemetry.js', () => ({ track: (event: Record<string, unknown>) => { tracked.push(event); } }));
import {
  AVATAR_COLUMN_DEFAULT_WIDTH,
  AVATAR_COLUMN_MAX_WIDTH,
  AVATAR_COLUMN_MIN_WIDTH,
  AVATAR_PAGE_MIN_WIDTH,
  AVATAR_PANEL_KEY,
  DEFAULT_AVATAR_PANEL_PREFS,
  __resetAvatarPanelPrefsForTests,
  avatarColumnLayout,
  clampAvatarColumnWidth,
  loadAvatarPanelPrefs,
  saveAvatarPanelPrefs,
  updateAvatarPanelPrefs,
} from './avatar-panel-prefs.js';

function fakeStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    map,
    impl: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
    } as Pick<Storage, 'getItem' | 'setItem'>,
  };
}

describe('avatar-panel-prefs', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage().impl);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('the panel is off unless the operator turned it on', () => {
    expect(DEFAULT_AVATAR_PANEL_PREFS.enabled).toBe(false);
    expect(loadAvatarPanelPrefs(fakeStorage().impl)).toEqual(DEFAULT_AVATAR_PANEL_PREFS);
    expect(loadAvatarPanelPrefs(null)).toEqual(DEFAULT_AVATAR_PANEL_PREFS);
  });

  test('a saved choice round-trips', () => {
    const storage = fakeStorage();
    const prefs = { enabled: true, minimized: true, width: 450 };
    expect(saveAvatarPanelPrefs(prefs, storage.impl)).toBeNull();
    expect(loadAvatarPanelPrefs(storage.impl)).toEqual(prefs);
  });

  test.each([
    ['not JSON', '{oops'],
    ['a JSON string', '"on"'],
    ['null', 'null'],
    ['an array', '[true]'],
  ])('malformed storage (%s) falls back to the panel being off', (_label, raw) => {
    const storage = fakeStorage({ [AVATAR_PANEL_KEY]: raw });
    expect(loadAvatarPanelPrefs(storage.impl)).toEqual(DEFAULT_AVATAR_PANEL_PREFS);
  });

  test('only a literal true enables the panel; a bad width is dropped, not trusted', () => {
    const storage = fakeStorage({
      [AVATAR_PANEL_KEY]: JSON.stringify({ enabled: 'yes', minimized: 1, width: 'wide' }),
    });
    expect(loadAvatarPanelPrefs(storage.impl)).toEqual({ enabled: false, minimized: false });
  });

  test('prefs saved by the floating window, with a position, still load: the position is ignored and the panel opens', () => {
    const storage = fakeStorage({
      [AVATAR_PANEL_KEY]: '{"enabled":true,"minimized":false,"position":{"x":1945,"y":804}}',
    });
    const prefs = loadAvatarPanelPrefs(storage.impl);
    expect(prefs).toEqual({ enabled: true, minimized: false });
    expect(prefs).not.toHaveProperty('position');
  });

  test('a saved width is kept inside the limits', () => {
    const load = (width: unknown) => loadAvatarPanelPrefs(fakeStorage({ [AVATAR_PANEL_KEY]: JSON.stringify({ enabled: true, width }) }).impl);
    expect(load(450).width).toBe(450);
    expect(load(100).width).toBe(AVATAR_COLUMN_MIN_WIDTH);
    expect(load(5000).width).toBe(AVATAR_COLUMN_MAX_WIDTH);
    expect(load(412.6).width).toBe(413);
    expect(load(null)).not.toHaveProperty('width');
  });

  test('storage that throws is reported on save and ignored on load', () => {
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota'); },
    };
    expect(loadAvatarPanelPrefs(throwing)).toEqual(DEFAULT_AVATAR_PANEL_PREFS);
    expect(saveAvatarPanelPrefs(DEFAULT_AVATAR_PANEL_PREFS, throwing)?.message).toBe('quota');
    expect(saveAvatarPanelPrefs(DEFAULT_AVATAR_PANEL_PREFS, null)).toBeInstanceOf(Error);
  });

  describe('the live store behind the settings toggle and the panel', () => {
    test('an update keeps the fields it was not given and is written to storage', () => {
      const storage = fakeStorage();
      vi.stubGlobal('localStorage', storage.impl);
      __resetAvatarPanelPrefsForTests();

      updateAvatarPanelPrefs({ enabled: true });
      const next = updateAvatarPanelPrefs({ minimized: true, width: 500 });

      expect(next).toEqual({ enabled: true, minimized: true, width: 500 });
      expect(JSON.parse(storage.map.get(AVATAR_PANEL_KEY) ?? 'null')).toEqual(next);
    });

    test('a store that starts from saved prefs keeps them when one field changes', () => {
      const storage = fakeStorage({
        [AVATAR_PANEL_KEY]: JSON.stringify({ enabled: true, minimized: false, width: 400 }),
      });
      vi.stubGlobal('localStorage', storage.impl);
      __resetAvatarPanelPrefsForTests();

      expect(updateAvatarPanelPrefs({ minimized: true })).toEqual({
        enabled: true,
        minimized: true,
        width: 400,
      });
    });

    test('storage that refuses the write does not lose the change for this page', () => {
      vi.stubGlobal('localStorage', {
        getItem: () => null,
        setItem: () => { throw new Error('quota'); },
      });
      __resetAvatarPanelPrefsForTests();

      expect(updateAvatarPanelPrefs({ enabled: true }).enabled).toBe(true);
    });
  });

  describe('clampAvatarColumnWidth', () => {
    test('keeps a width inside the limits unchanged and pulls others back', () => {
      expect(clampAvatarColumnWidth(380)).toBe(380);
      expect(clampAvatarColumnWidth(AVATAR_COLUMN_MIN_WIDTH - 1)).toBe(AVATAR_COLUMN_MIN_WIDTH);
      expect(clampAvatarColumnWidth(AVATAR_COLUMN_MAX_WIDTH + 1)).toBe(AVATAR_COLUMN_MAX_WIDTH);
    });

    test('anything that is not a finite number is the default width', () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '400', null, undefined]) {
        expect(clampAvatarColumnWidth(bad)).toBe(AVATAR_COLUMN_DEFAULT_WIDTH);
      }
    });

    test('the default is inside the limits', () => {
      expect(AVATAR_COLUMN_DEFAULT_WIDTH).toBe(380);
      expect(AVATAR_COLUMN_MIN_WIDTH).toBe(320);
      expect(AVATAR_COLUMN_MAX_WIDTH).toBe(560);
    });
  });

  describe('avatarColumnLayout: the page keeps at least 1000 px', () => {
    test('the page minimum is 1000 px', () => {
      expect(AVATAR_PAGE_MIN_WIDTH).toBe(1000);
    });

    test('768 px and below is a sheet over the whole window', () => {
      expect(avatarColumnLayout(768, 450)).toEqual({ mode: 'sheet', width: 768, maxWidth: 768 });
      expect(avatarColumnLayout(375, undefined)).toEqual({ mode: 'sheet', width: 375, maxWidth: 375 });
    });

    test('769 to 1319 px floats over the page at the saved width, clamped 320..560 and never wider than the window', () => {
      expect(avatarColumnLayout(769, undefined)).toEqual({ mode: 'overlay', width: 380, maxWidth: 560 });
      expect(avatarColumnLayout(1280, undefined)).toEqual({ mode: 'overlay', width: 380, maxWidth: 560 });
      expect(avatarColumnLayout(1319, 450)).toEqual({ mode: 'overlay', width: 450, maxWidth: 560 });
      expect(avatarColumnLayout(1319, 9999)).toEqual({ mode: 'overlay', width: 560, maxWidth: 560 });
      expect(avatarColumnLayout(1280, 100)).toEqual({ mode: 'overlay', width: 320, maxWidth: 560 });
    });

    test('from 1320 px it is docked, and the width is capped so the page keeps 1000 px', () => {
      expect(avatarColumnLayout(1320, undefined)).toEqual({ mode: 'docked', width: 320, maxWidth: 320 });
      expect(avatarColumnLayout(1320, 560)).toEqual({ mode: 'docked', width: 320, maxWidth: 320 });
      expect(avatarColumnLayout(1440, undefined)).toEqual({ mode: 'docked', width: 380, maxWidth: 440 });
      expect(avatarColumnLayout(1440, 560)).toEqual({ mode: 'docked', width: 440, maxWidth: 440 });
      expect(avatarColumnLayout(2221, 560)).toEqual({ mode: 'docked', width: 560, maxWidth: 560 });
      expect(avatarColumnLayout(1920, 450)).toEqual({ mode: 'docked', width: 450, maxWidth: 560 });
    });

    test('whenever it is docked the page is left at least 1000 px', () => {
      for (let viewport = 769; viewport <= 2400; viewport += 7) {
        const layout = avatarColumnLayout(viewport, 560);
        if (layout.mode === 'docked') expect(viewport - layout.width).toBeGreaterThanOrEqual(AVATAR_PAGE_MIN_WIDTH);
      }
    });
  });

  test('switching the panel on or off is recorded once per actual change, and resizing or minimising is not', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    __resetAvatarPanelPrefsForTests();
    tracked.length = 0;

    updateAvatarPanelPrefs({ enabled: true });
    updateAvatarPanelPrefs({ enabled: true, minimized: true });
    updateAvatarPanelPrefs({ width: 450 });
    updateAvatarPanelPrefs({ enabled: false });
    updateAvatarPanelPrefs({ enabled: false });

    expect(tracked).toEqual([
      { type: 'lucy_panel_action', action: 'enable' },
      { type: 'lucy_panel_action', action: 'disable' },
    ]);
  });
});
