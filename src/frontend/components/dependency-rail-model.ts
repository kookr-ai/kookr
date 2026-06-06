import type { AgentState, TaskRelation, TaskRelationType } from '../../shared/protocol.js';
import { isInferredRelation } from './related-tasks-model.js';

/**
 * Compact "dependency rail" model (top-bar/related-tasks redesign).
 *
 * Replaces the tall "Related tasks" grouped block with a single horizontal
 * line: `upstream → [this task] → downstream`. We only surface true
 * dependency/lineage edges here (blockers, parents, priors on the left;
 * dependents, children, successors on the right). `same_chain` / `related_to`
 * are intentionally excluded — they are siblings, not a flow, and would make
 * the line ambiguous. Pure: no store access, fully unit-testable.
 */

export type RailSide = 'upstream' | 'downstream';

export interface RailNode {
  taskId: string;
  label: string;
  status?: AgentState['taskStatus'];
  inferred: boolean;
  /** Human relation phrase for the tooltip, e.g. "depends on". */
  relationLabel: string;
  /** 0–1; surfaced as a percentage in the tooltip. */
  confidence: number;
}

export interface DependencyRail {
  upstream: RailNode[];
  downstream: RailNode[];
}

interface BuildRailOptions {
  taskId: string;
  relations: readonly TaskRelation[];
  taskLabelByTaskId: ReadonlyMap<string, string>;
  taskStatusByTaskId: ReadonlyMap<string, AgentState['taskStatus']>;
}

/**
 * Which side of the rail an edge places the *other* task on, given the relation
 * type and whether the focused task is the source (`outgoing`). `null` types
 * (same_chain, related_to) are excluded from the rail.
 */
function sideFor(type: TaskRelationType, outgoing: boolean): RailSide | null {
  switch (type) {
    case 'depends_on':
      // this depends_on other → other blocks us (upstream); reverse → downstream.
      return outgoing ? 'upstream' : 'downstream';
    case 'blocks':
      // this blocks other → other waits on us (downstream); reverse → upstream.
      return outgoing ? 'downstream' : 'upstream';
    case 'spawned_by':
      // this spawned_by other → other is parent (upstream); reverse → child.
      return outgoing ? 'upstream' : 'downstream';
    case 'supervises':
      // this supervises other → other is child (downstream); reverse → parent.
      return outgoing ? 'downstream' : 'upstream';
    case 'successor_of':
      // this successor_of other → other ran before us (upstream); reverse → after.
      return outgoing ? 'upstream' : 'downstream';
    case 'same_chain':
    case 'related_to':
      return null;
  }
}

const RELATION_PHRASE: Record<TaskRelationType, string> = {
  depends_on: 'depends on',
  blocks: 'blocks',
  spawned_by: 'spawned by',
  supervises: 'supervises',
  successor_of: 'follows',
  same_chain: 'same chain',
  related_to: 'related to',
};

/** Terminal task statuses render with a "done" dot regardless of which terminal state. */
function isTerminalStatus(status: AgentState['taskStatus'] | undefined): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'terminated';
}

export function buildDependencyRail(opts: BuildRailOptions): DependencyRail {
  // taskId -> best node per side. Dedupe to the highest-confidence edge; a
  // deterministic edge always wins over an inferred one for the same neighbour.
  const bySide: Record<RailSide, Map<string, RailNode>> = {
    upstream: new Map(),
    downstream: new Map(),
  };

  const seen = new Set<string>();
  for (const relation of opts.relations) {
    if (relation.lifecycle !== 'active') continue;
    if (seen.has(relation.id)) continue;
    seen.add(relation.id);

    const isOutgoing = relation.sourceTaskId === opts.taskId;
    const isIncoming = relation.targetTaskId === opts.taskId;

    const consider = (otherTaskId: string, outgoing: boolean): void => {
      if (otherTaskId === opts.taskId) return;
      const side = sideFor(relation.type, outgoing);
      if (!side) return;
      const node: RailNode = {
        taskId: otherTaskId,
        label: opts.taskLabelByTaskId.get(otherTaskId) ?? otherTaskId,
        status: opts.taskStatusByTaskId.get(otherTaskId),
        inferred: isInferredRelation(relation),
        relationLabel: RELATION_PHRASE[relation.type],
        confidence: relation.confidence,
      };
      const existing = bySide[side].get(otherTaskId);
      if (!existing || node.confidence > existing.confidence) {
        bySide[side].set(otherTaskId, node);
      }
    };

    if (isOutgoing) consider(relation.targetTaskId, true);
    if (isIncoming) consider(relation.sourceTaskId, false);
  }

  // A neighbour that landed on both sides (cycle / contradictory edges) stays
  // upstream only — a blocker is the more actionable framing.
  for (const taskId of bySide.upstream.keys()) bySide.downstream.delete(taskId);

  const order = (nodes: RailNode[]): RailNode[] =>
    nodes.sort((a, b) => {
      // Pending/active work first, then by confidence, then label — stable-ish.
      const at = isTerminalStatus(a.status) ? 1 : 0;
      const bt = isTerminalStatus(b.status) ? 1 : 0;
      if (at !== bt) return at - bt;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      return a.label.localeCompare(b.label);
    });

  return {
    upstream: order([...bySide.upstream.values()]),
    downstream: order([...bySide.downstream.values()]),
  };
}
