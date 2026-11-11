import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tracked = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../telemetry.js', () => ({ track: (event: Record<string, unknown>) => { tracked.push(event); } }));
import {
  AVATAR_BUBBLE_SIZE,
  AVATAR_PANEL_HEIGHT,
  AVATAR_PANEL_KEY,
  AVATAR_PANEL_MARGIN,
  AVATAR_PANEL_WIDTH,
  DEFAULT_AVATAR_PANEL_PREFS,
  __resetAvatarPanelPrefsForTests,
  clampAvatarPanelPosition,
  defaultAvatarPanelPosition,
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
    const prefs = { enabled: true, minimized: true, position: { x: 40, y: 60 } };
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

  test('only a literal true enables the panel; a bad position is dropped, not trusted', () => {
    const storage = fakeStorage({
      [AVATAR_PANEL_KEY]: JSON.stringify({ enabled: 'yes', minimized: 1, position: { x: 'left', y: 10 } }),
    });
    expect(loadAvatarPanelPrefs(storage.impl)).toEqual({ enabled: false, minimized: false, position: null });
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
      const next = updateAvatarPanelPrefs({ minimized: true, position: { x: 20, y: 30 } });

      expect(next).toEqual({ enabled: true, minimized: true, position: { x: 20, y: 30 } });
      expect(JSON.parse(storage.map.get(AVATAR_PANEL_KEY) ?? 'null')).toEqual(next);
    });

    test('a store that starts from saved prefs keeps them when one field changes', () => {
      const storage = fakeStorage({
        [AVATAR_PANEL_KEY]: JSON.stringify({ enabled: true, minimized: false, position: { x: 5, y: 6 } }),
      });
      vi.stubGlobal('localStorage', storage.impl);
      __resetAvatarPanelPrefsForTests();

      expect(updateAvatarPanelPrefs({ minimized: true })).toEqual({
        enabled: true,
        minimized: true,
        position: { x: 5, y: 6 },
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

  describe('clampAvatarPanelPosition', () => {
    const viewport = { width: 1200, height: 800 };

    test('keeps an in-bounds position unchanged', () => {
      expect(clampAvatarPanelPosition({ x: 300, y: 200 }, viewport)).toEqual({ x: 300, y: 200 });
    });

    test('pulls a panel dragged off any edge back inside, with a margin', () => {
      const maxX = viewport.width - AVATAR_PANEL_WIDTH - AVATAR_PANEL_MARGIN;
      const maxY = viewport.height - AVATAR_PANEL_HEIGHT - AVATAR_PANEL_MARGIN;
      expect(clampAvatarPanelPosition({ x: -500, y: -500 }, viewport)).toEqual({ x: AVATAR_PANEL_MARGIN, y: AVATAR_PANEL_MARGIN });
      expect(clampAvatarPanelPosition({ x: 5000, y: 5000 }, viewport)).toEqual({ x: maxX, y: maxY });
    });

    test('a position saved on a big screen is brought back on a small one', () => {
      const small = { width: 500, height: 420 };
      const clamped = clampAvatarPanelPosition({ x: 1700, y: 900 }, small);
      expect(clamped.x + AVATAR_PANEL_WIDTH).toBeLessThanOrEqual(small.width);
      expect(clamped.y + AVATAR_PANEL_HEIGHT).toBeLessThanOrEqual(small.height);
    });

    test('a viewport smaller than the panel pins it to the top-left margin instead of going negative', () => {
      expect(clampAvatarPanelPosition({ x: 50, y: 50 }, { width: 100, height: 100 })).toEqual({
        x: AVATAR_PANEL_MARGIN,
        y: AVATAR_PANEL_MARGIN,
      });
    });

    test('non-finite coordinates fall back to the far corner', () => {
      const result = clampAvatarPanelPosition({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, viewport);
      expect(result).toEqual({
        x: viewport.width - AVATAR_PANEL_WIDTH - AVATAR_PANEL_MARGIN,
        y: viewport.height - AVATAR_PANEL_HEIGHT - AVATAR_PANEL_MARGIN,
      });
    });

    test('a custom size (the bubble) is clamped by its own dimensions', () => {
      const size = { width: AVATAR_BUBBLE_SIZE, height: AVATAR_BUBBLE_SIZE };
      expect(clampAvatarPanelPosition({ x: 5000, y: 5000 }, viewport, size)).toEqual({
        x: viewport.width - AVATAR_BUBBLE_SIZE - AVATAR_PANEL_MARGIN,
        y: viewport.height - AVATAR_BUBBLE_SIZE - AVATAR_PANEL_MARGIN,
      });
    });
  });

  test('the default position is the bottom-right corner, fully on screen', () => {
    const viewport = { width: 1400, height: 900 };
    const position = defaultAvatarPanelPosition(viewport);
    expect(position.x).toBeGreaterThan(viewport.width / 2);
    expect(position.y).toBeGreaterThan(viewport.height / 2);
    expect(position.x + AVATAR_PANEL_WIDTH).toBeLessThanOrEqual(viewport.width);
    expect(position.y + AVATAR_PANEL_HEIGHT).toBeLessThanOrEqual(viewport.height);
  });

  test('switching the panel on or off is recorded once per actual change, and moving or minimising is not', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    __resetAvatarPanelPrefsForTests();
    tracked.length = 0;

    updateAvatarPanelPrefs({ enabled: true });
    updateAvatarPanelPrefs({ enabled: true, minimized: true });
    updateAvatarPanelPrefs({ position: { x: 1, y: 2 } });
    updateAvatarPanelPrefs({ enabled: false });
    updateAvatarPanelPrefs({ enabled: false });

    expect(tracked).toEqual([
      { type: 'lucy_panel_action', action: 'enable' },
      { type: 'lucy_panel_action', action: 'disable' },
    ]);
  });
});
