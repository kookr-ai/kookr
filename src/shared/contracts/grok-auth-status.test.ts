import { describe, expect, it } from 'vitest';
import {
  grokAuthAffectsSelection,
  isGrokAuthStatus,
  parseGrokAuthStatusResponse,
  shouldDisableLaunchForGrokAuth,
  shouldShowGrokAuthBanner,
  type GrokAuthStatusResponse,
} from './grok-auth-status.js';

const ALL = ['claude-code', 'codex-cli', 'grok-build'] as const;

function sample(overrides: Partial<GrokAuthStatusResponse> = {}): GrokAuthStatusResponse {
  return {
    status: 'expired',
    loginCommand: 'grok login --device-code',
    message: 'Grok authentication expired. Run `grok login --device-code`.',
    launchWouldRefuse: true,
    roundRobinIndex: 2,
    ...overrides,
  };
}

describe('parseGrokAuthStatusResponse', () => {
  it('accepts the public status shape', () => {
    expect(parseGrokAuthStatusResponse(sample())).toEqual(sample());
  });

  it('rejects missing login command and secret-shaped extras do not leak through', () => {
    expect(parseGrokAuthStatusResponse({ ...sample(), loginCommand: 'echo hi' })).toBeNull();
    const parsed = parseGrokAuthStatusResponse({
      ...sample(),
      access_token: 'secret-token',
      refresh_token: 'secret-refresh',
    });
    expect(parsed).toEqual(sample());
    expect(parsed).not.toHaveProperty('access_token');
    expect(parsed).not.toHaveProperty('refresh_token');
  });

  it('rejects non-integer cursors and unknown statuses', () => {
    expect(parseGrokAuthStatusResponse({ ...sample(), roundRobinIndex: 1.5 })).toBeNull();
    expect(parseGrokAuthStatusResponse({ ...sample(), status: 'revoked' })).toBeNull();
    expect(isGrokAuthStatus('ok')).toBe(true);
    expect(isGrokAuthStatus('revoked')).toBe(false);
  });
});

describe('Launch-dialog Grok auth helpers', () => {
  it('shows a banner for grok-build when status is expired, not when ok', () => {
    expect(shouldShowGrokAuthBanner('grok-build', 'expired', ALL, 0)).toBe(true);
    expect(shouldShowGrokAuthBanner('grok-build', 'ok', ALL, 0)).toBe(false);
    expect(shouldShowGrokAuthBanner('claude-code', 'expired', ALL, 2)).toBe(false);
  });

  it('shows a banner for round-robin only when Grok is next', () => {
    expect(shouldShowGrokAuthBanner('round-robin', 'missing', ALL, 2)).toBe(true);
    expect(shouldShowGrokAuthBanner('round-robin', 'missing', ALL, 0)).toBe(false);
    expect(shouldShowGrokAuthBanner('round-robin', 'invalid', ['claude-code', 'codex-cli'], 2)).toBe(false);
  });

  it('disables Launch only when the server would refuse a Grok-bound selection', () => {
    expect(shouldDisableLaunchForGrokAuth('grok-build', true, ALL, 0)).toBe(true);
    expect(shouldDisableLaunchForGrokAuth('grok-build', false, ALL, 0)).toBe(false);
    expect(shouldDisableLaunchForGrokAuth('claude-code', true, ALL, 2)).toBe(false);
    expect(shouldDisableLaunchForGrokAuth('round-robin', true, ALL, 2)).toBe(true);
    expect(shouldDisableLaunchForGrokAuth('round-robin', true, ALL, 0)).toBe(false);
  });

  it('treats a direct grok-build pick as affected regardless of rotation', () => {
    expect(grokAuthAffectsSelection('grok-build', ['claude-code'], 0)).toBe(true);
  });
});
