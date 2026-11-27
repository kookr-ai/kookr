/**
 * Preferences for the optional avatar panel: Lucy's column, docked to the right edge of the
 * dashboard, with a 3D character who lip-syncs Kookr's spoken summaries.
 *
 * The panel is OFF by default. Nothing about it (the 3D renderer chunk, the
 * avatar file) is requested by the browser until `enabled` is true, so an
 * operator who never turns it on pays nothing for it.
 *
 * These are per-browser UI preferences (the feature needs a GPU, which varies
 * by device), so they live in localStorage next to the other layout prefs
 * rather than in the server's settings file. Every read is fail-soft: a
 * missing, malformed or out-of-range value falls back to the default.
 *
 * Older versions also saved `position`, the corner of a floating window that could be dragged.
 * The panel is a docked column now, so that field is read past and never written again.
 *
 * One thing here is not a shared preference: "Lucy's room", where she takes the whole window. It belongs to
 * one browser tab (`sessionStorage`), so the dashboard can stay in one window while she has another to
 * herself; see the room section below.
 */
import { useSyncExternalStore } from 'react';
import { track } from '../telemetry.js';

export const AVATAR_PANEL_KEY = 'kookr:avatarPanel';

/** Width of the open column, in CSS pixels, before the operator drags its left edge. */
export const AVATAR_COLUMN_DEFAULT_WIDTH = 380;
/** The narrowest the operator can make the column. */
export const AVATAR_COLUMN_MIN_WIDTH = 320;
/**
 * Docked beside the page, the column may take up to this share of the window (and never so much that the page
 * drops below `AVATAR_PAGE_MIN_WIDTH`): 560 px in a 1560 px window, 920 px at 1920, 1280 px at 2560.
 */
export const AVATAR_COLUMN_MAX_VIEWPORT_SHARE = 0.5;
/** The widest the column may be while it floats over the page (a window too narrow to give it room). */
export const AVATAR_COLUMN_OVERLAY_MAX_WIDTH = 560;
/**
 * The widest width that is ever saved or read back, whatever the window. What a window really allows is decided
 * by `avatarColumnLayout`; this only keeps a nonsense saved value out.
 */
export const AVATAR_COLUMN_MAX_WIDTH = 2560;
/**
 * At or below this viewport width the column is a full-width sheet over the page instead of a column
 * beside it. The same breakpoint the dashboard uses for its phone layout (`MOBILE_BREAKPOINT_PX` in App.tsx).
 */
export const AVATAR_SHEET_MAX_VIEWPORT_PX = 768;
/**
 * The dashboard's panes and top bar are laid out by the window's width (media queries), not by the width
 * the page is left with, and they collide below about this much room. So the column only takes room from
 * the page while the page keeps at least this many pixels.
 */
export const AVATAR_PAGE_MIN_WIDTH = 1000;
/** Diameter of the minimised bubble. */
export const AVATAR_BUBBLE_SIZE = 58;
/**
 * Lucy's room is "the desk" (AvatarDock.tsx). From this window width it has two columns: Decisions with Fleet
 * stacked under it on the left, the conversation on the right. In a narrower window it is one column, laid out
 * like the docked column with Decisions on top.
 */
export const AVATAR_ROOM_RAIL_MIN_VIEWPORT_PX = 1100;
/** From this window width the desk has three columns: Decisions, Fleet, Conversation. */
export const AVATAR_DESK_THREE_COLUMN_MIN_VIEWPORT_PX = 1500;
/** A side column (Decisions, Fleet) is 26% of the window, never under 400 px nor over 520 px. */
export const AVATAR_ROOM_RAIL_MIN_WIDTH = 400;
export const AVATAR_ROOM_RAIL_MAX_WIDTH = 520;
export const AVATAR_ROOM_RAIL_VIEWPORT_SHARE = 0.26;
/**
 * The conversation and the composer are at most this wide, centred in the room they have (`--lucy-reading-width`
 * in styles.css says the same).
 */
export const AVATAR_READING_WIDTH = 760;
/**
 * From this much room the conversation is narrower than its area by a clear margin, so it can keep the
 * scrollbar's room on both sides and stay centred over the composer (`avatarThreadIsCentred`).
 */
export const AVATAR_CENTRED_THREAD_MIN_WIDTH = 840;

export interface AvatarPanelPrefs {
  /** Master switch. False means the panel is never mounted or downloaded. */
  enabled: boolean;
  /** True when collapsed to the bubble. */
  minimized: boolean;
  /** Width of the open column in CSS pixels, when the operator has dragged it; absent means the default. */
  width?: number;
}

