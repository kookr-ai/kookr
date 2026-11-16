import { describe, expect, it } from 'vitest';

import {
  READY_QUEUE_SCHEMA,
  applyReadyQueueLaunchOutcome,
  decideReadyQueueTick,
  parseReadyQueueFile,
  pruneReadyQueueEntries,
  recoverReadyQueueEntries,
  serializeReadyQueueFile,
  type ReadyQueueEntry,
  type ReadyQueueGateInputs,
} from './ready-queue.js';

const NOW = Date.parse('2026-11-16T10:00:00.000Z');

function entry(id: string, over: Partial<ReadyQueueEntry> = {}): ReadyQueueEntry {
  return {
    id,
    request: { prompt: id, cwd: '/r' },
    launchSource: 'cli',
    idempotencyKey: `k-${id}`,
    state: 'queued',
    enqueuedAt: new Date(NOW - 60_000).toISOString(),
    attempts: 0,
    ...over,
  };
}

const OPEN: ReadyQueueGateInputs = {
  accepting: true,
  automationEnabled: true,
  free: 3,
  pendingQueueDepth: 0,
  loadPerCpu: 0.5,
  maxLoadPerCpu: 1.5,
};

describe('decideReadyQueueTick', () => {
  it('is idle with no queued entry and picks the oldest queued entry otherwise', () => {
    expect(decideReadyQueueTick([], OPEN, NOW)).toEqual({ kind: 'idle' });
    expect(decideReadyQueueTick([entry('a', { state: 'started' }), entry('b', { state: 'failed' })], OPEN, NOW))
      .toEqual({ kind: 'idle' });
    expect(decideReadyQueueTick([entry('a', { state: 'failed' }), entry('b'), entry('c')], OPEN, NOW))
      .toEqual({ kind: 'launch', entryId: 'b' });
  });

  it('never lets a later entry overtake a head that is waiting for Retry-After', () => {
    const head = entry('a', { notBefore: new Date(NOW + 10_000).toISOString() });
    expect(decideReadyQueueTick([head, entry('b')], OPEN, NOW)).toEqual({ kind: 'wait', entryId: 'a', reason: 'retry_after' });
    expect(decideReadyQueueTick([head, entry('b')], OPEN, NOW + 10_000)).toEqual({ kind: 'launch', entryId: 'a' });
  });

  it('counts only slots for ordinary launches', () => {
    expect(decideReadyQueueTick([entry('a')], { ...OPEN, free: 2, freeForGeneralSources: 0 }, NOW))
      .toMatchObject({ kind: 'wait', reason: 'no_free_slot' });
    expect(decideReadyQueueTick([entry('a')], { ...OPEN, free: 0, freeForGeneralSources: 1 }, NOW))
      .toMatchObject({ kind: 'wait', reason: 'no_free_slot' });
  });

  it('checks host load with the limit as an inclusive ceiling, and fails open on a missing sample or a 0 limit', () => {
    expect(decideReadyQueueTick([entry('a')], { ...OPEN, loadPerCpu: 1.5 }, NOW).kind).toBe('launch');
    expect(decideReadyQueueTick([entry('a')], { ...OPEN, loadPerCpu: 1.51 }, NOW))
      .toMatchObject({ kind: 'wait', reason: 'host_load' });
    expect(decideReadyQueueTick([entry('a')], { ...OPEN, loadPerCpu: null }, NOW).kind).toBe('launch');
    expect(decideReadyQueueTick([entry('a')], { ...OPEN, loadPerCpu: 9, maxLoadPerCpu: 0 }, NOW).kind).toBe('launch');
  });
});

describe('applyReadyQueueLaunchOutcome', () => {
  it('marks the entry failed exactly on the third failed attempt', () => {
    let current = entry('a');
    const flags: boolean[] = [];
    for (let i = 0; i < 3; i += 1) {
      const result = applyReadyQueueLaunchOutcome(current, { kind: 'failed', error: 'nope' }, NOW);
      flags.push(result.becameFailed);
      current = result.entry;
    }
    expect(flags).toEqual([false, false, true]);
    expect(current).toMatchObject({ state: 'failed', attempts: 3, failedAt: new Date(NOW).toISOString() });
  });

  it('a refusal keeps the attempt count and sets notBefore from Retry-After', () => {
    const result = applyReadyQueueLaunchOutcome(
      entry('a', { attempts: 1 }),
      { kind: 'refused', reason: 'retry_after', retryAfterMs: 5_000, error: 'busy', code: 'event_loop_saturated' },
      NOW,
    );
    expect(result.entry).toMatchObject({
      state: 'queued',
      attempts: 1,
      waitReason: 'retry_after',
      notBefore: new Date(NOW + 5_000).toISOString(),
    });
  });

  it('a start clears the previous error and wait fields', () => {
    const result = applyReadyQueueLaunchOutcome(
      entry('a', { attempts: 2, lastError: 'x', waitReason: 'launch_failed' }),
      { kind: 'started', taskId: 't1' },
      NOW,
    );
    expect(result.entry).toMatchObject({ state: 'started', taskId: 't1', attempts: 2 });
    expect(result.entry.lastError).toBeUndefined();
    expect(result.entry.waitReason).toBeUndefined();
  });
});

describe('recovery, pruning and the file format', () => {
  it('puts a launching entry back in place as queued', () => {
    expect(recoverReadyQueueEntries([entry('a', { state: 'launching' }), entry('b')]).map((e) => [e.id, e.state]))
      .toEqual([['a', 'queued'], ['b', 'queued']]);
  });

  it('prunes only finished entries past retention', () => {
    const old = new Date(NOW - 25 * 60 * 60_000).toISOString();
    const kept = pruneReadyQueueEntries([
      entry('a', { state: 'started', startedAt: old }),
      entry('b', { state: 'failed', failedAt: new Date(NOW).toISOString() }),
      entry('c', { enqueuedAt: old }),
    ], NOW);
    expect(kept.map((e) => e.id)).toEqual(['b', 'c']);
  });

  it('round-trips, drops malformed entries one by one, and rejects a foreign schema', () => {
    const raw = serializeReadyQueueFile([entry('a')]);
    expect(parseReadyQueueFile(raw)).toEqual({ entries: [entry('a')], dropped: 0 });
    const withJunk = JSON.stringify({ schema: READY_QUEUE_SCHEMA, entries: [entry('a'), { id: 'x' }, null] });
    expect(parseReadyQueueFile(withJunk)).toMatchObject({ dropped: 2, entries: [{ id: 'a' }] });
    expect(() => parseReadyQueueFile(JSON.stringify({ schema: 'other', entries: [] }))).toThrow(/schema/);
  });
});
