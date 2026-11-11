/**
 * Preferences for the optional avatar panel — a floating window that shows a
 * 3D character who lip-syncs Kookr's spoken summaries.
 *
 * The panel is OFF by default. Nothing about it (the 3D renderer chunk, the
 * avatar file) is requested by the browser until `enabled` is true, so an
 * operator who never turns it on pays nothing for it.
 *
 * These are per-browser UI preferences (the feature needs a GPU, which varies
 * by device), so they live in localStorage next to the other layout prefs
 * rather than in the server's settings file. Every read is fail-soft: a
 * missing, malformed or out-of-range value falls back to the default.
 */
import { useSyncExternalStore } from 'react';

export const AVATAR_PANEL_KEY = 'kookr:avatarPanel';

/** Size of the open panel, in CSS pixels. The dock is fixed-size in this version. */
export const AVATAR_PANEL_WIDTH = 264;
export const AVATAR_PANEL_HEIGHT = 348;
/** Diameter of the minimised bubble. */
export const AVATAR_BUBBLE_SIZE = 58;
/** Gap kept between the panel and the viewport edge. */
export const AVATAR_PANEL_MARGIN = 12;

export interface AvatarPanelPrefs {
  /** Master switch. False means the panel is never mounted or downloaded. */
  enabled: boolean;
  /** True when collapsed to the bubble. */
  minimized: boolean;
  /**
   * Top-left corner of the panel, in CSS pixels from the viewport's top-left.
   * `null` means "never dragged": the panel sits in the bottom-right corner.
   */
  position: { x: number; y: number } | null;
}

export const DEFAULT_AVATAR_PANEL_PREFS: AvatarPanelPrefs = {
  enabled: false,
  minimized: false,
  position: null,
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

/**
 * Keep a panel of `width` x `height` fully inside a viewport. Used for both the
 * open panel and the bubble, on drag and on window resize, so a position saved
 * on a large monitor can never strand the panel off-screen on a small one.
 */
export function clampAvatarPanelPosition(
  position: { x: number; y: number },
  viewport: { width: number; height: number },
  size: { width: number; height: number } = { width: AVATAR_PANEL_WIDTH, height: AVATAR_PANEL_HEIGHT },
): { x: number; y: number } {
  const maxX = Math.max(AVATAR_PANEL_MARGIN, viewport.width - size.width - AVATAR_PANEL_MARGIN);
  const maxY = Math.max(AVATAR_PANEL_MARGIN, viewport.height - size.height - AVATAR_PANEL_MARGIN);
  const x = Number.isFinite(position.x) ? position.x : maxX;
  const y = Number.isFinite(position.y) ? position.y : maxY;
  return {
    x: Math.round(Math.min(Math.max(x, AVATAR_PANEL_MARGIN), maxX)),
    y: Math.round(Math.min(Math.max(y, AVATAR_PANEL_MARGIN), maxY)),
  };
}

/** Where the panel sits before the operator has ever dragged it: bottom-right. */
export function defaultAvatarPanelPosition(
  viewport: { width: number; height: number },
  size: { width: number; height: number } = { width: AVATAR_PANEL_WIDTH, height: AVATAR_PANEL_HEIGHT },
): { x: number; y: number } {
  return clampAvatarPanelPosition(
    { x: viewport.width - size.width - 16, y: viewport.height - size.height - 44 },
    viewport,
    size,
  );
}

function parsePrefs(raw: string | null): AvatarPanelPrefs {
  if (raw === null) return DEFAULT_AVATAR_PANEL_PREFS;
  try {
    const value = JSON.parse(raw) as Partial<AvatarPanelPrefs> | null;
    if (typeof value !== 'object' || value === null) return DEFAULT_AVATAR_PANEL_PREFS;
    const pos = value.position;
    const position =
      pos && typeof pos === 'object' && Number.isFinite(pos.x) && Number.isFinite(pos.y)
        ? { x: Math.round(pos.x), y: Math.round(pos.y) }
        : null;
    return {
      enabled: value.enabled === true,
      minimized: value.minimized === true,
      position,
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

function getAvatarPanelPrefs(): AvatarPanelPrefs {
  return state;
}

export function updateAvatarPanelPrefs(patch: Partial<AvatarPanelPrefs>): AvatarPanelPrefs {
  state = { ...state, ...patch };
  saveAvatarPanelPrefs(state);
  emit();
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
