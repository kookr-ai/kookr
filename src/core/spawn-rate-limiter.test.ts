import { describe, it, expect } from 'vitest';
import { SpawnRateLimiter, spawnBudgetKey } from './spawn-rate-limiter.js';

function makeLimiter(opts: { limit?: number; windowMs?: number } = {}) {
  let nowMs = 1_000_000;
  const limiter = new SpawnRateLimiter({
    getLimit: () => opts.limit ?? 3,
    getWindowMs: () => opts.windowMs ?? 10 * 60_000,
    now: () => nowMs,
  });
  return { limiter, advance: (ms: number) => { nowMs += ms; }, nowMs: () => nowMs };
}

describe('spawnBudgetKey', () => {
  it('is the bare source without an actor', () => {
    expect(spawnBudgetKey('api')).toBe('api');
    expect(spawnBudgetKey('api', undefined)).toBe('api');
    expect(spawnBudgetKey('api', '   ')).toBe('api');
  });

  it('actor-qualifies the key when an actor id is present', () => {
    expect(spawnBudgetKey('api', 'lucy-supervisor')).toBe('api:actor:lucy-supervisor');
    expect(spawnBudgetKey('api', '  lucy  ')).toBe('api:actor:lucy');
  });
});

describe('SpawnRateLimiter', () => {
  it('allows up to the limit and rejects the next attempt', () => {
    const { limiter } = makeLimiter({ limit: 3 });
    expect(limiter.tryAcquire('api').allowed).toBe(true);
    expect(limiter.tryAcquire('api').allowed).toBe(true);
    expect(limiter.tryAcquire('api').allowed).toBe(true);
    const rejected = limiter.tryAcquire('api');
    expect(rejected.allowed).toBe(false);
    expect(rejected.count).toBe(3);
    expect(rejected.limit).toBe(3);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
  });

  it('a rejected attempt does not burn budget', () => {
    const { limiter, advance } = makeLimiter({ limit: 2, windowMs: 60_000 });
    limiter.tryAcquire('api');
    advance(10_000);
    limiter.tryAcquire('api');
    // Hammer rejections — none should extend the window occupancy.
    for (let i = 0; i < 5; i++) expect(limiter.tryAcquire('api').allowed).toBe(false);
    // Oldest entry (t=0) slides out at t=60s → one slot frees.
    advance(51_000); // now at t=61s
    expect(limiter.tryAcquire('api').allowed).toBe(true);
  });

  it('the window slides: entries expire limit-side after windowMs', () => {
    const { limiter, advance } = makeLimiter({ limit: 2, windowMs: 60_000 });
    expect(limiter.tryAcquire('api').allowed).toBe(true); // t=0
    advance(30_000);
    expect(limiter.tryAcquire('api').allowed).toBe(true); // t=30s
    expect(limiter.tryAcquire('api').allowed).toBe(false); // full
    advance(30_001); // t=60.001s — the t=0 entry has slid out
    const verdict = limiter.tryAcquire('api');
    expect(verdict.allowed).toBe(true);
    expect(verdict.count).toBe(1); // only the t=30s entry remained
  });

  it('reports retryAfterMs as the time until the oldest entry slides out', () => {
    const { limiter, advance } = makeLimiter({ limit: 1, windowMs: 60_000 });
    limiter.tryAcquire('api'); // t=0
    advance(15_000);
    const rejected = limiter.tryAcquire('api');
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBe(45_000);
  });

  it('buckets are independent: one source bursting never affects another', () => {
    const { limiter } = makeLimiter({ limit: 1 });
    expect(limiter.tryAcquire('api').allowed).toBe(true);
    expect(limiter.tryAcquire('api').allowed).toBe(false);
    expect(limiter.tryAcquire('cli').allowed).toBe(true);
    expect(limiter.tryAcquire(spawnBudgetKey('api', 'lucy')).allowed).toBe(true);
  });

  it('reads limit and window through the live getters on every attempt', () => {
    let limit = 1;
    const limiter = new SpawnRateLimiter({
      getLimit: () => limit,
      getWindowMs: () => 60_000,
      now: () => 42,
    });
    expect(limiter.tryAcquire('api').allowed).toBe(true);
    expect(limiter.tryAcquire('api').allowed).toBe(false);
    limit = 5; // operator raised the setting — applies immediately
    expect(limiter.tryAcquire('api').allowed).toBe(true);
  });
});
