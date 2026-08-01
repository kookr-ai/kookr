// --- Snapshot stream sequencer (issue #1754, Stage 1) ---
//
// Single owner of the delta-protocol stream identity `(epoch, seq)` for the
// local dashboard fan-out. `epoch` is stable for a server's lifetime (the
// server-started-at ISO string) and changes on restart; `seq` is a monotonic
// counter that advances once per snapshot flush. Every snapshot frame the
// server emits is stamped with a position from here so a client can detect an
// epoch change or a `seq` gap and re-base via the resync escape hatch.
//
// Stage 1 emits `(epoch, seq)` ONLY on `snapshot` frames — the wire still
// carries a full snapshot per change ("ships dark"). Stage 2 will additionally
// stamp `delta` frames, advancing `seq` by exactly 1 per flush.

import type { SnapshotMessage } from '../shared/contracts/messages.js';

/** A position in the snapshot stream: a lifetime-stable epoch and a monotonic seq. */
export interface StreamPosition {
  epoch: string;
  seq: number;
}

/**
 * Owns the monotonic `seq` for one server process. `epoch` is fixed at
 * construction (== serverStartedAt). `seq` starts at 0 (the connect-time
 * baseline) and is advanced once per broadcast flush via {@link advance}.
 */
export class SnapshotStreamSequencer {
  private seqValue = 0;

  constructor(private readonly epochValue: string) {}

  /** Advance to and return the next flush position. Called once per snapshot flush. */
  advance(): StreamPosition {
    this.seqValue += 1;
    return { epoch: this.epochValue, seq: this.seqValue };
  }

  /**
   * The current position WITHOUT advancing — the re-base target for a
   * connect-time snapshot or a resync reply. A snapshot at the current seq
   * supersedes every intervening frame, so re-basing to it is always safe.
   */
  current(): StreamPosition {
    return { epoch: this.epochValue, seq: this.seqValue };
  }
}

/**
 * Return a copy of `msg` stamped with `(epoch, seq)`. Kept as a pure helper so
 * every snapshot-emitting site (fan-out, connect burst, resync reply) stamps
 * identically. Never mutates the input.
 */
export function stampSnapshotPosition(msg: SnapshotMessage, position: StreamPosition): SnapshotMessage {
  return { ...msg, epoch: position.epoch, seq: position.seq };
}
