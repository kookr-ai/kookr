import { describe, expect, test } from 'vitest';

import type { SnapshotMessage } from '../shared/contracts/messages.js';
import { SnapshotStreamSequencer, stampSnapshotPosition } from './snapshot-stream-sequencer.js';

const EPOCH = '2026-08-01T00:00:00.000Z';

function snapshot(overrides: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return { type: 'snapshot', agents: [], serverCwd: '/repo', ...overrides };
}

describe('SnapshotStreamSequencer (#1754 Stage 1)', () => {
  test('seq starts at 0 and advance() increments monotonically by exactly 1', () => {
    const seq = new SnapshotStreamSequencer(EPOCH);
    expect(seq.current()).toEqual({ epoch: EPOCH, seq: 0 });
    expect(seq.advance()).toEqual({ epoch: EPOCH, seq: 1 });
    expect(seq.advance()).toEqual({ epoch: EPOCH, seq: 2 });
    expect(seq.advance()).toEqual({ epoch: EPOCH, seq: 3 });
  });

  test('current() reports the last advanced position without advancing', () => {
    const seq = new SnapshotStreamSequencer(EPOCH);
    seq.advance();
    seq.advance();
    expect(seq.current()).toEqual({ epoch: EPOCH, seq: 2 });
    // Reading current() repeatedly never moves the counter — the re-base target
    // (connect / resync) must not consume a seq.
    expect(seq.current()).toEqual({ epoch: EPOCH, seq: 2 });
    expect(seq.advance()).toEqual({ epoch: EPOCH, seq: 3 });
  });

  test('epoch is stable across the sequencer lifetime', () => {
    const seq = new SnapshotStreamSequencer(EPOCH);
    for (let i = 0; i < 5; i++) expect(seq.advance().epoch).toBe(EPOCH);
    expect(seq.current().epoch).toBe(EPOCH);
  });

  test('a fresh sequencer (server restart) has a new epoch and resets seq to 0', () => {
    const restarted = new SnapshotStreamSequencer('2026-08-01T09:00:00.000Z');
    expect(restarted.current()).toEqual({ epoch: '2026-08-01T09:00:00.000Z', seq: 0 });
  });

  test('stampSnapshotPosition adds (epoch, seq) without mutating the input or dropping fields', () => {
    const base = snapshot({ serverStartedAt: EPOCH, totalSpendUsd: 12 });
    const stamped = stampSnapshotPosition(base, { epoch: EPOCH, seq: 42 });
    expect(stamped.epoch).toBe(EPOCH);
    expect(stamped.seq).toBe(42);
    // Every pre-existing field is preserved.
    expect(stamped.serverStartedAt).toBe(EPOCH);
    expect(stamped.totalSpendUsd).toBe(12);
    // Purity: the source object is untouched.
    expect(base).not.toHaveProperty('seq');
    expect(base).not.toHaveProperty('epoch');
    expect(stamped).not.toBe(base);
  });
});
