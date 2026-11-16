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
 */
import { useSyncExternalStore } from 'react';
import { track } from '../telemetry.js';

export const AVATAR_PANEL_KEY = 'kookr:avatarPanel';

/** Width of the open column, in CSS pixels, before the operator drags its left edge. */
export const AVATAR_COLUMN_DEFAULT_WIDTH = 380;
/** The narrowest and the widest the operator can make the column. */
export const AVATAR_COLUMN_MIN_WIDTH = 320;
export const AVATAR_COLUMN_MAX_WIDTH = 560;
/**
 * At or below this viewport width the column is a full-width sheet over the page instead of a column
 * beside it. The same breakpoint the dashboard uses for its phone layout (`MOBILE_BREAKPOINT_PX` in App.tsx).
 */
export const AVATAR_SHEET_MAX_VIEWPORT_PX = 768;
/** Diameter of the minimised bubble. */
export const AVATAR_BUBBLE_SIZE = 58;

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

/** Keep a column width inside its limits; anything that is not a number is the default. */
export function clampAvatarColumnWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return AVATAR_COLUMN_DEFAULT_WIDTH;
  return Math.round(Math.min(Math.max(width, AVATAR_COLUMN_MIN_WIDTH), AVATAR_COLUMN_MAX_WIDTH));
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

// --- live store, shared by the settings toggle and the panel itself ---

let state: AvatarPanelPrefs = loadAvatarPanelPrefs();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // Another tab changed the preference: follow it.
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== AVATAR_PANEL_KEY) return;
    state = parsePrefs(event.newValue);
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

export function __resetAvatarPanelPrefsForTests(): void {
  state = loadAvatarPanelPrefs();
  listeners.clear();
}
