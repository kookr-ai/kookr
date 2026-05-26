/**
 * Typed task-relation graph. Sits alongside the deterministic
 * `parentTaskId` / `childTaskIds` fields on Task without replacing them, so
 * detectors and inference can record richer edges (with confidence and
 * evidence) without ever mutating the deterministic parent pointer.
 *
 * See issue #599 for the motivating model. Inference and UI consumers live in
 * follow-on issues #600 (inference) and #601 (UI).
 */

export type TaskRelationType =
  | 'spawned_by'
  | 'successor_of'
  | 'supervises'
  | 'same_chain'
  | 'depends_on'
  | 'blocks'
  | 'related_to';

export type TaskRelationSource =
  | 'api'
  | 'kookr-spawn'
  | 'hook-log'
  | 'playbook-state'
  | 'transcript'
  | 'llm-inference'
  | 'manual';

export type TaskRelationLifecycle = 'active' | 'superseded' | 'rejected';

/**
 * A piece of evidence supporting a relation. `snippet` is a short, redaction-
 * friendly excerpt (e.g. a log line, a single sentence). `path` is an
 * absolute or repo-relative file location. `observedAt` is the ISO-8601
 * timestamp the evidence was captured. At least one of `snippet` or `path`
 * SHOULD be present, but the contract does not enforce it — empty evidence
 * entries are dropped at validation time.
 */
export interface TaskRelationEvidence {
  snippet?: string;
  path?: string;
  observedAt: string;
}

export interface TaskRelation {
  id: string;
  sourceTaskId: string;
  targetTaskId: string;
  type: TaskRelationType;
  /** Float in [0, 1]. Deterministic captures should be >= 0.9. */
  confidence: number;
  source: TaskRelationSource;
  evidence: TaskRelationEvidence[];
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
  lifecycle: TaskRelationLifecycle;
}

/** Input for upserting a relation. The store assigns `id`, timestamps, and lifecycle defaults. */
export interface TaskRelationInput {
  sourceTaskId: string;
  targetTaskId: string;
  type: TaskRelationType;
  confidence: number;
  source: TaskRelationSource;
  evidence?: TaskRelationEvidence[];
  lifecycle?: TaskRelationLifecycle;
}

/**
 * Threshold above which a relation is considered "high confidence". The
 * deterministic `parentTaskId` -> `spawned_by` capture writes at
 * {@link DETERMINISTIC_RELATION_CONFIDENCE}, well above this gate. Detectors
 * with weaker evidence MUST stay below this line and MUST NOT mutate
 * `parentTaskId` regardless of their confidence.
 */
export const HIGH_CONFIDENCE_RELATION_THRESHOLD = 0.8;

/** Confidence assigned to relations captured deterministically by Kookr itself. */
export const DETERMINISTIC_RELATION_CONFIDENCE = 1;

export const TASK_RELATION_TYPES: readonly TaskRelationType[] = [
  'spawned_by',
  'successor_of',
  'supervises',
  'same_chain',
  'depends_on',
  'blocks',
  'related_to',
];

export const TASK_RELATION_SOURCES: readonly TaskRelationSource[] = [
  'api',
  'kookr-spawn',
  'hook-log',
  'playbook-state',
  'transcript',
  'llm-inference',
  'manual',
];

export const TASK_RELATION_LIFECYCLES: readonly TaskRelationLifecycle[] = [
  'active',
  'superseded',
  'rejected',
];

export function isTaskRelationType(value: unknown): value is TaskRelationType {
  return typeof value === 'string'
    && (TASK_RELATION_TYPES as readonly string[]).includes(value);
}

export function isTaskRelationSource(value: unknown): value is TaskRelationSource {
  return typeof value === 'string'
    && (TASK_RELATION_SOURCES as readonly string[]).includes(value);
}

export function isTaskRelationLifecycle(value: unknown): value is TaskRelationLifecycle {
  return typeof value === 'string'
    && (TASK_RELATION_LIFECYCLES as readonly string[]).includes(value);
}

/**
 * Stable identity key for dedup: (sourceTaskId, targetTaskId, type). The
 * store keeps at most one active record per key — later writes update
 * confidence/evidence/timestamps on the existing record rather than insert
 * a duplicate.
 *
 * JSON-encodes the tuple so the key is collision-free for any string inputs
 * (detectors may seed relations from external state without normalizing ids).
 */
export function taskRelationKey(
  sourceTaskId: string,
  targetTaskId: string,
  type: TaskRelationType,
): string {
  return JSON.stringify([sourceTaskId, targetTaskId, type]);
}

/**
 * Per-parent rollup of child task state, derived at snapshot projection time
 * by joining the deterministic `spawned_by` edges of the relation graph with
 * the live per-agent status/anomaly state. Travels on `AgentState.childRollup`
 * so the dashboard can render the parent rollup pill (#601) without N+1
 * queries.
 *
 * `running` / `completed` / `blocked` are mutually exclusive bucket counts:
 * a child contributes to exactly one based on its `taskStatus` and active
 * anomaly. `childCount` is the total number of distinct children associated
 * by an *active* relation (regardless of bucket).
 *
 * `mostUrgentChildFinding` surfaces the highest-severity active anomaly on
 * any child, ranked using the same `SEVERITY_ORDER` the attention queue
 * uses (`critical < warning < info`). Absent when no child has an active
 * anomaly.
 */
export interface TaskRelationRollup {
  childCount: number;
  running: number;
  completed: number;
  blocked: number;
  mostUrgentChildFinding?: {
    childTaskId: string;
    childAgentId?: string;
    severity: 'info' | 'warning' | 'critical';
    anomalyType: string;
    explanation: string;
  };
}
