import { useCallback, useState } from 'react';
import type { AgentState } from '../shared/protocol.js';
import type { AnomalyType } from '../shared/contracts/anomalies.js';

/**
 * Persisted set of findings-rail type chips the operator has turned on.
 *
 * Empty array means "show every finding" — the rail is a triage list, not a
 * search result, so an empty selection must not hide the work. Stored as a
 * JSON string array under one localStorage key, fail-soft like the other
 * findings-panel prefs: a missing, malformed, or private-mode storage miss
 * falls back to show-all.
 */
export const FINDING_TYPE_FILTER_KEY = 'kookr:findingsPanel.typeFilter';

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem' | 'removeItem'>;

function getStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/** Unique anomaly types currently on the rail, in first-seen order. */
export function presentFindingTypes(findings: readonly AgentState[]): AnomalyType[] {
  const seen = new Set<AnomalyType>();
  const types: AnomalyType[] = [];
  for (const agent of findings) {
    const type = agent.anomaly?.type;
    if (!type || seen.has(type)) continue;
    seen.add(type);
    types.push(type);
  }
  return types;
}

/**
 * Types from the stored selection that still exist on the rail.
 *
 * A stored type whose findings have all cleared is ignored so a stale
 * permission filter cannot blank a rail that now only has budget/idle cards.
 * Empty result → treat as show-all.
 */
export function activeFindingTypeFilter(
  selected: readonly string[],
  present: readonly string[],
): string[] {
  if (selected.length === 0) return [];
  const presentSet = new Set(present);
  return selected.filter((type) => presentSet.has(type));
}

/** Keep cards whose type is in the active selection. Empty selection = all. */
export function filterFindingsBySelectedTypes(
  findings: readonly AgentState[],
  selected: readonly string[],
): AgentState[] {
  const present = presentFindingTypes(findings);
  const active = activeFindingTypeFilter(selected, present);
  if (active.length === 0) return findings as AgentState[];
  const activeSet = new Set(active);
  return findings.filter((agent) => {
    const type = agent.anomaly?.type;
    return Boolean(type && activeSet.has(type));
  });
}

export function loadFindingTypeFilter(storage: ReadStorage | null = getStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(FINDING_TYPE_FILTER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
  } catch {
    return [];
  }
}

export function saveFindingTypeFilter(
  types: readonly string[],
  storage: WriteStorage | null = getStorage(),
): void {
  if (!storage) return;
  try {
    if (types.length === 0) {
      storage.removeItem(FINDING_TYPE_FILTER_KEY);
      return;
    }
    storage.setItem(FINDING_TYPE_FILTER_KEY, JSON.stringify([...types]));
  } catch {
    // localStorage may be unavailable (private mode, quota); preference is best-effort.
  }
}

export function toggleFindingTypeSelection(selected: readonly string[], type: string): string[] {
  return selected.includes(type)
    ? selected.filter((entry) => entry !== type)
    : [...selected, type];
}

/** localStorage-backed multi-select for the findings-rail type chips. */
export function useFindingTypeFilter(): [string[], (type: string) => void] {
  const [selected, setSelected] = useState<string[]>(() => loadFindingTypeFilter());
  const toggle = useCallback((type: string) => {
    setSelected((prev) => {
      const next = toggleFindingTypeSelection(prev, type);
      saveFindingTypeFilter(next);
      return next;
    });
  }, []);
  return [selected, toggle];
}
