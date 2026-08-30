import { isAgentType, type AgentType } from '../shared/contracts/agent-types.js';
import {
  isValidEffortForAgent,
  isValidModelForAgent,
} from './agent-types.js';
import { LAUNCH_DEPENDENCIES, type LaunchDependency } from '../shared/contracts/playbook.js';
import type { TaskLaunchIntent } from '../shared/contracts/task.js';
import {
  isModelTier,
  resolveModelTier,
  type ModelTier,
} from '../shared/contracts/model-tier.js';

/** The persisted shape used to replay a task without guessing its launch settings. */
export const TASK_LAUNCH_INTENT_SCHEMA = 'task-launch-intent.v1' as const;

export interface LaunchIntentPins {
  /** Provider-specific model pin. Kept opaque to the relaunch boundary. */
  model?: string;
  /** Provider-specific effort pin. Kept opaque to the relaunch boundary. */
  effort?: string;
}

export interface LaunchIntentOptions extends LaunchIntentPins {
  modelTier?: ModelTier;
  prompt?: string;
  cwd?: string;
  projectId?: string;
  ralphVerdictEnv?: boolean;
  dependencies?: readonly LaunchDependency[];
  idempotencyKey?: string;
}

export type PersistedLaunchIntentValidation =
  | { ok: true; intent: TaskLaunchIntent }
  | { ok: false; reason: 'missing_launch_intent' | 'malformed_launch_intent'; detail: string };

/** Build an explicit intent, including the unpinned case. */
export function buildTaskLaunchIntent(agentType: AgentType, options: LaunchIntentOptions = {}): TaskLaunchIntent {
  return {
    schemaVersion: TASK_LAUNCH_INTENT_SCHEMA,
    agentType,
    ...(options.modelTier !== undefined ? { modelTier: options.modelTier } : {}),
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    ...(options.ralphVerdictEnv !== undefined ? { ralphVerdictEnv: options.ralphVerdictEnv } : {}),
    ...(options.dependencies !== undefined ? { dependencies: [...new Set(options.dependencies)] } : {}),
    ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
  };
}

/**
 * Validate the persisted contract and its provider-specific pins before any
 * automatic path can pass them directly to an adapter.
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
  if (candidate.modelTier !== undefined && !isModelTier(candidate.modelTier)) {
    return {
      ok: false,
      reason: 'malformed_launch_intent',
      detail: `launch intent has an invalid model tier: ${String(candidate.modelTier)}`,
    };
  }
  if (candidate.modelTier !== undefined) {
    const target = resolveModelTier(candidate.agentType, candidate.modelTier);
    if (candidate.model !== target.model || candidate.effort !== target.effort) {
      return {
        ok: false,
        reason: 'malformed_launch_intent',
        detail: `launch intent pins do not match tier "${candidate.modelTier}" for agent ${candidate.agentType}`,
      };
    }
  } else if (
    (candidate.model !== undefined && !isValidModelForAgent(candidate.agentType, candidate.model))
    || (candidate.effort !== undefined && !isValidEffortForAgent(candidate.agentType, candidate.effort))
  ) {
    return {
      ok: false,
      reason: 'malformed_launch_intent',
      detail: `launch intent contains unsupported pins for agent ${candidate.agentType}`,
    };
  }
  for (const [field, value] of [
    ['prompt', candidate.prompt],
    ['cwd', candidate.cwd],
    ['projectId', candidate.projectId],
    ['idempotencyKey', candidate.idempotencyKey],
  ] as const) {
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      return {
        ok: false,
        reason: 'malformed_launch_intent',
        detail: `launch intent ${field} must be a non-empty string when present`,
      };
    }
  }
  if (candidate.ralphVerdictEnv !== undefined && typeof candidate.ralphVerdictEnv !== 'boolean') {
    return {
      ok: false,
      reason: 'malformed_launch_intent',
      detail: 'launch intent ralphVerdictEnv must be a boolean when present',
    };
  }
  if (
    candidate.dependencies !== undefined
    && (!Array.isArray(candidate.dependencies)
      || candidate.dependencies.some((dependency) => (
        typeof dependency !== 'string'
        || !(LAUNCH_DEPENDENCIES as readonly string[]).includes(dependency)
      )))
  ) {
    return {
      ok: false,
      reason: 'malformed_launch_intent',
      detail: 'launch intent dependencies contain an unsupported dependency',
    };
  }

  return {
    ok: true,
    intent: buildTaskLaunchIntent(candidate.agentType, {
      ...(candidate.prompt !== undefined ? { prompt: candidate.prompt } : {}),
      ...(candidate.cwd !== undefined ? { cwd: candidate.cwd } : {}),
      ...(candidate.projectId !== undefined ? { projectId: candidate.projectId } : {}),
      ...(candidate.modelTier !== undefined ? { modelTier: candidate.modelTier } : {}),
      ...(candidate.model !== undefined ? { model: candidate.model } : {}),
      ...(candidate.effort !== undefined ? { effort: candidate.effort } : {}),
      ...(candidate.ralphVerdictEnv !== undefined ? { ralphVerdictEnv: candidate.ralphVerdictEnv } : {}),
      ...(candidate.dependencies !== undefined ? { dependencies: candidate.dependencies } : {}),
      ...(candidate.idempotencyKey !== undefined ? { idempotencyKey: candidate.idempotencyKey } : {}),
    }),
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
  const dependencies = Array.isArray(raw.dependencies)
    ? [...new Set(raw.dependencies)].sort()
    : raw.dependencies === undefined ? [] : ['malformed', raw.dependencies];
  return JSON.stringify([
    raw.schemaVersion,
    raw.agentType,
    model,
    effort,
    Object.prototype.hasOwnProperty.call(raw, 'modelTier')
      ? ['present', raw.modelTier]
      : ['absent'],
    dependencies,
    raw.ralphVerdictEnv === true,
  ]);
}

/** Compare a persisted intent with the intent requested by a new launch. */
export function sameLaunchIntent(
  intent: TaskLaunchIntent | undefined,
  agentType: AgentType,
  options: LaunchIntentOptions = {},
): boolean {
  if (!intent) return false;
  return launchIntentFingerprint(intent) === launchIntentFingerprint(buildTaskLaunchIntent(agentType, options));
}