export const DEFAULT_AVATAR_PANEL_PREFS: AvatarPanelPrefs = {
  enabled: false,
  minimized: false,
};

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Keep a column width inside its limits (at most `max`, the widest this window allows); anything that is not a number is the default. */
export function clampAvatarColumnWidth(width: unknown, max: number = AVATAR_COLUMN_MAX_WIDTH): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return Math.min(AVATAR_COLUMN_DEFAULT_WIDTH, max);
  return Math.round(Math.min(Math.max(width, AVATAR_COLUMN_MIN_WIDTH), max));
}

export type AvatarColumnLayout =
  | { mode: 'sheet' | 'overlay' | 'docked'; width: number; maxWidth: number }
  | {
      mode: 'room';
      width: number;
      maxWidth: number;
      /** True from 1100 px: the desk has side columns. */
      rail: boolean;
      /** The width of all the side columns together (0 in one column). */
      railWidth: number;
      /** How many columns the desk has. */
      columns: 1 | 2 | 3;
      /** The width of one side column (Decisions, Fleet); 0 in one column. */
      sideWidth: number;
    };

/** The desk's columns in a window of `viewportWidth`: three from 1500 px, two from 1100 px, else one. */
export function avatarDeskColumns(viewportWidth: number): 1 | 2 | 3 {
  if (viewportWidth >= AVATAR_DESK_THREE_COLUMN_MIN_VIEWPORT_PX) return 3;
  return viewportWidth >= AVATAR_ROOM_RAIL_MIN_VIEWPORT_PX ? 2 : 1;
}

/** How wide one side column of the desk is in a window of `viewportWidth`; 0 where the desk is one column. */
export function avatarRoomRailWidth(viewportWidth: number): number {
  if (avatarDeskColumns(viewportWidth) === 1) return 0;
  const share = Math.round(viewportWidth * AVATAR_ROOM_RAIL_VIEWPORT_SHARE);
  return Math.min(Math.max(share, AVATAR_ROOM_RAIL_MIN_WIDTH), AVATAR_ROOM_RAIL_MAX_WIDTH);
}

/**
 * Whether the conversation, in this layout, is narrower than the area it sits in: only then is it centred, and
 * only then may the thread reserve the scrollbar's room on both sides. In a narrower area the conversation
 * fills it and is laid out exactly as it always was.
 */
export function avatarThreadIsCentred(layout: AvatarColumnLayout): boolean {
  const area = layout.mode === 'room' ? layout.width - layout.railWidth : layout.width;
  return area >= AVATAR_CENTRED_THREAD_MIN_WIDTH;
}

/**
 * How the open panel sits in a window of `viewportWidth`:
 *  - `room`: the operator gave her the whole window (`room` is true). She covers the page at every window
 *    width; `columns` says how many columns the desk has (see `avatarDeskColumns`), `sideWidth` how wide each
 *    side column is, and `railWidth` how wide they are together (0 in one column).
 *  - `sheet`: a window of 768 px or less; the column covers the whole page.
 *  - `overlay`: not enough room to take any from the page and leave it 1000 px (windows of 769 to 1319 px); the
 *    column floats over the page at the saved width (560 px at most), and the page keeps its full width and layout.
 *  - `docked`: the page makes room for the column. Its width is the saved one, capped so the page keeps 1000 px
 *    and the column takes no more than half the window. The cap is never saved, so a wide saved width comes
 *    back when the window is wide again.
 * `maxWidth` is the widest the operator can drag the column to in this mode.
 */
export function avatarColumnLayout(viewportWidth: number, savedWidth?: number, room = false): AvatarColumnLayout {
  if (room) {
    const columns = avatarDeskColumns(viewportWidth);
    const sideWidth = avatarRoomRailWidth(viewportWidth);
    return {
      mode: 'room',
      width: viewportWidth,
      maxWidth: viewportWidth,
      rail: columns > 1,
      railWidth: sideWidth * (columns - 1),
      columns,
      sideWidth,
    };
  }
  if (viewportWidth <= AVATAR_SHEET_MAX_VIEWPORT_PX) return { mode: 'sheet', width: viewportWidth, maxWidth: viewportWidth };
  if (viewportWidth - AVATAR_PAGE_MIN_WIDTH < AVATAR_COLUMN_MIN_WIDTH) {
    const maxWidth = Math.min(AVATAR_COLUMN_OVERLAY_MAX_WIDTH, viewportWidth);
    return { mode: 'overlay', width: clampAvatarColumnWidth(savedWidth, maxWidth), maxWidth };
  }
  const maxWidth = Math.min(
    AVATAR_COLUMN_MAX_WIDTH,
    viewportWidth - AVATAR_PAGE_MIN_WIDTH,
    Math.floor(viewportWidth * AVATAR_COLUMN_MAX_VIEWPORT_SHARE),
  );
  return { mode: 'docked', width: clampAvatarColumnWidth(savedWidth, maxWidth), maxWidth };
}

