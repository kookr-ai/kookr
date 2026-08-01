// --- Snapshot → coalesced delta builder (issue #1754, Stage 2) ---
//
// Pure helpers that turn a full enriched SnapshotMessage into a smaller
// DeltaMessage relative to the previous fan-out baseline. Used by
// `createRealtimeServices.broadcastToAll` when `KOOKR_WS_DELTA` is on (default)
// and a stream sequencer is wired. Connect / resync / needsSnapshot re-base
// keep sending full snapshots; this module only produces the steady-state
// hot-path frame.

import type { AgentState } from '../shared/contracts/agent-state.js';
import type { DeltaMessage, SnapshotMessage } from '../shared/contracts/messages.js';
import type { TaskRelation } from '../shared/contracts/task-relations.js';

/** Stable map key matching the client store and the wire `removed[]` contract. */
export function agentStreamKey(agent: Pick<AgentState, 'agentId' | 'taskId'>): string {
  return `${agent.agentId}:${agent.taskId ?? ''}`;
}

/** Default: delta emission ON. Kill-switch via `KOOKR_WS_DELTA=0|false|off|no`. */
export const DEFAULT_WS_DELTA_ENABLED = true;

export function readWsDeltaEnabledFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.KOOKR_WS_DELTA;
  if (raw == null || raw.trim() === '') return DEFAULT_WS_DELTA_ENABLED;
  const normalized = raw.trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  return DEFAULT_WS_DELTA_ENABLED;
}

/**
 * Snapshot fields that ride on the delta as a shallow `aggregates` patch.
 * Matches {@link DeltaMessage}'s aggregates Pick exactly.
 */
export type DeltaAggregateSnapshot = Pick<
  SnapshotMessage,
  | 'totalSpendUsd'
  | 'maxActiveTasks'
  | 'drainStatus'
  | 'coordinator'
  | 'achievements'
  | 'achievementCounters'
  | 'achievementStreak'
  | 'bypassAllPermissions'
>;

const AGGREGATE_KEYS = [
  'totalSpendUsd',
  'maxActiveTasks',
  'drainStatus',
  'coordinator',
  'achievements',
  'achievementCounters',
  'achievementStreak',
  'bypassAllPermissions',
] as const satisfies ReadonlyArray<keyof DeltaAggregateSnapshot>;

export interface AgentDelta {
  upserts: AgentState[];
  removed: string[];
}

/**
 * Diff previous projected agents against current. Equality is JSON-deep so any
 * field change (events window, anomaly, turnState, …) produces an upsert. Keys
 * present only in `previous` become `removed` entries (`"agentId:taskId"`).
 */
export function diffProjectedAgents(
  previous: readonly AgentState[],
  current: readonly AgentState[],
): AgentDelta {
  const prevByKey = new Map<string, string>();
  for (const agent of previous) {
    prevByKey.set(agentStreamKey(agent), JSON.stringify(agent));
  }

  const upserts: AgentState[] = [];
  const seen = new Set<string>();
  for (const agent of current) {
    const key = agentStreamKey(agent);
    seen.add(key);
    const prevJson = prevByKey.get(key);
    if (prevJson === undefined || prevJson !== JSON.stringify(agent)) {
      upserts.push(agent);
    }
  }

  const removed: string[] = [];
  for (const key of prevByKey.keys()) {
    if (!seen.has(key)) removed.push(key);
  }

  return { upserts, removed };
}

