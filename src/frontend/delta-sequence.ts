// --- Client delta-stream sequence tracker (issue #1754) ---
//
// Pure, framework-free tracking of the server's delta-protocol stream position
// `(epoch, seq)` plus the gap-detection rule that decides when the client must
// resync. Kept out of the store slice (and its large positional `handleSnapshot`
// signature) so it is unit-testable in isolation and the wiring in
// `useWebSocket` stays a thin adapter.
//
// Stage 2: the client adopts `(epoch, seq)` from every snapshot (a snapshot
// always RE-BASES it) and applies in-order deltas via `evaluateDelta` →
// `handleDelta` → `advance`. A gap / epoch change / apply error triggers the
// `requestResync` escape hatch.

export type ResyncReason = 'seq_gap' | 'epoch_change' | 'apply_error';

export interface DeltaFramePosition {
  epoch: string;
  seq: number;
}

export type DeltaVerdict =
  | { action: 'apply' }
  | { action: 'resync'; reason: ResyncReason };

function isValidPosition(position: unknown): position is DeltaFramePosition {
  return (
    typeof position === 'object'
    && position !== null
    && typeof (position as DeltaFramePosition).epoch === 'string'
    && typeof (position as DeltaFramePosition).seq === 'number'
    && Number.isFinite((position as DeltaFramePosition).seq)
  );
}

export class DeltaSequenceTracker {
  private epoch: string | null = null;
  /** Last adopted seq. `-1` means uninitialized (no snapshot seen yet). */
  private seq = -1;

  /**
   * Adopt a snapshot's stream position. A snapshot always re-bases the client,
   * so this overwrites the stored position unconditionally. A snapshot carrying
   * no `(epoch, seq)` (a pre-#1754 server, or a wiring that did not opt in) is
   * ignored — the tracker simply stays uninitialized and never forces a resync.
   */
  onSnapshot(position: Partial<DeltaFramePosition> | null | undefined): void {
    if (!isValidPosition(position)) return;
    this.epoch = position.epoch;
    this.seq = position.seq;
  }

  /**
   * Classify an incoming delta against the stored position WITHOUT mutating.
   * `apply` means the delta is exactly in order (same epoch, seq === stored+1);
   * every other case names the resync reason. Uninitialized (no snapshot yet)
   * counts as `apply_error` — there is no baseline to apply against.
   */
  evaluateDelta(position: DeltaFramePosition): DeltaVerdict {
    if (this.epoch === null) return { action: 'resync', reason: 'apply_error' };
    if (position.epoch !== this.epoch) return { action: 'resync', reason: 'epoch_change' };
    if (position.seq !== this.seq + 1) return { action: 'resync', reason: 'seq_gap' };
    return { action: 'apply' };
  }

  /**
   * Map a delta position to the resync reason the client would report. Prefer
   * branching on {@link evaluateDelta} in Stage 2 (apply on `apply`); this
   * helper remains for tests and callers that only need the gap reason.
   */
  resyncReasonForDelta(position: DeltaFramePosition): ResyncReason {
    const verdict = this.evaluateDelta(position);
    return verdict.action === 'resync' ? verdict.reason : 'apply_error';
  }

  /**
   * Advance the stored position after a successfully-applied in-order delta.
   */
  advance(position: DeltaFramePosition): void {
    this.epoch = position.epoch;
    this.seq = position.seq;
  }

  /** The client's last-known seq, for `requestResync.haveSeq`. `0` when uninitialized. */
  get haveSeq(): number {
    return this.seq < 0 ? 0 : this.seq;
  }

  /** The stored epoch, or `null` when no positioned snapshot has been seen. */
  get currentEpoch(): string | null {
    return this.epoch;
  }
}
