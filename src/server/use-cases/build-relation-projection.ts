import type { AgentState } from '../../core/monitor.js';
import type { AnomalySeverity } from '../../shared/contracts/anomalies.js';
import type { TaskRelation, TaskRelationRollup } from '../../shared/contracts/task-relations.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';

const SEVERITY_ORDER: Record<AnomalySeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

interface RelationStoreLike {
  listRelations(filter?: {
    sourceTaskId?: string;
    targetTaskId?: string;
    taskId?: string;
  }): TaskRelation[];
}

export interface BuildRelationProjectionResult {
  /** Active relations only, in store insertion order. */
  taskRelations: TaskRelation[];
  /** Per-task rollup keyed by `taskId` — only parents with ≥1 active child are present. */
  rollupsByParentTaskId: Map<string, TaskRelationRollup>;
}

/**
 * Project the relation graph into a snapshot-friendly shape. Pure: takes a
 * `listRelations()`-capable store and the live agent list, returns the flat
 * array (filtered to `lifecycle === 'active'`) and per-parent rollups derived
 * by joining `spawned_by` edges with each child's live state.
 *
 * Does NOT mutate `parentTaskId` or any persisted agent state — the rollup
 * is purely derived at projection time so inferred edges can influence the
 * dashboard without ever touching the deterministic parent pointer (#599
 * contract).
 *
 * A child appears in exactly one of `running` / `completed` / `blocked`:
 *   - `blocked` if it has an active anomaly or `turnState === 'blocked'`
 *   - `completed` if its `taskStatus` is terminal (completed/cancelled/terminated)
 *   - `running` otherwise (in-progress, pending, no agent yet, etc.)
 *
 * The `mostUrgentChildFinding` is the highest-severity active anomaly across
 * all children, ranked with `SEVERITY_ORDER` (critical < warning < info).
 */
export function buildRelationProjection(
  taskStore: RelationStoreLike,
  agents: readonly AgentState[],
): BuildRelationProjectionResult {
  // Defensive: partial test mocks may pass a store object that lacks
  // listRelations. In that case treat it the same as "no relations" rather
  // than crashing the snapshot broadcast.
  if (typeof taskStore.listRelations !== 'function') {
    return { taskRelations: [], rollupsByParentTaskId: new Map() };
  }
  const activeRelations = taskStore
    .listRelations()
    .filter((rel) => rel.lifecycle === 'active');

  // Index agents by taskId so we can join children -> live state without N²
  // scans. When multiple agents share a taskId (Ralph iterations) prefer the
  // one with an active anomaly so the rollup surfaces it.
  const agentsByTaskId = new Map<string, AgentState>();
  for (const agent of agents) {
    if (!agent.taskId) continue;
    const prior = agentsByTaskId.get(agent.taskId);
    if (!prior || (!prior.anomaly && agent.anomaly)) {
      agentsByTaskId.set(agent.taskId, agent);
    }
  }

  // Group children by parent through the `spawned_by` edges. The child is the
  // source, the parent is the target — see the contract in task-relations.ts.
  const childrenByParent = new Map<string, Set<string>>();
  for (const rel of activeRelations) {
    if (rel.type !== 'spawned_by') continue;
    const parentId = rel.targetTaskId;
    const childId = rel.sourceTaskId;
    let set = childrenByParent.get(parentId);
    if (!set) {
      set = new Set();
      childrenByParent.set(parentId, set);
    }
    set.add(childId);
  }

  const rollupsByParentTaskId = new Map<string, TaskRelationRollup>();
  for (const [parentTaskId, childIds] of childrenByParent) {
    if (childIds.size === 0) continue;
    let running = 0;
    let completed = 0;
    let blocked = 0;
    let mostUrgent: TaskRelationRollup['mostUrgentChildFinding'];

    for (const childTaskId of childIds) {
      const childAgent = agentsByTaskId.get(childTaskId);
      const childBucket = bucketForChild(childAgent);
      if (childBucket === 'blocked') blocked += 1;
      else if (childBucket === 'completed') completed += 1;
      else running += 1;

      const anomaly = childAgent?.anomaly;
      if (!anomaly) continue;
      if (!mostUrgent || SEVERITY_ORDER[anomaly.severity] < SEVERITY_ORDER[mostUrgent.severity]) {
        mostUrgent = {
          childTaskId,
          ...(childAgent?.agentId ? { childAgentId: childAgent.agentId } : {}),
          severity: anomaly.severity,
          anomalyType: anomaly.type,
          explanation: anomaly.explanation,
        };
      }
    }

    const rollup: TaskRelationRollup = {
      childCount: childIds.size,
      running,
      completed,
      blocked,
      ...(mostUrgent ? { mostUrgentChildFinding: mostUrgent } : {}),
    };
    rollupsByParentTaskId.set(parentTaskId, rollup);
  }

  return { taskRelations: activeRelations, rollupsByParentTaskId };
}

type ChildBucket = 'running' | 'completed' | 'blocked';

function bucketForChild(agent: AgentState | undefined): ChildBucket {
  if (!agent) return 'running';
  if (agent.anomaly) return 'blocked';
  if (agent.turnState === 'blocked') return 'blocked';
  if (agent.taskStatus && isTerminalStatus(agent.taskStatus)) return 'completed';
  return 'running';
}

/**
 * Compute the parent's effective attention severity given its own anomaly
 * and the most-urgent child finding from its rollup. Returns the more severe
 * of the two when both are present, the available one when only one is
 * present, or undefined when neither.
 *
 * Used by the snapshot builder to populate `AgentState.effectiveAttentionSeverity`
 * — a derived field that the frontend's attention ranking uses to surface a
 * parent whose child has urgent state. The parent's persisted anomaly is
 * never mutated.
 */
export function deriveEffectiveAttentionSeverity(
  ownSeverity: AnomalySeverity | undefined,
  rollup: TaskRelationRollup | undefined,
): AnomalySeverity | undefined {
  const childSeverity = rollup?.mostUrgentChildFinding?.severity;
  if (ownSeverity && childSeverity) {
    return SEVERITY_ORDER[childSeverity] < SEVERITY_ORDER[ownSeverity]
      ? childSeverity
      : ownSeverity;
  }
  return ownSeverity ?? childSeverity;
}
