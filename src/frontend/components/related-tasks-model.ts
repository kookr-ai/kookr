import type { AgentState, TaskRelation, TaskRelationType } from '../../shared/protocol.js';
import { HIGH_CONFIDENCE_RELATION_THRESHOLD } from '../../shared/protocol.js';

/**
 * Relation-display groups in the "Related tasks" detail section (#601 UX).
 * Children, parent, successors, dependencies, and same-chain each render as
 * their own collapsible group.
 */
export type RelatedTaskGroupKey =
  | 'children'
  | 'parent'
  | 'successors'
  | 'dependencies'
  | 'sameChain'
  | 'other';

export interface RelatedTaskEntry {
  /** The other task in this relation — the task we'd navigate to if the user clicks. */
  otherTaskId: string;
  /** True when the focused task is the source of the edge. Affects label phrasing. */
  outgoing: boolean;
  relation: TaskRelation;
  /** True when the edge is below the high-confidence threshold or came from inference. */
  inferred: boolean;
}

export interface RelatedTaskGroup {
  key: RelatedTaskGroupKey;
  label: string;
  entries: RelatedTaskEntry[];
}

interface BuildGroupsOptions {
  taskId: string;
  relations: readonly TaskRelation[];
  hideCompletedDescendants?: boolean;
  /** Map of taskId -> task status (used by the hide-completed filter). */
  taskStatusByTaskId?: ReadonlyMap<string, AgentState['taskStatus']>;
}

const TYPE_TO_OUTGOING_GROUP: Record<TaskRelationType, RelatedTaskGroupKey> = {
  spawned_by: 'parent',
  successor_of: 'parent',
  supervises: 'children',
  same_chain: 'sameChain',
  depends_on: 'dependencies',
  blocks: 'dependencies',
  related_to: 'other',
};

const TYPE_TO_INCOMING_GROUP: Record<TaskRelationType, RelatedTaskGroupKey> = {
  spawned_by: 'children',
  successor_of: 'successors',
  supervises: 'parent',
  same_chain: 'sameChain',
  depends_on: 'dependencies',
  blocks: 'dependencies',
  related_to: 'other',
};

const GROUP_LABELS: Record<RelatedTaskGroupKey, string> = {
  children: 'Children',
  parent: 'Parent',
  successors: 'Successors',
  dependencies: 'Dependencies',
  sameChain: 'Same chain',
  other: 'Other relations',
};

/** Stable display order: parent first, then children, then successors, etc. */
const GROUP_DISPLAY_ORDER: RelatedTaskGroupKey[] = [
  'parent',
  'children',
  'successors',
  'dependencies',
  'sameChain',
  'other',
];

/**
 * Whether a relation should render as visually distinct ("inferred") in the UI.
 * Anything below the high-confidence threshold OR sourced from llm-inference
 * gets the inferred treatment. Deterministic API/kookr-spawn captures stay
 * solid.
 */
export function isInferredRelation(relation: TaskRelation): boolean {
  if (relation.source === 'llm-inference') return true;
  return relation.confidence < HIGH_CONFIDENCE_RELATION_THRESHOLD;
}

/**
 * Build the per-group entries for the "Related tasks" section of a task.
 *
 * - Filters to `lifecycle === 'active'` to skip superseded/rejected.
 * - Each relation contributes at most one entry per side. When both sides of
 *   the edge are the focused task (self-loop) we drop it.
 * - With `hideCompletedDescendants`, child entries whose other task is in a
 *   terminal status are hidden.
 *
 * The relation `id` is used to dedupe — the wire array may contain the same
 * record echoed by both an inbound and outbound rebuild during reconnect.
 */
