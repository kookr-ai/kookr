/**
 * Pure matching/ranking helpers for the command palette (top-bar redesign).
 *
 * The palette fuses the old "overflow menu" (browse) and a search box (filter)
 * into one surface: with an empty query it renders the full categorised action
 * list; once the user types, both actions and tasks are filtered and ranked by
 * {@link scoreMatch}. Keeping the ranking pure makes it unit-testable without a
 * DOM.
 */

/** A section bucket for browse mode. `task` actions float to the top. */
export type CommandSection = 'task' | 'view' | 'tools' | 'session';

export interface CommandAction {
  id: string;
  label: string;
  section: CommandSection;
  /** Extra terms that should match this action even if absent from the label. */
  keywords?: string[];
  /** Display-only shortcut hint (e.g. "⌥T", "?"). Not bound here. */
  shortcut?: string;
  /** Small trailing badge — e.g. an attention dot or a finding count. */
  badge?: { text: string; tone: 'attention' | 'teal' };
  run: () => void;
}

export interface CommandTaskItem {
  taskId: string;
  /** Agent to select when chosen. */
  agentId: string;
  label: string;
  status?: string;
  /** Project label, shown as a dim suffix. */
  projectLabel?: string;
}

export const COMMAND_SECTION_LABELS: Record<CommandSection, string> = {
  task: 'This task',
  view: 'View',
  tools: 'Tools',
  session: 'Session',
};

/** Stable browse-mode order: task-scoped actions first. */
export const COMMAND_SECTION_ORDER: CommandSection[] = ['task', 'view', 'tools', 'session'];

/**
 * Score a query against a set of candidate strings. Lower is better; `null`
 * means "no match". An exact match beats a prefix match beats an interior
 * substring, and earlier matches beat later ones. Whitespace-only / empty
 * queries score 0 (everything matches, order preserved by the caller).
 */
export function scoreMatch(candidates: readonly string[], query: string): number | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  let best: number | null = null;
  for (const candidate of candidates) {
    const c = candidate.toLowerCase();
    const idx = c.indexOf(q);
    if (idx === -1) continue;
    let score = idx;
    if (c === q) score -= 1000;
    else if (idx === 0) score -= 100;
    if (best === null || score < best) best = score;
  }
  return best;
}

function rank<T>(items: readonly T[], query: string, candidates: (item: T) => string[]): T[] {
  const scored: { item: T; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const score = scoreMatch(candidates(item), query);
    if (score === null) return;
    scored.push({ item, score, order });
  });
  scored.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.order - b.order));
  return scored.map((entry) => entry.item);
}

/** Filter + rank actions for the current query. Empty query keeps source order. */
export function filterActions(actions: readonly CommandAction[], query: string): CommandAction[] {
  return rank(actions, query, (action) => [action.label, ...(action.keywords ?? [])]);
}

/** Filter + rank tasks for the current query. Empty query yields []: tasks only show while searching. */
export function filterTasks(tasks: readonly CommandTaskItem[], query: string): CommandTaskItem[] {
  if (query.trim().length === 0) return [];
  return rank(tasks, query, (task) => [task.label, task.projectLabel ?? '']);
}

/** Group ranked actions into browse-mode sections, preserving rank order within each. */
export function groupActionsBySection(
  actions: readonly CommandAction[],
): { section: CommandSection; label: string; actions: CommandAction[] }[] {
  return COMMAND_SECTION_ORDER.map((section) => ({
    section,
    label: COMMAND_SECTION_LABELS[section],
    actions: actions.filter((action) => action.section === section),
  })).filter((group) => group.actions.length > 0);
}
