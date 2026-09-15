/**
 * Persisted preferences for the Cost Comparison panel — the selected time
 * window and the agent-filter chip.
 *
 * Stored as a single JSON object under one localStorage key, mirroring the
 * best-effort, fail-soft style of outcome-scoreboard-prefs: a missing,
 * malformed, or future-format value falls back to `null` (meaning "use the
 * panel default") so a partially-written or unknown stored value can never
 * break the panel. The free-text search box is deliberately not persisted —
 * it is a one-off query, not a standing filter.
 */

import type { CostAgent, TimeWindow } from '../../shared/contracts/cost-comparison.js';

export const COST_COMPARISON_PREFS_KEY = 'kookr:costComparisonPrefs';

/**
 * The valid time-window values, used to reject a stored window that no longer
 * matches the contract. Typed as `readonly TimeWindow[]` so the compiler rejects
 * an entry that is not a real {@link TimeWindow} — but it does NOT enforce
 * exhaustiveness: if `TimeWindow` gains a value (e.g. `'90d'`), add it here too,
 * or a validly-stored new window silently falls back to the default until this
 * list catches up. (The contract exposes no runtime list to derive this from.)
 */
const TIME_WINDOWS: readonly TimeWindow[] = ['24h', '7d', '30d', 'all'];

/** Agent-filter chip values the panel can persist. */
export type CostComparisonAgentFilter = CostAgent | 'all';

/**
 * The valid agent-filter values: the two Cost Comparison agents plus the
 * "every agent" chip. Same exhaustiveness caveat as {@link TIME_WINDOWS} —
 * a newly added {@link CostAgent} must be listed here or a stored selection
 * of it falls back to the default.
 */
const AGENT_FILTERS: readonly CostComparisonAgentFilter[] = ['all', 'claude-code', 'codex-cli'];

/**
 * A loaded Cost Comparison preference. Each field is `null` when unset or
 * invalid, signalling the panel to keep its own default (7-day window, all
 * agents).
 */
export interface CostComparisonPrefs {
  window: TimeWindow | null;
  agent: CostComparisonAgentFilter | null;
}

const EMPTY_PREFS: CostComparisonPrefs = { window: null, agent: null };

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

function isAgentFilter(value: unknown): value is CostComparisonAgentFilter {
  return typeof value === 'string' && (AGENT_FILTERS as readonly string[]).includes(value);
}

/**
 * Load the persisted Cost Comparison preferences. Returns `{ window: null,
 * agent: null }` when unset, unreadable, malformed, or carrying values that no
 * longer validate, so a caller can always fall back to its own defaults.
 */
export function loadCostComparisonPrefs(
  storage: ReadStorage | null = getStorage(),
): CostComparisonPrefs {
  if (!storage) return { ...EMPTY_PREFS };
  try {
    const raw = storage.getItem(COST_COMPARISON_PREFS_KEY);
    if (!raw) return { ...EMPTY_PREFS };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY_PREFS };
    const record = parsed as { window?: unknown; agent?: unknown };
    return {
      window: isTimeWindow(record.window) ? record.window : null,
      agent: isAgentFilter(record.agent) ? record.agent : null,
    };
  } catch {
    return { ...EMPTY_PREFS };
  }
}

/**
 * Persist the Cost Comparison preferences (best effort). Returns an `Error`
 * when storage is unavailable or the write throws (e.g. quota), otherwise
 * `null`. Search is never written.
 */
export function saveCostComparisonPrefs(
  prefs: CostComparisonPrefs,
  storage: WriteStorage | null = getStorage(),
): Error | null {
  if (!storage) return new Error('localStorage unavailable');
  try {
    storage.setItem(
      COST_COMPARISON_PREFS_KEY,
      JSON.stringify({ window: prefs.window, agent: prefs.agent }),
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
