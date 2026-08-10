import { describe, expect, it, vi } from 'vitest';
import {
  filterLaunchableAgentTypes,
  GrokAuthAvailabilityCache,
} from './grok-auth-availability.js';
import type { GrokAuthPreflightResult } from './grok-auth-preflight.js';

describe('filterLaunchableAgentTypes (issue #2194)', () => {
  const all = ['claude-code', 'codex-cli', 'grok-build'] as const;

  it('leaves the list unchanged when Grok auth is usable', () => {
    expect(filterLaunchableAgentTypes(all, { grokAuthUsable: true })).toEqual([...all]);
  });

  it('leaves the list unchanged when usability is omitted (fail-open)', () => {
    expect(filterLaunchableAgentTypes(all)).toEqual([...all]);
  });

  it('strips grok-build when Grok auth is unusable', () => {
    expect(filterLaunchableAgentTypes(all, { grokAuthUsable: false })).toEqual([
      'claude-code',
      'codex-cli',
    ]);
  });

  it('returns an empty list when only grok-build was registered and auth is unusable', () => {
    expect(filterLaunchableAgentTypes(['grok-build'], { grokAuthUsable: false })).toEqual([]);
  });
});

describe('GrokAuthAvailabilityCache (issue #2194)', () => {
  it('fails open (usable) before the first refresh', () => {
    const cache = new GrokAuthAvailabilityCache({
      resolveAuthPath: () => '/tmp/missing-auth.json',
      inspect: async () => ({ kind: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' }),
    });
    expect(cache.isUsable()).toBe(true);
    expect(cache.isKnownUnusable()).toBe(false);
  });

  it('marks unusable after an expired inspect', async () => {
    const cache = new GrokAuthAvailabilityCache({
      resolveAuthPath: () => '/tmp/auth.json',
      inspect: async () => ({ kind: 'expired', expiresAt: '2026-08-08T13:11:01.000Z' }),
      now: () => 1_000,
    });
    const state = await cache.ensureFresh();
    expect(state.usable).toBe(false);
    if (!state.usable) expect(state.reason).toBe('expired');
    expect(cache.isUsable()).toBe(false);
    expect(cache.isKnownUnusable()).toBe(true);
  });

  it('marks usable after an ok inspect', async () => {
    const cache = new GrokAuthAvailabilityCache({
      resolveAuthPath: () => '/tmp/auth.json',
      inspect: async () =>
        ({
          kind: 'ok',
          credentialCount: 1,
          authMode: 'oidc',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }) satisfies GrokAuthPreflightResult,
      now: () => 1_000,
    });
    await cache.ensureFresh();
    expect(cache.isUsable()).toBe(true);
    expect(cache.isKnownUnusable()).toBe(false);
  });

  it('honors the TTL and does not re-inspect while fresh', async () => {
    let now = 1_000;
    const inspect = vi.fn(async (): Promise<GrokAuthPreflightResult> => ({
      kind: 'expired',
      expiresAt: '2026-08-08T13:11:01.000Z',
    }));
    const cache = new GrokAuthAvailabilityCache({
      resolveAuthPath: () => '/tmp/auth.json',
      inspect,
      ttlMs: 30_000,
      now: () => now,
    });
    await cache.ensureFresh();
    now = 20_000;
    await cache.ensureFresh();
    expect(inspect).toHaveBeenCalledTimes(1);
    now = 40_000;
    await cache.ensureFresh();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('markUnusable forces a negative verdict without disk I/O', () => {
    const inspect = vi.fn();
    const cache = new GrokAuthAvailabilityCache({
      resolveAuthPath: () => '/tmp/auth.json',
      inspect,
      now: () => 5_000,
    });
    cache.markUnusable('expired', 'forced');
    expect(cache.isUsable()).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('fails open when inspect throws (must not couple every fire to a probe crash)', async () => {
    const cache = new GrokAuthAvailabilityCache({
      resolveAuthPath: () => '/tmp/auth.json',
      inspect: async () => {
        throw new Error('disk fault');
      },
      now: () => 1_000,
    });
    const state = await cache.refresh();
    expect(state.usable).toBe(true);
    expect(cache.isUsable()).toBe(true);
  });
});