function parsePrefs(raw: string | null): AvatarPanelPrefs {
  if (raw === null) return DEFAULT_AVATAR_PANEL_PREFS;
  try {
    const value = JSON.parse(raw) as Partial<AvatarPanelPrefs> | null;
    if (typeof value !== 'object' || value === null) return DEFAULT_AVATAR_PANEL_PREFS;
    return {
      enabled: value.enabled === true,
      minimized: value.minimized === true,
      // A saved `position` from the floating-window days is ignored on purpose.
      ...(typeof value.width === 'number' && Number.isFinite(value.width) ? { width: clampAvatarColumnWidth(value.width) } : {}),
    };
  } catch {
    return DEFAULT_AVATAR_PANEL_PREFS;
  }
}

/** Load the persisted prefs; any problem yields the defaults (panel off). */
export function loadAvatarPanelPrefs(storage: ReadStorage | null = getStorage()): AvatarPanelPrefs {
  if (!storage) return DEFAULT_AVATAR_PANEL_PREFS;
  try {
    return parsePrefs(storage.getItem(AVATAR_PANEL_KEY));
  } catch {
    return DEFAULT_AVATAR_PANEL_PREFS;
  }
}

/** Persist prefs (best effort). Returns an Error if storage refused. */
export function saveAvatarPanelPrefs(
  prefs: AvatarPanelPrefs,
  storage: WriteStorage | null = getStorage(),
): Error | null {
  if (!storage) return new Error('localStorage unavailable');
  try {
    storage.setItem(AVATAR_PANEL_KEY, JSON.stringify(prefs));
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

// --- the "Waiting on you" strip: folded or unfolded, for this browser tab only ---

export const AVATAR_TRAY_EXPANDED_KEY = 'kookr:lucyTrayExpanded';

function getSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Whether the operator left the strip unfolded in this tab. Folded when nothing is saved or storage cannot be read. */
export function loadTrayExpanded(): boolean {
  try {
    return getSessionStorage()?.getItem(AVATAR_TRAY_EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remember the choice until the tab is closed (best effort). */
export function saveTrayExpanded(expanded: boolean): void {
  try {
    const storage = getSessionStorage();
    if (expanded) storage?.setItem(AVATAR_TRAY_EXPANDED_KEY, '1');
    else storage?.removeItem(AVATAR_TRAY_EXPANDED_KEY);
  } catch {
    // The strip then starts folded on the next load.
  }
}

/**
 * How many times the dashboard asked for the strip to be unfolded. A tray that is already on screen cannot read
 * the saved choice again, so it watches this count and unfolds when it changes.
 */
let trayOpenRequests = 0;

/**
 * Open Lucy on what waits for the operator: switch her panel on if it is off, bring her out of the bubble,
 * and unfold the "Waiting on you" strip. It answers nothing; the cards stay hers to answer.
 */
export function openLucyOnWaiting(): void {
  saveTrayExpanded(true);
  trayOpenRequests += 1;
  updateAvatarPanelPrefs({ enabled: true, minimized: false });
}

/** React binding for {@link openLucyOnWaiting}: the number of requests so far in this tab. */
export function useTrayOpenRequests(): number {
  return useSyncExternalStore(subscribe, () => trayOpenRequests, () => 0);
}

// --- Lucy's room: she takes the whole window, in this browser tab only ---

/**
 * Where "this tab shows Lucy's room" is kept. `sessionStorage`, not the shared preferences: those follow every
 * open tab, and the point of the room is the dashboard in one window and Lucy in another. It survives a
 * reload of the tab and is gone when the tab is closed.
 */
export const AVATAR_ROOM_KEY = 'kookr:lucyRoom';
/** `/?lucy=room` opens the dashboard with Lucy in her room. */
export const AVATAR_ROOM_QUERY = 'lucy';
export const AVATAR_ROOM_QUERY_VALUE = 'room';

function loadAvatarRoom(): boolean {
  try {
    return getSessionStorage()?.getItem(AVATAR_ROOM_KEY) === '1';
  } catch {
    return false;
  }
}

function saveAvatarRoom(on: boolean): void {
  try {
    const storage = getSessionStorage();
    if (on) storage?.setItem(AVATAR_ROOM_KEY, '1');
    else storage?.removeItem(AVATAR_ROOM_KEY);
  } catch {
    // The room then lasts until the next reload of this tab.
  }
}

/** True when the query string asks for Lucy's room (`?lucy=room`, or `lucy=room` among other parameters). */
export function parseAvatarRoomQuery(search: string): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return params.get(AVATAR_ROOM_QUERY)?.trim().toLowerCase() === AVATAR_ROOM_QUERY_VALUE;
}

/** Drop `lucy=room` from a path+search+hash string, leaving the other parameters and the hash as they are. */
export function stripAvatarRoomQuery(pathSearchHash: string): string {
  const url = new URL(pathSearchHash, 'http://kookr.invalid');
  if (!parseAvatarRoomQuery(url.search)) return pathSearchHash;
  url.searchParams.delete(AVATAR_ROOM_QUERY);
  return `${url.pathname}${url.search}${url.hash}`;
}

// --- live store, shared by the settings toggle and the panel itself ---

let state: AvatarPanelPrefs = loadAvatarPanelPrefs();
let room: boolean = loadAvatarRoom();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // Another tab changed the preference: follow it.
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== AVATAR_PANEL_KEY) return;
    state = parsePrefs(event.newValue);
    // Switched off elsewhere: the room goes with the panel here too (see updateAvatarPanelPrefs).
    if (!state.enabled && room) {
      room = false;
      saveAvatarRoom(false);
    }
    emit();
  });
}

