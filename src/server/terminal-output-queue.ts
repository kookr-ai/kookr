import type { TerminalSourceRange } from '../shared/terminal-stream.js';

const FRAME_BYTES = 8 * 1024;
const CREDIT_BYTES = 128 * 1024;
const VIEWER_BYTES = 2 * 1024 * 1024;
const ACK_STALL_MS = 5000;
type LagReason = 'viewer-budget' | 'fleet-budget' | 'control-budget' | 'ack-stalled' | 'send-failed';

/** Fleet admission charges actual owned segment capacity, including unacked data. */
export class TerminalOutputFleet {
  private readonly viewers = new Set<TerminalOutputQueue>();
  reservedBytes = 0;
  constructor(private readonly limit = 32 * 1024 * 1024) {}

  reserve(viewer: TerminalOutputQueue, bytes: number): boolean {
    while (bytes > this.limit - this.reservedBytes) {
      const largest = [...this.viewers].filter((candidate) => candidate !== viewer)
        .sort((a, b) => b.outstandingBytes - a.outstandingBytes
          || a.lastProgressAt - b.lastProgressAt || a.id.localeCompare(b.id))[0];
      if (!largest || largest.outstandingBytes <= viewer.outstandingBytes) {
        viewer.retire('fleet-budget');
        return false;
      }
      largest.retire('fleet-budget');
    }
    this.viewers.add(viewer);
    this.reservedBytes += bytes;
    return true;
  }

  release(viewer: TerminalOutputQueue, bytes: number): void {
    this.reservedBytes -= bytes;
    if (viewer.reservedBytes === 0) this.viewers.delete(viewer);
  }
}

const sharedFleet = new TerminalOutputFleet();

/** Cheap ownership gauge; includes queued and sent-but-unacknowledged bytes. */
export function getTerminalOutputBytes(): number { return sharedFleet.reservedBytes; }

interface Segment {
  kind: 'bytes';
  data: Buffer;
  length: number;
  offset: number;
  source?: TerminalSourceRange;
  /** Cumulative transport position once the entire segment has been sent. */
  sentEnd: number | null;
}
type Entry = Segment | { kind: 'control'; text: string };

interface OutputQueueOptions {
  id: string;
  generation: string;
  fleet?: TerminalOutputFleet;
  send(data: string | Uint8Array): void;
  close(reason: LagReason): void;
  defer?: (task: () => void) => void;
}

