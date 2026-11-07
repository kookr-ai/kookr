import { describe, expect, it } from 'vitest';
import { isModelTier, resolveModelTier } from './model-tier.js';

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

  it('throws for the identity-only hermes-fleet type — defense-in-depth (jeanibarz/hermes-fleet#15)', () => {
    // hermes-fleet has no Kookr-resolvable model (locked in its own harness) and
    // is never launched. Launch/relaunch boundaries gate it out first via
    // isIdentityOnlyAgentType; this throw is the exhaustive-switch backstop if a
    // new caller forgets to gate — so it must stay a loud throw, not a bogus model.
    expect(() => resolveModelTier('hermes-fleet', 'small')).toThrow(/no Kookr-resolvable model tier/);
  });

});
