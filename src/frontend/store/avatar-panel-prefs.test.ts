import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tracked = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../telemetry.js', () => ({ track: (event: Record<string, unknown>) => { tracked.push(event); } }));
import {
  AVATAR_COLUMN_DEFAULT_WIDTH,
  AVATAR_COLUMN_MAX_VIEWPORT_SHARE,
  AVATAR_COLUMN_MAX_WIDTH,
  AVATAR_COLUMN_OVERLAY_MAX_WIDTH,
  AVATAR_COLUMN_MIN_WIDTH,
  AVATAR_PAGE_MIN_WIDTH,
  AVATAR_PANEL_KEY,
  AVATAR_READING_WIDTH,
  AVATAR_DESK_THREE_COLUMN_MIN_VIEWPORT_PX,
  AVATAR_ROOM_RAIL_MIN_VIEWPORT_PX,
  DEFAULT_AVATAR_PANEL_PREFS,
  __resetAvatarPanelPrefsForTests,
  avatarColumnLayout,
  avatarDeskColumns,
  avatarRoomRailWidth,
  avatarThreadIsCentred,
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
    // A wide column is a real choice now (half of a 2560 px window is 1280 px), so it is read back as saved.
    expect(load(900).width).toBe(900);
    expect(load(1280).width).toBe(1280);
    expect(load(50_000).width).toBe(AVATAR_COLUMN_MAX_WIDTH);
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
      expect(AVATAR_COLUMN_OVERLAY_MAX_WIDTH).toBe(560);
      // Only a ceiling on what is saved; what a window allows is decided by avatarColumnLayout.
      expect(AVATAR_COLUMN_MAX_WIDTH).toBe(2560);
      expect(AVATAR_COLUMN_MAX_VIEWPORT_SHARE).toBe(0.5);
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
      expect(avatarColumnLayout(1560, 9999)).toEqual({ mode: 'docked', width: 560, maxWidth: 560 });
      expect(avatarColumnLayout(2221, 560)).toEqual({ mode: 'docked', width: 560, maxWidth: 1110 });
      expect(avatarColumnLayout(1920, 450)).toEqual({ mode: 'docked', width: 450, maxWidth: 920 });
    });

    test('a wide window lets the column take up to half of it, never more', () => {
      // Below 2000 px the page's 1000 px is the limit; from there on, half the window is.
      expect(avatarColumnLayout(1920, 9999)).toEqual({ mode: 'docked', width: 920, maxWidth: 920 });
      expect(avatarColumnLayout(2000, 9999)).toEqual({ mode: 'docked', width: 1000, maxWidth: 1000 });
      expect(avatarColumnLayout(2560, 9999)).toEqual({ mode: 'docked', width: 1280, maxWidth: 1280 });
      expect(avatarColumnLayout(2561, 9999)).toEqual({ mode: 'docked', width: 1280, maxWidth: 1280 });
      // A saved width inside the limit is used as it is, and the default stays the default.
      expect(avatarColumnLayout(2560, 900)).toEqual({ mode: 'docked', width: 900, maxWidth: 1280 });
      expect(avatarColumnLayout(2560, undefined)).toEqual({ mode: 'docked', width: 380, maxWidth: 1280 });
      // However wide the window, nothing wider than the saved ceiling.
      expect(avatarColumnLayout(8000, 9999).maxWidth).toBe(AVATAR_COLUMN_MAX_WIDTH);
    });

    test('in her room (the desk) she has the whole window at every width: three columns from 1500 px, two from 1100 px, else one', () => {
      expect(AVATAR_ROOM_RAIL_MIN_VIEWPORT_PX).toBe(1100);
      expect(AVATAR_DESK_THREE_COLUMN_MIN_VIEWPORT_PX).toBe(1500);
      const room = (width: number, columns: 1 | 2 | 3, sideWidth: number) => ({
        mode: 'room', width, maxWidth: width, rail: columns > 1, railWidth: sideWidth * (columns - 1), columns, sideWidth,
      });
      // A side column is 26% of the window, 400 to 520 px.
      expect(avatarColumnLayout(2560, undefined, true)).toEqual(room(2560, 3, 520));
      expect(avatarColumnLayout(1920, 450, true)).toEqual(room(1920, 3, 499));
      expect(avatarColumnLayout(1500, undefined, true)).toEqual(room(1500, 3, 400));
      // One short of three columns: Decisions with Fleet stacked under it, the conversation beside them.
      expect(avatarColumnLayout(1499, 9999, true)).toEqual(room(1499, 2, 400));
      expect(avatarColumnLayout(1100, undefined, true)).toEqual(room(1100, 2, 400));
      // Narrower than that it is one column, also where the column would float (769 to 1319) or be a sheet (768 and below).
      expect(avatarColumnLayout(1099, undefined, true)).toEqual(room(1099, 1, 0));
      expect(avatarColumnLayout(1000, 450, true)).toEqual(room(1000, 1, 0));
      expect(avatarColumnLayout(768, undefined, true)).toEqual(room(768, 1, 0));
      expect(avatarColumnLayout(375, undefined, true)).toEqual(room(375, 1, 0));
    });

    test('the desk has the columns the breakpoints say, at 1099, 1100, 1499, 1500, 1920 and 2560', () => {
      expect([1099, 1100, 1499, 1500, 1920, 2560].map(avatarDeskColumns)).toEqual([1, 2, 2, 3, 3, 3]);
    });

    test('the side columns never leave the conversation less than 700 px, and grow only in a very wide window', () => {
      expect(avatarRoomRailWidth(1099)).toBe(0);
      expect(avatarRoomRailWidth(1100)).toBe(400);
      expect(avatarRoomRailWidth(1538)).toBe(400);
      expect(avatarRoomRailWidth(1600)).toBe(416);
      expect(avatarRoomRailWidth(2000)).toBe(520);
      expect(avatarRoomRailWidth(5000)).toBe(520);
      for (let viewport = 1100; viewport <= 4000; viewport += 13) {
        const layout = avatarColumnLayout(viewport, undefined, true);
        if (layout.mode !== 'room') throw new Error('not the room');
        expect(viewport - layout.railWidth).toBeGreaterThanOrEqual(700);
      }
    });

    test('the conversation is a centred reading column only where its area is clearly wider than 760 px', () => {
      expect(AVATAR_READING_WIDTH).toBe(760);
      // The docked column at its usual widths fills its area; a wide one is centred.
      expect(avatarThreadIsCentred(avatarColumnLayout(1920, undefined))).toBe(false);
      expect(avatarThreadIsCentred(avatarColumnLayout(1920, 839))).toBe(false);
      expect(avatarThreadIsCentred(avatarColumnLayout(1920, 840))).toBe(true);
      expect(avatarThreadIsCentred(avatarColumnLayout(2560, 1280))).toBe(true);
      expect(avatarThreadIsCentred(avatarColumnLayout(1280, 560))).toBe(false);
      expect(avatarThreadIsCentred(avatarColumnLayout(600, undefined))).toBe(false);
      // The room: what the rail leaves is what counts.
      expect(avatarThreadIsCentred(avatarColumnLayout(1100, undefined, true))).toBe(false);
      expect(avatarThreadIsCentred(avatarColumnLayout(1239, undefined, true))).toBe(false);
      expect(avatarThreadIsCentred(avatarColumnLayout(1240, undefined, true))).toBe(true);
      expect(avatarThreadIsCentred(avatarColumnLayout(1920, undefined, true))).toBe(true);
      // Three columns at 1500 px leave the conversation 700 px: it fills them.
      expect(avatarThreadIsCentred(avatarColumnLayout(1500, undefined, true))).toBe(false);
      // Without a rail the whole window is the conversation's.
      expect(avatarThreadIsCentred(avatarColumnLayout(1000, undefined, true))).toBe(true);
      expect(avatarThreadIsCentred(avatarColumnLayout(839, undefined, true))).toBe(false);
    });

    test('without the room the same windows are the column, the floating column and the sheet, as before', () => {
      for (const room of [false, undefined]) {
        expect(avatarColumnLayout(2560, undefined, room)).toEqual({ mode: 'docked', width: 380, maxWidth: 1280 });
        expect(avatarColumnLayout(1920, 450, room)).toEqual({ mode: 'docked', width: 450, maxWidth: 920 });
        expect(avatarColumnLayout(1440, 9999, room)).toEqual({ mode: 'docked', width: 440, maxWidth: 440 });
        expect(avatarColumnLayout(1100, undefined, room)).toEqual({ mode: 'overlay', width: 380, maxWidth: 560 });
        expect(avatarColumnLayout(768, undefined, room)).toEqual({ mode: 'sheet', width: 768, maxWidth: 768 });
      }
    });

    test('whenever it is docked the page is left at least 1000 px', () => {
      for (let viewport = 769; viewport <= 4000; viewport += 7) {
        const layout = avatarColumnLayout(viewport, 9999);
        if (layout.mode !== 'docked') continue;
        expect(viewport - layout.width).toBeGreaterThanOrEqual(AVATAR_PAGE_MIN_WIDTH);
        expect(layout.width).toBeLessThanOrEqual(viewport / 2);
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
