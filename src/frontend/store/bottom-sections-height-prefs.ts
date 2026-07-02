/**
 * Persisted preference for the height (in px) of the findings panel's
 * `.bottom-sections` area — the scroll box that holds the Healthy, Pending,
 * Snoozed and Completed groups below the live findings list.
 *
 * Historically this area was capped at a fixed `max-height: 30%`, which users
 * could neither grow (to see more healthy tasks at once) nor shrink (to give
 * the findings list more room). This preference backs a drag handle that lets
 * the user set the height explicitly; it is remembered across reloads.
 *
 * Stored as a single integer string under one localStorage key, mirroring the
 * fail-soft style of {@link ./dashboard-layout-prefs}: a missing, malformed, or
 * out-of-range value falls back to `null` (meaning "use the CSS default"), so a
 * partially-written or future-format value never collapses the pane.
 */

export const BOTTOM_SECTIONS_HEIGHT_KEY = 'kookr:bottomSectionsHeight';

/**
 * Hard bounds for the bottom-sections height. The minimum keeps at least a
 * row or two visible; the maximum keeps the findings list above it usable. The
 * resizer additionally clamps to the live panel height at runtime (see
 * `clampBottomSectionsHeight`'s `maxAvailable`) so the divider can never be
 * dragged to a size that hides the findings entirely.
 */
export const MIN_BOTTOM_SECTIONS_HEIGHT = 76;
export const MAX_BOTTOM_SECTIONS_HEIGHT = 1200;

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem' | 'removeItem'>;

function getStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/**
 * Clamp a desired height into the usable range. `maxAvailable` (the live panel
 * height minus the space the findings list must keep) further tightens the
 * upper bound; callers pass it during a live resize so the divider can never be
 * dragged past what the layout can show.
 */
export function clampBottomSectionsHeight(
  height: number,
  maxAvailable = MAX_BOTTOM_SECTIONS_HEIGHT,
): number {
  if (!Number.isFinite(height)) return MIN_BOTTOM_SECTIONS_HEIGHT;
  const upper = Math.max(
    MIN_BOTTOM_SECTIONS_HEIGHT,
    Math.min(MAX_BOTTOM_SECTIONS_HEIGHT, maxAvailable),
  );
  return Math.round(Math.min(Math.max(height, MIN_BOTTOM_SECTIONS_HEIGHT), upper));
}

/** Load the persisted height, or `null` when unset/invalid. */
export function loadBottomSectionsHeight(storage: ReadStorage | null = getStorage()): number | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(BOTTOM_SECTIONS_HEIGHT_KEY);
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return null;
    return clampBottomSectionsHeight(parsed);
  } catch {
    return null;
  }
}

/** Persist a height (best effort). Returns an Error if storage refused. */
export function saveBottomSectionsHeight(height: number, storage: WriteStorage | null = getStorage()): Error | null {
  if (!storage) return new Error('localStorage unavailable');
  try {
    storage.setItem(BOTTOM_SECTIONS_HEIGHT_KEY, String(clampBottomSectionsHeight(height)));
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** Clear the persisted height (best effort), reverting to the CSS default. */
export function clearBottomSectionsHeight(storage: WriteStorage | null = getStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(BOTTOM_SECTIONS_HEIGHT_KEY);
  } catch {
    // best-effort; ignore quota/availability failures
  }
}