export function buildRelatedTaskGroups(opts: BuildGroupsOptions): RelatedTaskGroup[] {
  const entries: Record<RelatedTaskGroupKey, RelatedTaskEntry[]> = {
    children: [],
    parent: [],
    successors: [],
    dependencies: [],
    sameChain: [],
    other: [],
  };

  const seen = new Set<string>();
  for (const relation of opts.relations) {
    if (relation.lifecycle !== 'active') continue;
    if (seen.has(relation.id)) continue;
    seen.add(relation.id);

    const isOutgoing = relation.sourceTaskId === opts.taskId;
    const isIncoming = relation.targetTaskId === opts.taskId;
    if (!isOutgoing && !isIncoming) continue;

    if (isOutgoing && relation.targetTaskId !== opts.taskId) {
      const groupKey = TYPE_TO_OUTGOING_GROUP[relation.type];
      entries[groupKey].push({
        otherTaskId: relation.targetTaskId,
        outgoing: true,
        relation,
        inferred: isInferredRelation(relation),
      });
    }
    if (isIncoming && relation.sourceTaskId !== opts.taskId) {
      const groupKey = TYPE_TO_INCOMING_GROUP[relation.type];
      entries[groupKey].push({
        otherTaskId: relation.sourceTaskId,
        outgoing: false,
        relation,
        inferred: isInferredRelation(relation),
      });
    }
  }

  if (opts.hideCompletedDescendants) {
    const status = opts.taskStatusByTaskId;
    const isTerminal = (taskId: string): boolean => {
      const s = status?.get(taskId);
      return s === 'completed' || s === 'cancelled' || s === 'terminated';
    };
    entries.children = entries.children.filter((entry) => !isTerminal(entry.otherTaskId));
    entries.successors = entries.successors.filter((entry) => !isTerminal(entry.otherTaskId));
  }

  return GROUP_DISPLAY_ORDER
    .map((key) => ({ key, label: GROUP_LABELS[key], entries: entries[key] }))
    .filter((group) => group.entries.length > 0);
}

/**
 * Compute the chain (transitive `same_chain` + `spawned_by` ancestry) for a
 * task. Returns the set of task IDs reachable through `same_chain` edges in
 * either direction plus the deterministic parent chain via `spawned_by`. Used
 * to implement the "show chain" filter — when ON, only chain members appear
 * in the dashboard task list.
 *
 * Pure traversal; no I/O. The visited set caps work even when the relation
 * graph has cycles (which it shouldn't, but the LLM inference path can write
 * any edge).
 */
export function computeChainMembership(
  rootTaskId: string,
  relations: readonly TaskRelation[],
): Set<string> {
  const adjacency = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string): void => {
    if (a === b) return;
    let neighbors = adjacency.get(a);
    if (!neighbors) {
      neighbors = new Set();
      adjacency.set(a, neighbors);
    }
    neighbors.add(b);
  };

  for (const relation of relations) {
    if (relation.lifecycle !== 'active') continue;
    if (relation.type !== 'same_chain' && relation.type !== 'spawned_by') continue;
    addEdge(relation.sourceTaskId, relation.targetTaskId);
    addEdge(relation.targetTaskId, relation.sourceTaskId);
  }

  const visited = new Set<string>([rootTaskId]);
  const queue: string[] = [rootTaskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adjacency.get(current);
    if (!neighbors) continue;
    for (const next of neighbors) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return visited;
}

/**
 * Direct descendants of `rootTaskId` via `spawned_by` and `successor_of`
 * (transitive). Used by the "show children" filter. Excludes the root itself.
 */
export function computeDescendants(
  rootTaskId: string,
  relations: readonly TaskRelation[],
): Set<string> {
  const childrenByParent = new Map<string, Set<string>>();
  for (const relation of relations) {
    if (relation.lifecycle !== 'active') continue;
    if (relation.type !== 'spawned_by' && relation.type !== 'successor_of') continue;
    let kids = childrenByParent.get(relation.targetTaskId);
    if (!kids) {
      kids = new Set();
      childrenByParent.set(relation.targetTaskId, kids);
    }
    kids.add(relation.sourceTaskId);
  }

  const descendants = new Set<string>();
  const queue: string[] = [rootTaskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const kids = childrenByParent.get(current);
    if (!kids) continue;
    for (const child of kids) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      queue.push(child);
    }
  }
  return descendants;
}
