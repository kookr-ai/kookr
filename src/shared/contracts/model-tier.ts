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
    case 'hermes-fleet':
      // hermes-fleet is identity-only (jeanibarz/hermes-fleet#15): Kookr never launches it, so it
      // never resolves a tier model. Its reasoning model is locked inside its
      // own bash harness, not selected by Kookr. Defense-in-depth: the launch
      // and relaunch boundaries reject identity-only agent types
      // (`isIdentityOnlyAgentType`) BEFORE tier resolution, so this throw is
      // unreachable through those paths — but failing loud here (rather than
      // inventing a model Kookr cannot launch) keeps the exhaustive switch
      // honest if a new caller forgets to gate. Pinned by a test.
      throw new Error('hermes-fleet has no Kookr-resolvable model tier (model locked by its own harness)');
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
