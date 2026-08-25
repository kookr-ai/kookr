import { isAgentType, type AgentType } from '../shared/contracts/agent-types.js';
import type { TaskLaunchIntent } from '../shared/contracts/task.js';

/** The persisted shape used to replay a task without guessing its launch settings. */
export const TASK_LAUNCH_INTENT_SCHEMA = 'task-launch-intent.v1' as const;

export interface LaunchIntentPins {
  /** Provider-specific model pin. Kept opaque to the relaunch boundary. */
  model?: string;
  /** Provider-specific effort pin. Kept opaque to the relaunch boundary. */
  effort?: string;
}

export type PersistedLaunchIntentValidation =
  | { ok: true; intent: TaskLaunchIntent }
  | { ok: false; reason: 'missing_launch_intent' | 'malformed_launch_intent'; detail: string };

/** Build an explicit intent, including the unpinned case. */
export function buildTaskLaunchIntent(agentType: AgentType, pins: LaunchIntentPins = {}): TaskLaunchIntent {
  return {
    schemaVersion: TASK_LAUNCH_INTENT_SCHEMA,
    agentType,
    ...(pins.model !== undefined ? { model: pins.model } : {}),
    ...(pins.effort !== undefined ? { effort: pins.effort } : {}),
  };
}

/**
 * Validate only the persisted contract. Model and effort are intentionally
 * opaque here: provider-specific validation belongs to the original launch
 * admission path, while this boundary must preserve both pins independently.
 */
export function validatePersistedLaunchIntent(
  task: { agentType: AgentType; launchIntent?: unknown },
): PersistedLaunchIntentValidation {
  const raw = task.launchIntent;
  if (raw === undefined) {
    return {
      ok: false,
      reason: 'missing_launch_intent',
      detail: 'task has no persisted launch intent; automatic relaunch is fail-closed',
    };
  }
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      reason: 'malformed_launch_intent',
      detail: 'persisted launch intent is not an object',
    };
  }

  const candidate = raw as Partial<TaskLaunchIntent>;
  if (candidate.schemaVersion !== TASK_LAUNCH_INTENT_SCHEMA) {
    return {
      ok: false,
      reason: 'malformed_launch_intent',
      detail: `unsupported launch intent schema: ${String(candidate.schemaVersion)}`,
    };
  }
  if (!isAgentType(candidate.agentType)) {
    return {
      ok: false,
      reason: 'malformed_launch_intent',
      detail: `launch intent has an invalid agent type: ${String(candidate.agentType)}`,
    };
  }
  if (candidate.agentType !== task.agentType) {
    return {
      ok: false,
      reason: 'malformed_launch_intent',
      detail: `launch intent agent ${candidate.agentType} does not match task agent ${task.agentType}`,
    };
  }
  if (
    (candidate.model !== undefined && (typeof candidate.model !== 'string' || candidate.model.trim() === ''))
    || (candidate.effort !== undefined && (typeof candidate.effort !== 'string' || candidate.effort.trim() === ''))
  ) {
    return {
      ok: false,
      reason: 'malformed_launch_intent',
      detail: 'launch intent model and effort pins must be non-empty strings when present',
    };
  }

  return {
    ok: true,
    intent: {
      schemaVersion: TASK_LAUNCH_INTENT_SCHEMA,
      agentType: candidate.agentType,
      ...(candidate.model !== undefined ? { model: candidate.model } : {}),
      ...(candidate.effort !== undefined ? { effort: candidate.effort } : {}),
    },
  };
}

/** Convert validated intent into the independent fields expected by adapters/launchTask. */
export function launchIntentPins(intent: TaskLaunchIntent): LaunchIntentPins {
  return {
    ...(intent.model !== undefined ? { model: intent.model } : {}),
    ...(intent.effort !== undefined ? { effort: intent.effort } : {}),
  };
}

/** Stable fingerprint fragment for launch deduplication. */
export function launchIntentFingerprint(intent: unknown): string | undefined {
  if (intent === undefined) return undefined;
  if (intent === null || typeof intent !== 'object' || Array.isArray(intent)) {
    return JSON.stringify(['malformed', intent]);
  }
  const raw = intent as unknown as Record<string, unknown>;
  const model = Object.prototype.hasOwnProperty.call(raw, 'model')
    ? ['present', raw.model]
    : ['absent'];
  const effort = Object.prototype.hasOwnProperty.call(raw, 'effort')
    ? ['present', raw.effort]
    : ['absent'];
  return JSON.stringify([
    raw.schemaVersion,
    raw.agentType,
    model,
    effort,
  ]);
}

/** Compare a persisted intent with the intent requested by a new launch. */
export function sameLaunchIntent(
  intent: TaskLaunchIntent | undefined,
  agentType: AgentType,
  pins: LaunchIntentPins = {},
): boolean {
  if (!intent) return false;
  return launchIntentFingerprint(intent) === launchIntentFingerprint(buildTaskLaunchIntent(agentType, pins));
}
