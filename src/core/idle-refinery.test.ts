import { describe, expect, it } from 'vitest';
import { decideIdleRefinerySpawn, type IdleRefineryDecisionInput } from './idle-refinery.js';

function baseInput(overrides: Partial<IdleRefineryDecisionInput> = {}): IdleRefineryDecisionInput {
  return {
    enabled: true,
    ledger: { free: 6, pendingQueueDepth: 0 },
    minFreeSlots: 3,
    activeRefineryCount: 0,
    lastSpawnAt: null,
    cooldownMs: 120 * 60_000,
    now: 10_000_000,
    ...overrides,
  };
}

describe('decideIdleRefinerySpawn', () => {
  it('spawns when idle, empty queue, no in-flight refinery, cooldown clear', () => {
    expect(decideIdleRefinerySpawn(baseInput())).toEqual({ spawn: true, reason: 'spawn' });
  });

  it('does not spawn when disabled — even if every other condition is met', () => {
    expect(decideIdleRefinerySpawn(baseInput({ enabled: false }))).toEqual({
      spawn: false,
      reason: 'disabled',
    });
  });

  it('does not spawn while the pending queue holds vetted work', () => {
    expect(decideIdleRefinerySpawn(baseInput({ ledger: { free: 6, pendingQueueDepth: 1 } }))).toEqual({
      spawn: false,
      reason: 'queue_not_empty',
    });
  });

  it('requires free slots at or above the configured N threshold', () => {
    expect(decideIdleRefinerySpawn(baseInput({ ledger: { free: 2, pendingQueueDepth: 0 }, minFreeSlots: 3 }))).toEqual({
      spawn: false,
      reason: 'insufficient_free_slots',
    });
    // Exactly N is enough.
    expect(decideIdleRefinerySpawn(baseInput({ ledger: { free: 3, pendingQueueDepth: 0 }, minFreeSlots: 3 })).spawn).toBe(true);
  });

  it('is single-flight: never stacks a second refinery task', () => {
    expect(decideIdleRefinerySpawn(baseInput({ activeRefineryCount: 1 }))).toEqual({
      spawn: false,
      reason: 'refinery_in_flight',
    });
  });

  it('honors the cooldown window since the last spawn', () => {
    const cooldownMs = 120 * 60_000;
    const lastSpawnAt = 9_000_000;
    // 30 min later — still cooling down.
    expect(decideIdleRefinerySpawn(baseInput({ lastSpawnAt, now: lastSpawnAt + 30 * 60_000, cooldownMs }))).toEqual({
      spawn: false,
      reason: 'cooldown',
    });
    // Exactly at the cooldown boundary — clear.
    expect(decideIdleRefinerySpawn(baseInput({ lastSpawnAt, now: lastSpawnAt + cooldownMs, cooldownMs })).spawn).toBe(true);
    // Well past — clear.
    expect(decideIdleRefinerySpawn(baseInput({ lastSpawnAt, now: lastSpawnAt + cooldownMs + 1, cooldownMs })).spawn).toBe(true);
  });

  it('reports the FIRST blocking guard in priority order', () => {
    // Disabled wins over everything.
    expect(
      decideIdleRefinerySpawn(
        baseInput({ enabled: false, ledger: { free: 0, pendingQueueDepth: 5 }, activeRefineryCount: 3 }),
      ).reason,
    ).toBe('disabled');
    // Queue depth wins over slot count.
    expect(
      decideIdleRefinerySpawn(baseInput({ ledger: { free: 0, pendingQueueDepth: 5 } })).reason,
    ).toBe('queue_not_empty');
    // Slot count wins over in-flight.
    expect(
      decideIdleRefinerySpawn(
        baseInput({ ledger: { free: 1, pendingQueueDepth: 0 }, minFreeSlots: 3, activeRefineryCount: 2 }),
      ).reason,
    ).toBe('insufficient_free_slots');
    // In-flight wins over cooldown.
    expect(
      decideIdleRefinerySpawn(
        baseInput({ activeRefineryCount: 1, lastSpawnAt: 9_999_999, now: 10_000_000, cooldownMs: 120 * 60_000 }),
      ).reason,
    ).toBe('refinery_in_flight');
  });
});
