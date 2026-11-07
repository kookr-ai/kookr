/**
 * Persisted per-viewer preference for whether the Hermes observed lane panel is
 * expanded (jeanibarz/hermes-fleet#15, slice 2). The always-visible header pill
 * is the entry point; this remembers whether the fuller sidebar lane is open.
 *
 * Best-effort and fail-soft, mirroring {@link loadFindingsWidth}: a missing,
 * malformed, or unreadable value (private window, blocked storage) falls back to
 * the default (collapsed), and a write that throws is swallowed. The lane is a
 * convenience surface, so storage must never break rendering.
 */

export const HERMES_LANE_OPEN_KEY = 'kookr:hermesLaneOpen';

/** Default when unset: collapsed to just the pill (least intrusive). */
export const HERMES_LANE_OPEN_DEFAULT = false;

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

function getStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/** Load the persisted open state, or the default when unset/invalid/unreadable. */
export function loadHermesLaneOpen(storage: ReadStorage | null = getStorage()): boolean {
  if (!storage) return HERMES_LANE_OPEN_DEFAULT;
  try {
    const raw = storage.getItem(HERMES_LANE_OPEN_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return HERMES_LANE_OPEN_DEFAULT;
  } catch {
    return HERMES_LANE_OPEN_DEFAULT;
  }
}

/** Persist the open state (best effort). Returns an Error if storage refused. */
export function saveHermesLaneOpen(open: boolean, storage: WriteStorage | null = getStorage()): Error | null {
  if (!storage) return new Error('localStorage unavailable');
  try {
    storage.setItem(HERMES_LANE_OPEN_KEY, open ? '1' : '0');
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
