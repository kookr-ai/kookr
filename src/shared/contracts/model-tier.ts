import type { AgentType } from './agent-types.js';

/** Provider-neutral model intent for routine, bounded work. */
export const MODEL_TIERS = ['small'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface ResolvedModelTierTarget {
  model: string;
  effort?: string;
}

/**
 * Resolve portable intent only after Kookr has selected a concrete agent.
 * Keep this exhaustive so a future agent cannot inherit another provider's
 * model by accident.
 */
export function resolveModelTier(
  agentType: AgentType,
  tier: ModelTier,
): ResolvedModelTierTarget {
  switch (agentType) {
    case 'claude-code':
      return { model: 'claude-haiku-4-5' };
    case 'codex-cli':
      return { model: 'gpt-5.6-luna', effort: 'high' };
    case 'grok-build':
      return { model: 'grok-4.6' };
    default:
      return assertNever(agentType, tier);
  }
}

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && MODEL_TIERS.includes(value as ModelTier);
}

function assertNever(agentType: never, tier: ModelTier): never {
  throw new Error(`Unhandled model tier target: ${String(agentType)}:${String(tier)}`);
}