export function getAvatarPanelPrefs(): AvatarPanelPrefs {
  return state;
}

export function updateAvatarPanelPrefs(patch: Partial<AvatarPanelPrefs>): AvatarPanelPrefs {
  const wasEnabled = state.enabled;
  state = { ...state, ...patch };
  saveAvatarPanelPrefs(state);
  // Switched off: the room goes with the panel, so switching it on again starts as the column.
  if (!state.enabled && room) {
    room = false;
    saveAvatarRoom(false);
  }
  emit();
  if (state.enabled !== wasEnabled) {
    track({ type: 'lucy_panel_action', action: state.enabled ? 'enable' : 'disable' });
  }
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding: re-renders when the prefs change in this tab or another one. */
export function useAvatarPanelPrefs(): AvatarPanelPrefs {
  return useSyncExternalStore(subscribe, getAvatarPanelPrefs, () => DEFAULT_AVATAR_PANEL_PREFS);
}

/** Whether this tab shows Lucy's room. Only meaningful while the panel is switched on. */
export function getAvatarRoom(): boolean {
  return room;
}

/** Enter or leave Lucy's room in this tab. Remembered until the tab is closed; recorded once per actual change. */
export function setAvatarRoom(on: boolean): void {
  if (room === on) return;
  room = on;
  saveAvatarRoom(on);
  emit();
  track({ type: 'lucy_panel_action', action: on ? 'expand' : 'collapse' });
}

/**
 * A task was just selected in the dashboard from inside the room ("Open task"): leave the room so the task is
 * on screen, with her column beside it. Does nothing outside the room.
 */
export function leaveAvatarRoomToShowTask(): void {
  if (!room) return;
  // The room showed her whatever the shared "minimised" choice said; beside the task she is the column, not the bubble.
  if (state.minimized) updateAvatarPanelPrefs({ minimized: false });
  setAvatarRoom(false);
}

/**
 * Whether Lucy covers the whole dashboard in this tab right now: her room, or the full-width sheet of a narrow
 * window. The dock reports it while it renders either (not merely the saved room flag: the dock may have crashed,
 * or its chunk may still be loading). While it is true the dashboard's
 * shortcuts are held back and the dashboard underneath is `inert` (App.tsx), so Tab cannot reach a control nobody
 * can see and a screen reader does not read it (unless a dialog of its own is open on top of her: #4166).
 */
let pageCovered = false;

export function setAvatarPageCovered(on: boolean): void {
  if (pageCovered === on) return;
  pageCovered = on;
  emit();
}

export function useAvatarPageCovered(): boolean {
  return useSyncExternalStore(subscribe, () => pageCovered, () => false);
}

/** React binding: re-renders when this tab enters or leaves the room. */
export function useAvatarRoom(): boolean {
  return useSyncExternalStore(subscribe, getAvatarRoom, () => false);
}

/**
 * Honour `/?lucy=room` in the page's address: this tab shows Lucy's room, whatever the saved preferences say.
 * Read once at load, then removed from the address (like `?task=`), so a later reload follows what the operator
 * did since; the tab stays in the room through `sessionStorage`. The operator asked for her by address, so a
 * panel that is switched off is switched on, as Settings would. Returns whether the address asked for the room.
 */
export function applyAvatarRoomAddress(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (!parseAvatarRoomQuery(window.location.search)) return false;
    const next = stripAvatarRoomQuery(`${window.location.pathname}${window.location.search}${window.location.hash}`);
    window.history.replaceState(window.history.state, '', next);
  } catch {
    return false;
  }
  if (!state.enabled) updateAvatarPanelPrefs({ enabled: true, minimized: false });
  setAvatarRoom(true);
  return true;
}

export function __resetAvatarPanelPrefsForTests(): void {
  state = loadAvatarPanelPrefs();
  room = loadAvatarRoom();
  pageCovered = false;
  trayOpenRequests = 0;
  listeners.clear();
}
