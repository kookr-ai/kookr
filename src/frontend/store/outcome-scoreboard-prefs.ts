/**
 * Persisted preferences for the Outcome Scoreboard panel — the selected time
 * window and the project-scope choice.
 *
 * Stored as a single JSON object under one localStorage key, mirroring the
 * best-effort, fail-soft style of dashboard-layout-prefs and
 * project-sidebar-prefs: a missing, malformed, or future-format value falls
 * back to `null` (meaning "use the panel default") so a partially-written or
 * unknown stored value can never break the panel. The window is validated
 * against the known {@link TimeWindow} set; the project choice is an opaque
 * select value, so it is only checked to be a string here and the panel's own
 * stale-project guard drops a stored project that is no longer tracked.
 */

import type { TimeWindow } from '../../shared/contracts/cost-comparison.js';

export const OUTCOME_SCOREBOARD_PREFS_KEY = 'kookr:outcomeScoreboardPrefs';

/**
 * The valid time-window values, used to reject a stored window that no longer
 * matches the contract. Typed as `readonly TimeWindow[]` so the compiler rejects
 * an entry that is not a real {@link TimeWindow} — but it does NOT enforce
 * exhaustiveness: if `TimeWindow` gains a value (e.g. `'90d'`), add it here too,
 * or a validly-stored new window silently falls back to the default until this
 * list catches up. (The contract exposes no runtime list to derive this from.)
 */
const TIME_WINDOWS: readonly TimeWindow[] = ['24h', '7d', '30d', 'all'];

/**
 * A loaded scoreboard preference. Each field is `null` when unset or invalid,
 * signalling the panel to keep its own default.
 */
export interface OutcomeScoreboardPrefs {
  window: TimeWindow | null;
  project: string | null;
}

const EMPTY_PREFS: OutcomeScoreboardPrefs = { window: null, project: null };

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

function getStorage(): Storage | null {
  // Reading the `localStorage` global can throw a SecurityError when site
  // storage is blocked (sandboxed iframe, hardened privacy settings), so guard
  // the access itself — load runs inside the panel's render path and must never
  // throw, only fall back to defaults.
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isTimeWindow(value: unknown): value is TimeWindow {
  return typeof value === 'string' && (TIME_WINDOWS as readonly string[]).includes(value);
}

/**
 * Load the persisted scoreboard preferences. Returns `{ window: null, project:
 * null }` when unset, unreadable, malformed, or carrying values that no longer
 * validate, so a caller can always fall back to its own defaults.
 */
export function loadOutcomeScoreboardPrefs(
  storage: ReadStorage | null = getStorage(),
): OutcomeScoreboardPrefs {
  if (!storage) return { ...EMPTY_PREFS };
  try {
    const raw = storage.getItem(OUTCOME_SCOREBOARD_PREFS_KEY);
    if (!raw) return { ...EMPTY_PREFS };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY_PREFS };
    const record = parsed as { window?: unknown; project?: unknown };
    return {
      window: isTimeWindow(record.window) ? record.window : null,
      project: typeof record.project === 'string' ? record.project : null,
    };
  } catch {
    return { ...EMPTY_PREFS };
  }
}

/**
 * Persist the scoreboard preferences (best effort). Returns an `Error` when
 * storage is unavailable or the write throws (e.g. quota), otherwise `null`.
 */
export function saveOutcomeScoreboardPrefs(
  prefs: OutcomeScoreboardPrefs,
  storage: WriteStorage | null = getStorage(),
): Error | null {
  if (!storage) return new Error('localStorage unavailable');
  try {
    storage.setItem(
      OUTCOME_SCOREBOARD_PREFS_KEY,
      JSON.stringify({ window: prefs.window, project: prefs.project }),
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
