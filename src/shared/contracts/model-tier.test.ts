import { describe, expect, it } from 'vitest';
import { isModelTier, isResolvedModelTierTarget, resolveModelTier } from './model-tier.js';

describe('small model tier', () => {
  it('maps every coding agent to its portable small target', () => {
    expect(resolveModelTier('claude-code', 'small')).toEqual({ model: 'claude-haiku-4-5' });
    expect(resolveModelTier('codex-cli', 'small')).toEqual({ model: 'gpt-5.6-luna', effort: 'high' });
    expect(resolveModelTier('grok-build', 'small')).toEqual({ model: 'grok-4.6' });
  });

  it('accepts only the closed tier vocabulary', () => {
    expect(isModelTier('small')).toBe(true);
    expect(isModelTier('standard')).toBe(false);
    expect(isModelTier(undefined)).toBe(false);
  });

  it('recognizes only exact resolved targets', () => {
    expect(isResolvedModelTierTarget('codex-cli', 'gpt-5.6-luna', 'high')).toBe(true);
    expect(isResolvedModelTierTarget('grok-build', 'grok-4.6', undefined)).toBe(true);
    expect(isResolvedModelTierTarget('codex-cli', 'gpt-5.6-luna', 'max')).toBe(false);
    expect(isResolvedModelTierTarget('codex-cli', 'gpt-5.6-sol', 'high')).toBe(false);
  });
});
