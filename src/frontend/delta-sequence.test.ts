import { describe, expect, test } from 'vitest';

import { DeltaSequenceTracker } from './delta-sequence.js';

const EPOCH = '2026-08-01T00:00:00.000Z';

describe('DeltaSequenceTracker (#1754 Stage 1)', () => {
  test('adopts (epoch, seq) from a snapshot', () => {
    const t = new DeltaSequenceTracker();
    expect(t.currentEpoch).toBeNull();
    expect(t.haveSeq).toBe(0);
    t.onSnapshot({ epoch: EPOCH, seq: 5 });
    expect(t.currentEpoch).toBe(EPOCH);
    expect(t.haveSeq).toBe(5);
  });

  test('a snapshot always re-bases, even backwards or across an epoch change', () => {
    const t = new DeltaSequenceTracker();
    t.onSnapshot({ epoch: EPOCH, seq: 9 });
    t.onSnapshot({ epoch: EPOCH, seq: 4 }); // server re-based lower — adopt it
    expect(t.haveSeq).toBe(4);
    t.onSnapshot({ epoch: '2026-08-01T09:00:00.000Z', seq: 0 }); // restart
    expect(t.currentEpoch).toBe('2026-08-01T09:00:00.000Z');
    expect(t.haveSeq).toBe(0);
  });

  test('ignores a snapshot with no / malformed position (pre-#1754 server stays uninitialized)', () => {
    const t = new DeltaSequenceTracker();
    t.onSnapshot(undefined);
    t.onSnapshot({});
    t.onSnapshot({ epoch: EPOCH }); // missing seq
    t.onSnapshot({ seq: 3 }); // missing epoch
    t.onSnapshot({ epoch: EPOCH, seq: Number.NaN });
    expect(t.currentEpoch).toBeNull();
    expect(t.haveSeq).toBe(0);
  });

  describe('evaluateDelta', () => {
    test('an exactly-in-order delta is applicable', () => {
      const t = new DeltaSequenceTracker();
      t.onSnapshot({ epoch: EPOCH, seq: 10 });
      expect(t.evaluateDelta({ epoch: EPOCH, seq: 11 })).toEqual({ action: 'apply' });
    });

    test('an epoch change forces resync', () => {
      const t = new DeltaSequenceTracker();
      t.onSnapshot({ epoch: EPOCH, seq: 10 });
      expect(t.evaluateDelta({ epoch: 'other', seq: 11 })).toEqual({ action: 'resync', reason: 'epoch_change' });
    });

    test('a seq gap (skip ahead or stale) forces resync', () => {
      const t = new DeltaSequenceTracker();
      t.onSnapshot({ epoch: EPOCH, seq: 10 });
      expect(t.evaluateDelta({ epoch: EPOCH, seq: 12 })).toEqual({ action: 'resync', reason: 'seq_gap' });
      expect(t.evaluateDelta({ epoch: EPOCH, seq: 10 })).toEqual({ action: 'resync', reason: 'seq_gap' });
    });

    test('a delta before any snapshot (uninitialized) forces resync', () => {
      const t = new DeltaSequenceTracker();
      expect(t.evaluateDelta({ epoch: EPOCH, seq: 1 })).toEqual({ action: 'resync', reason: 'apply_error' });
    });

    test('evaluateDelta never mutates the stored position', () => {
      const t = new DeltaSequenceTracker();
      t.onSnapshot({ epoch: EPOCH, seq: 10 });
      t.evaluateDelta({ epoch: EPOCH, seq: 11 });
      t.evaluateDelta({ epoch: EPOCH, seq: 99 });
      expect(t.haveSeq).toBe(10);
    });
  });

  describe('resyncReasonForDelta (Stage-1 always-resync)', () => {
    test('an in-order delta the Stage-1 client cannot apply reports apply_error', () => {
      const t = new DeltaSequenceTracker();
      t.onSnapshot({ epoch: EPOCH, seq: 10 });
      expect(t.resyncReasonForDelta({ epoch: EPOCH, seq: 11 })).toBe('apply_error');
    });

    test('a gap reports the precise cause', () => {
      const t = new DeltaSequenceTracker();
      t.onSnapshot({ epoch: EPOCH, seq: 10 });
      expect(t.resyncReasonForDelta({ epoch: EPOCH, seq: 13 })).toBe('seq_gap');
      expect(t.resyncReasonForDelta({ epoch: 'other', seq: 11 })).toBe('epoch_change');
    });
  });

  test('advance() commits a new position (Stage-2 apply path)', () => {
    const t = new DeltaSequenceTracker();
    t.onSnapshot({ epoch: EPOCH, seq: 10 });
    t.advance({ epoch: EPOCH, seq: 11 });
    expect(t.haveSeq).toBe(11);
    // The next in-order delta is now seq 12.
    expect(t.evaluateDelta({ epoch: EPOCH, seq: 12 })).toEqual({ action: 'apply' });
  });
});
