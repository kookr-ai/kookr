/**
 * Persisted preference for the desktop dashboard split — the width (in px) of
 * the findings panel that sits to the left of the terminal/detail viewport.
 *
 * Stored as a single integer string under one localStorage key, mirroring the
 * best-effort, fail-soft style of {@link usePersistedCollapsed} and
 * project-sidebar-prefs: a missing, malformed, or out-of-range value falls back
 * to `null` (meaning "use the CSS default width") so a partially-written or
 * future-format value never collapses a pane.
 */

export const DASHBOARD_SPLIT_KEY = 'kookr:dashboardFindingsWidth';

/**
 * Hard bounds for the findings panel width. The minimum keeps the findings
 * list readable; the maximum keeps the terminal viewport usable. The resizer
 * additionally clamps to the live container width at runtime so neither pane
 * can be dragged to an unusable size on narrow desktops.
 */
export const MIN_FINDINGS_WIDTH = 280;
export const MAX_FINDINGS_WIDTH = 720;

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

function getStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/**
 * Clamp a desired width into the usable range. `maxAvailable` (the live
 * container width minus the space the terminal must keep) further tightens the
 * upper bound; callers pass it during a live resize so the divider can never be
 * dragged past what the layout can show.
 */
export function clampFindingsWidth(width: number, maxAvailable = MAX_FINDINGS_WIDTH): number {
  if (!Number.isFinite(width)) return MIN_FINDINGS_WIDTH;
  const upper = Math.max(MIN_FINDINGS_WIDTH, Math.min(MAX_FINDINGS_WIDTH, maxAvailable));
  return Math.round(Math.min(Math.max(width, MIN_FINDINGS_WIDTH), upper));
}

/** Load the persisted findings width, or `null` when unset/invalid. */
export function loadFindingsWidth(storage: ReadStorage | null = getStorage()): number | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(DASHBOARD_SPLIT_KEY);
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return null;
    return clampFindingsWidth(parsed);
  } catch {
    return null;
  }
}

/** Persist a findings width (best effort). Returns an Error if storage refused. */
export function saveFindingsWidth(width: number, storage: WriteStorage | null = getStorage()): Error | null {
  if (!storage) return new Error('localStorage unavailable');
  try {
    storage.setItem(DASHBOARD_SPLIT_KEY, String(clampFindingsWidth(width)));
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
