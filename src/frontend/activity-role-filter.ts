import { useCallback, useState } from 'react';
import type { ActivityItem } from '../shared/protocol.js';

/**
 * Exclusive role filter for the activity transcript.
 *
 * All / You / Agent / Tools are radio chips, not a multi-select: the
 * transcript is one conversation, and the operator is choosing which
 * voice to read. Stored as a single string under one localStorage key,
 * fail-soft like other dashboard prefs: a missing, malformed, or
 * private-mode storage miss falls back to All.
 */
export const ACTIVITY_ROLE_FILTER_KEY = 'kookr:activityPanel.roleFilter';

export const ACTIVITY_ROLE_FILTERS = ['all', 'you', 'agent', 'tools'] as const;

export type ActivityRoleFilter = (typeof ACTIVITY_ROLE_FILTERS)[number];

export const ACTIVITY_ROLE_FILTER_LABELS: Record<ActivityRoleFilter, string> = {
  all: 'All',
  you: 'You',
  agent: 'Agent',
  tools: 'Tools',
};

type ActivityItemRole = Exclude<ActivityRoleFilter, 'all'> | 'other';

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

function getStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function isActivityRoleFilter(value: unknown): value is ActivityRoleFilter {
  return ACTIVITY_ROLE_FILTERS.some((filter) => filter === value);
}

/** Map a summarized activity row to the chip that would keep it visible. */
export function activityItemRole(item: ActivityItem): ActivityItemRole {
  switch (item.type) {
    case 'user_message':
    case 'user_input_delivery':
    case 'user_paste_burst':
      return 'you';
    case 'agent_message':
      return 'agent';
    case 'tool_group':
      return 'tools';
    case 'system_notice':
      return 'other';
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

function itemMatchesActivityFilter(
  item: ActivityItem,
  filter: ActivityRoleFilter,
): boolean {
  if (filter === 'all') return true;
  return activityItemRole(item) === filter;
}

export function filterActivityItems(
  items: readonly ActivityItem[],
  filter: ActivityRoleFilter,
): ActivityItem[] {
  if (filter === 'all') return items as ActivityItem[];
  return items.filter((item) => itemMatchesActivityFilter(item, filter));
}

/**
 * Show the "No matching activity" recovery when a non-All chip hid every
 * summarized row. The live "agent is working" row is not a summarized
 * row — it stays visible on every chip — but on Tools it *is* the
 * in-flight tool, so an empty Tools list mid-turn is not an empty filter.
 */
export function shouldShowActivityFilterEmptyState(args: {
  filter: ActivityRoleFilter;
  matchedCount: number;
  isActive: boolean;
}): boolean {
  if (args.filter === 'all') return false;
  if (args.matchedCount > 0) return false;
  if (args.isActive && args.filter === 'tools') return false;
  return true;
}

export function loadActivityRoleFilter(
  storage: ReadStorage | null = getStorage(),
): ActivityRoleFilter {
  if (!storage) return 'all';
  try {
    const raw = storage.getItem(ACTIVITY_ROLE_FILTER_KEY);
    if (!raw) return 'all';
    return isActivityRoleFilter(raw) ? raw : 'all';
  } catch {
    return 'all';
  }
}

export function saveActivityRoleFilter(
  filter: ActivityRoleFilter,
  storage: WriteStorage | null = getStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(ACTIVITY_ROLE_FILTER_KEY, filter);
  } catch {
    // localStorage may be unavailable (private mode, quota); preference is best-effort.
  }
}

/** localStorage-backed exclusive chip for the activity transcript. */
export function useActivityRoleFilter(): [ActivityRoleFilter, (next: ActivityRoleFilter) => void] {
  const [filter, setFilter] = useState<ActivityRoleFilter>(() => loadActivityRoleFilter());
  const select = useCallback((next: ActivityRoleFilter) => {
    setFilter(next);
    saveActivityRoleFilter(next);
  }, []);
  return [filter, select];
}
