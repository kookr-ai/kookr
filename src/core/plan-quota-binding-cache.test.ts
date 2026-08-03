import { describe, it, expect } from 'vitest';
import {
  PlanQuotaBindingCache,
  PLAN_QUOTA_UNKNOWN_RESET_COOLDOWN_MS,
} from './plan-quota-binding-cache.js';

describe('PlanQuotaBindingCache', () => {
  it('is unbound until markExhausted is called', () => {
    const cache = new PlanQuotaBindingCache();
    expect(cache.isBound()).toBe(false);
    expect(cache.get()).toBeNull();
  });

  it('binds until resetsAt and clears after that time', () => {
    const cache = new PlanQuotaBindingCache();
    const now = Date.parse('2026-08-03T10:00:00.000Z');
    const resetsAt = '2026-08-03T12:00:00.000Z';
    cache.markExhausted({ maxUtilization: 100, threshold: 90, resetsAt }, now);
    expect(cache.isBound(now)).toBe(true);
    const snap = cache.get(now);
    expect(snap).toMatchObject({
      maxUtilization: 100,
      threshold: 90,
      resetsAt,
      untilMs: Date.parse(resetsAt),
    });
    // Exactly at reset: unbound.
    expect(cache.isBound(Date.parse(resetsAt))).toBe(false);
    expect(cache.get(Date.parse(resetsAt))).toBeNull();
  });

  it('uses the unknown-reset cooldown when resetsAt is missing', () => {
    const cache = new PlanQuotaBindingCache();
    const now = 1_000_000;
    cache.markExhausted({ maxUtilization: 95, threshold: 90, resetsAt: null }, now);
    expect(cache.isBound(now)).toBe(true);
    expect(cache.get(now)?.untilMs).toBe(now + PLAN_QUOTA_UNKNOWN_RESET_COOLDOWN_MS);
    expect(cache.get(now)?.resetsAt).toBeNull();
    expect(cache.isBound(now + PLAN_QUOTA_UNKNOWN_RESET_COOLDOWN_MS)).toBe(false);
  });

  it('treats a past or unparseable resetsAt like a missing one', () => {
    const cache = new PlanQuotaBindingCache();
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    cache.markExhausted(
      { maxUtilization: 99, threshold: 90, resetsAt: '2026-08-03T11:00:00.000Z' },
      now,
    );
    expect(cache.get(now)?.untilMs).toBe(now + PLAN_QUOTA_UNKNOWN_RESET_COOLDOWN_MS);

    cache.clear();
    cache.markExhausted(
      { maxUtilization: 99, threshold: 90, resetsAt: 'not-a-date' },
      now,
    );
    expect(cache.get(now)?.untilMs).toBe(now + PLAN_QUOTA_UNKNOWN_RESET_COOLDOWN_MS);
  });

  it('clear() drops the binding immediately', () => {
    const cache = new PlanQuotaBindingCache();
    cache.markExhausted(
      { maxUtilization: 100, threshold: 90, resetsAt: '2099-01-01T00:00:00.000Z' },
    );
    expect(cache.isBound()).toBe(true);
    cache.clear();
    expect(cache.isBound()).toBe(false);
  });
});