function relationsEqual(
  a: readonly TaskRelation[] | undefined,
  b: readonly TaskRelation[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Build the shallow aggregates patch: only keys whose JSON value changed
 * (or appeared/disappeared) relative to `previous`.
 */
export function diffAggregates(
  previous: SnapshotMessage,
  current: SnapshotMessage,
): DeltaMessage['aggregates'] | undefined {
  const patch: NonNullable<DeltaMessage['aggregates']> = {};
  let any = false;
  for (const key of AGGREGATE_KEYS) {
    const prevVal = previous[key];
    const curVal = current[key];
    if (prevVal === curVal) continue;
    if (JSON.stringify(prevVal) === JSON.stringify(curVal)) continue;
    // Assign only defined values so the client shallow-merge does not clear
    // sticky fields that a sparse snapshot simply omitted.
    if (curVal !== undefined) {
      (patch as Record<string, unknown>)[key] = curVal;
      any = true;
    }
  }
  return any ? patch : undefined;
}

export interface BuildDeltaResult {
  /** Always produced when previous/current carry (epoch, seq). */
  delta: DeltaMessage;
  /** True when the delta carries no agent/relation/aggregate payload (dense-seq keep-alive). */
  empty: boolean;
}

/**
 * Build a {@link DeltaMessage} from the previous fan-out baseline and the
 * newly-enriched snapshot for this flush. Requires `current.epoch`/`current.seq`
 * (the sequencer stamps them before this is called). Never mutates inputs.
 */
export function buildDeltaFromSnapshots(
  previous: SnapshotMessage,
  current: SnapshotMessage,
): BuildDeltaResult {
  if (current.epoch === undefined || current.seq === undefined) {
    throw new Error('buildDeltaFromSnapshots requires current.epoch and current.seq');
  }

  const agents = diffProjectedAgents(previous.agents, current.agents);
  const taskRelations = relationsEqual(previous.taskRelations, current.taskRelations)
    ? undefined
    : (current.taskRelations ?? []);
  const aggregates = diffAggregates(previous, current);

  const hasAgents = agents.upserts.length > 0 || agents.removed.length > 0;
  const empty = !hasAgents && taskRelations === undefined && aggregates === undefined;

  const delta: DeltaMessage = {
    type: 'delta',
    epoch: current.epoch,
    seq: current.seq,
    ...(hasAgents ? { agents } : {}),
    ...(taskRelations !== undefined ? { taskRelations } : {}),
    ...(aggregates !== undefined ? { aggregates } : {}),
  };

  return { delta, empty };
}

/**
 * Scope a fleet-level delta down to a `projects` viewer. Upserts keep only
 * in-scope agents; removals keep only keys that were in-scope in the previous
 * baseline (we need that prior projection to know projectId). Aggregates are
 * scrubbed (default-deny whole-world scalars). Relations, when present, keep
 * only edges whose endpoints are both among the in-scope agent set after the
 * upsert filter against the previous baseline union.
 *
 * Returns a (possibly empty) keep-alive so dense-seq gap detection still works.
 */
export function scopeDeltaForProjects(
  delta: DeltaMessage,
  previousAgents: readonly AgentState[],
  projectIds: readonly string[],
): DeltaMessage {
  const allowed = new Set(projectIds);
  const prevByKey = new Map(previousAgents.map((a) => [agentStreamKey(a), a]));

  const upserts = (delta.agents?.upserts ?? []).filter(
    (a) => a.projectId !== undefined && allowed.has(a.projectId),
  );
  const removed = (delta.agents?.removed ?? []).filter((key) => {
    const prev = prevByKey.get(key);
    return prev?.projectId !== undefined && allowed.has(prev.projectId);
  });

  // In-scope task ids after applying the delta to the previous in-scope set —
  // used to filter relation edges without leaking out-of-scope endpoints.
  const inScopeTaskIds = new Set<string>();
  for (const agent of previousAgents) {
    if (agent.projectId !== undefined && allowed.has(agent.projectId) && agent.taskId) {
      inScopeTaskIds.add(agent.taskId);
    }
  }
  for (const key of removed) {
    const prev = prevByKey.get(key);
    if (prev?.taskId) inScopeTaskIds.delete(prev.taskId);
  }
  for (const agent of upserts) {
    if (agent.taskId) inScopeTaskIds.add(agent.taskId);
  }

  const taskRelations = delta.taskRelations
    ? delta.taskRelations.filter(
      (rel) => inScopeTaskIds.has(rel.sourceTaskId) && inScopeTaskIds.has(rel.targetTaskId),
    )
    : undefined;

  const hasAgents = upserts.length > 0 || removed.length > 0;
  // Drop aggregates entirely for projects viewers (default-deny whole-world).
  return {
    type: 'delta',
    epoch: delta.epoch,
    seq: delta.seq,
    ...(hasAgents ? { agents: { upserts, removed } } : {}),
    ...(taskRelations !== undefined ? { taskRelations } : {}),
  };
}
