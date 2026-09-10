import { useCallback, useState } from 'react';
import type { AgentState } from '../shared/protocol.js';

/**
 * Persisted free-text query the operator typed into the findings-rail name
 * search box.
 *
 * An empty (or whitespace-only) query means "show every finding" — the rail is
 * a triage list, so a blank search must never hide the work. Stored as a plain
 * string under one localStorage key, fail-soft like the type filter: a missing
 * value or a private-mode storage miss falls back to show-all.
 */
export const FINDING_NAME_FILTER_KEY = 'kookr:findingsPanel.nameFilter';

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem' | 'removeItem'>;

function getStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/**
 * The human-facing name of a finding — the same string the rail renders on the
 * card (custom task name, falling back to the agent id). Filtering matches this
 * so "what you see is what you search".
 */
export function findingDisplayName(agent: AgentState): string {
  return agent.taskName ?? agent.agentId;
}

/**
 * Keep findings whose display name contains `query` (case-insensitive
 * substring). An empty or whitespace-only query returns the list unchanged.
 */
export function filterFindingsByName(
  findings: readonly AgentState[],
  query: string,
): AgentState[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return findings as AgentState[];
  return findings.filter((agent) =>
    findingDisplayName(agent).toLowerCase().includes(needle),
  );
}

export function loadFindingNameFilter(storage: ReadStorage | null = getStorage()): string {
  if (!storage) return '';
  try {
    return storage.getItem(FINDING_NAME_FILTER_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveFindingNameFilter(
  query: string,
  storage: WriteStorage | null = getStorage(),
): void {
  if (!storage) return;
  try {
    if (query.trim().length === 0) {
      storage.removeItem(FINDING_NAME_FILTER_KEY);
      return;
    }
    storage.setItem(FINDING_NAME_FILTER_KEY, query);
  } catch {
    // localStorage may be unavailable (private mode, quota); preference is best-effort.
  }
}

/** localStorage-backed free-text name filter for the findings rail. */
export function useFindingNameFilter(): [string, (query: string) => void] {
  const [query, setQuery] = useState<string>(() => loadFindingNameFilter());
  const update = useCallback((next: string) => {
    setQuery(next);
    saveFindingNameFilter(next);
  }, []);
  return [query, update];
}