/** All seed, history, live bytes and their boundaries share this credit queue. */
export class TerminalOutputQueue {
  readonly id: string;
  outstandingBytes = 0;
  reservedBytes = 0;
  lastProgressAt = performance.now();
  private readonly fleet: TerminalOutputFleet;
  private readonly pending: Entry[] = [];
  private readonly held = new Set<Segment>();
  private sent = 0;
  private acknowledged = 0;
  private controlCount = 0;
  private scheduled = false;
  private paused = false;
  private disposed = false;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: OutputQueueOptions) {
    this.id = options.id;
    this.fleet = options.fleet ?? sharedFleet;
  }

  enqueue(bytes: Uint8Array, source?: TerminalSourceRange): boolean {
    if (this.disposed) return false;
    if (bytes.byteLength > VIEWER_BYTES - this.outstandingBytes) {
      this.retire('viewer-budget');
      return false;
    }
    if (source && source.end - source.start !== bytes.byteLength) return false;
    // Reserve the incoming logical payload before copying, so fleet eviction
    // compares lag holders against the entrant's whole projected obligation.
    this.outstandingBytes += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const last = this.pending.at(-1);
      let segment = last?.kind === 'bytes' && last.offset === 0 && last.length < FRAME_BYTES
        && sameSource(last.source, source, offset) ? last : undefined;
      if (!segment) {
        if (this.reservedBytes + FRAME_BYTES > VIEWER_BYTES) {
          this.retire('viewer-budget');
          return false;
        }
        if (!this.fleet.reserve(this, FRAME_BYTES)) return false;
        this.reservedBytes += FRAME_BYTES;
        segment = {
          kind: 'bytes', data: Buffer.allocUnsafe(FRAME_BYTES), length: 0, offset: 0, sentEnd: null,
          source: source ? {
            epoch: source.epoch, start: source.start + offset, end: source.start + offset,
            geometryRevision: source.geometryRevision, cols: source.cols, rows: source.rows,
          } : undefined,
        };
        this.pending.push(segment);
        this.held.add(segment);
      }
      const count = Math.min(FRAME_BYTES - segment.length, bytes.byteLength - offset);
      segment.data.set(bytes.subarray(offset, offset + count), segment.length);
      segment.length += count;
      if (segment.source) segment.source.end += count;
      offset += count;
    }
    this.schedule();
    return true;
  }

  control(message: Record<string, unknown>): boolean {
    if (this.disposed) return false;
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > 4096 || this.controlCount >= 64) {
      this.retire('control-budget');
      return false;
    }
    this.pending.push({ kind: 'control', text });
    this.controlCount++;
    this.schedule();
    return true;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.schedule();
  }

  get hasUnpositionedOutput(): boolean {
    return this.pending.some((entry) => entry.kind === 'bytes' && !entry.source);
  }

  /** Cancel only unsent work; already delivered bytes still require credit. */
  discardUnsent(): void {
    for (const entry of this.pending) {
      if (entry.kind === 'control') continue;
      this.outstandingBytes -= entry.length - entry.offset;
      if (entry.offset === 0) this.releaseSegment(entry);
      else entry.sentEnd = this.sent;
    }
    this.pending.length = 0;
    this.controlCount = 0;
    this.releaseAcknowledged();
  }

  /**
   * Insert a snapshot before live bytes collected during capture. Only source
   * positions identify duplicates; repeated text is never a deduplication key.
   * The queue stays paused until the caller commits its matching live boundary.
   */
  seed(snapshot: TerminalSourceRange, bytes: Uint8Array,
    begin: Record<string, unknown>, end: Record<string, unknown>, useAttachReplay = false): boolean {
    if (this.disposed || !this.paused) return false;
    let expected = snapshot.end;
    for (const entry of this.pending) {
      if (entry.kind !== 'bytes') return false;
      if (!entry.source) continue;
      if (entry.source.epoch !== snapshot.epoch) return false;
      if (entry.source.end <= snapshot.end) continue;
      if (Math.max(entry.source.start + entry.offset, snapshot.end) !== expected) return false;
      expected = entry.source.end;
    }
    const live: Segment[] = [];
    const replay: Segment[] = [];
    for (const entry of this.pending) {
      if (entry.kind !== 'bytes') return false;
      if (!entry.source) {
        if (useAttachReplay) replay.push(entry);
        else {
          this.outstandingBytes -= entry.length - entry.offset;
          this.releaseSegment(entry);
        }
        continue;
      }
      const skipped = Math.min(entry.length - entry.offset,
        Math.max(0, snapshot.end - (entry.source.start + entry.offset)));
      this.outstandingBytes -= skipped;
      const previouslySent = entry.offset;
      entry.offset += skipped;
      if (entry.offset === entry.length) {
        if (previouslySent === 0) this.releaseSegment(entry);
        else entry.sentEnd = this.sent;
      } else live.push(entry);
    }
    this.pending.length = 0;
    this.releaseAcknowledged();
    if (!this.control(begin) || !this.enqueue(bytes)) return false;
    this.pending.push(...replay);
    if (!this.control(end)) return false;
    this.pending.push(...live);
    return true;
  }

  private releaseSegment(segment: Segment): void {
    this.held.delete(segment);
    this.reservedBytes -= FRAME_BYTES;
    this.fleet.release(this, FRAME_BYTES);
  }

  private releaseAcknowledged(): void {
    // Snapshot insertion can reorder unsent segments, so allocation ownership
    // is a bounded set rather than a FIFO ordered by original admission time.
    for (const segment of this.held) {
      if (segment.sentEnd !== null && segment.sentEnd <= this.acknowledged) this.releaseSegment(segment);
    }
  }

  acknowledge(generation: string, bytes: number): boolean {
    if (this.disposed || generation !== this.options.generation || !Number.isSafeInteger(bytes)
      || bytes < 0 || bytes > this.sent) return false;
    if (bytes <= this.acknowledged) return true;
    this.outstandingBytes -= bytes - this.acknowledged;
    this.acknowledged = bytes;
    this.lastProgressAt = performance.now();
    this.releaseAcknowledged();
    this.armStallTimer(true);
    this.schedule();
    return true;
  }

  private schedule(): void {
    if (this.disposed || this.paused || this.scheduled || !this.pending.length) return;
    if (this.pending[0].kind === 'bytes' && this.sent - this.acknowledged >= CREDIT_BYTES) return;
    this.scheduled = true;
    (this.options.defer ?? setImmediate)(() => {
      this.scheduled = false;
      if (this.disposed || this.paused) return;
      try { this.flushOne(); } catch { this.retire('send-failed'); }
      this.schedule();
    });
  }

  private flushOne(): void {
    const next = this.pending[0];
    if (!next) return;
    if (next.kind === 'control') {
      this.pending.shift();
      this.controlCount--;
      this.options.send(next.text);
      return;
    }
    const count = Math.min(next.length - next.offset, CREDIT_BYTES - (this.sent - this.acknowledged));
    if (count <= 0) return;
    if (next.source) {
      this.options.send(JSON.stringify({
        type: 'source', ...next.source, generation: this.options.generation,
        start: next.source.start + next.offset, end: next.source.start + next.offset + count,
      }));
    }
    this.options.send(next.data.subarray(next.offset, next.offset + count));
    this.sent += count;
    next.offset += count;
    if (next.offset === next.length) {
      next.sentEnd = this.sent;
      this.pending.shift();
    }
    this.armStallTimer(false);
  }

  private armStallTimer(progress: boolean): void {
    if (progress && this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    if (this.stallTimer === null && this.sent > this.acknowledged) {
      this.stallTimer = setTimeout(() => this.retire('ack-stalled'), ACK_STALL_MS);
      this.stallTimer.unref?.();
    }
  }

  retire(reason: LagReason): void {
    if (this.disposed) return;
    this.dispose();
    this.options.close(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    this.pending.length = 0;
    this.held.clear();
    const reserved = this.reservedBytes;
    this.reservedBytes = 0;
    this.outstandingBytes = 0;
    this.fleet.release(this, reserved);
  }
}

function sameSource(left: TerminalSourceRange | undefined, right: TerminalSourceRange | undefined, offset: number) {
  if (!left || !right) return !left && !right;
  return left.epoch === right.epoch && left.geometryRevision === right.geometryRevision
    && left.cols === right.cols && left.rows === right.rows && left.end === right.start + offset;
}
