import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createLatestSnapshotWriter } from './latest-snapshot-writer.js';
import { ensureDtachDir } from './dtach-instance-dir.js';
import { join } from 'node:path';
import type { SessionId } from './terminal-backend.js';

/**
 * Per-session scrollback captured from the PTY, consumed on frontend attach
 * as a byte replay.
 *
 * Sized for ratatui-style TUIs (Codex, Claude Code). Idle is silent (0 B/s),
 * but active sessions stream the assistant's token output at ~10 KB/s as
 * cursor-positioned differential repaints. The 64 KB predecessor held only
 * ~6 seconds of streaming output, so on any attach the ring often contained
 * only the tail of a diff stream with no established background.
 *
 * Issue #1779: capacity is still `RING_BUFFER_BYTES` for active sessions, but
 * a fleet-wide budget can shrink least-recently-active rings down to
 * `RING_IDLE_CAPACITY_BYTES` so N idle sessions no longer pin N full buffers.
 */
export const RING_BUFFER_BYTES = 1 * 1024 * 1024;
/** Floor capacity for rings shrunk under fleet budget pressure (issue #1779). */
export const RING_IDLE_CAPACITY_BYTES = 64 * 1024;
export const DEFAULT_RING_FLUSH_INTERVAL_MS = 2_000;
/**
 * Legacy two-file snapshot format (`<id>.bin` + `<id>.meta.json`). Still read
 * on load so a snapshot written before the upgrade to the combined format is
 * recoverable, but no longer written.
 */
const RING_META_VERSION_LEGACY = 1;
/**
 * Combined single-file snapshot format (`<id>.ring`). Data and metadata live in
 * one file committed with a single atomic rename, so a crash or ENOSPC can
 * never leave a mismatched data/metadata pair that makes valid scrollback look
 * corrupt (issue #2829). The file is a JSON header line, then a `\n`, then the
 * raw logical ring bytes.
 */
const RING_META_VERSION_COMBINED = 2;
const RING_SNAPSHOT_MARKER = 0x0a; // '\n' separating the JSON header from bytes

/**
 * Where a shrunk ring's restorable history continues (issue #3565). A fleet
 * shrink first saves the full ring to `<id>.pre-shrink.ring`; the periodic
 * flush never writes that file, so it survives the smaller `.ring` flushes
 * that follow. `end` is the `ringHead` position at which the saved bytes stop:
 * ring bytes before it are the snapshot's tail, bytes from it on arrived after
 * the shrink.
 */
export interface PreShrinkLink {
  snapshotId: string;
  end: number;
}

/** `.ring` header field naming the pre-shrink snapshot its payload continues. */
interface PreShrinkRef {
  snapshotId: string;
  /** Payload offset where the snapshot's bytes stop (its tail precedes it). */
  join: number;
}

export interface DtachRingState {
  id: SessionId;
  /**
   * Counter of bytes ingested into the ring. Monotonically increases for the
   * lifetime of a single backend instance. After a Kookr restart that
   * recovered the session via `load`, this is reset to the persisted byte
   * count; nothing outside the backend depends on the absolute value.
   *
   * Capacity changes (shrink/expand) re-linearize retained bytes and reset
   * this to the retained length so modulo arithmetic stays consistent with
   * the new buffer length.
   */
  ringHead: number;
  /** Timestamp of the most recent PTY bytes ingested into this ring. */
  lastByteAt: number | null;
  /**
   * Backing store for the ring buffer. Length is the current capacity
   * (`RING_BUFFER_BYTES` for full rings, as low as `RING_IDLE_CAPACITY_BYTES`
   * after fleet-budget shrink).
   */
  ringBuffer: Buffer;
  /**
   * `ringHead` value at the last successful disk flush. `-1` until the first
   * flush completes. Used to skip idle sessions whose ring has not changed.
   */
  lastFlushedHead: number;
  /**
   * Increments whenever the ring is re-linearized (shrink/expand), which resets
   * lastFlushedHead to -1. A pending async snapshot captures this value; on
   * completion the writer advances lastFlushedHead only when the seq is
   * unchanged, so a late completion cannot restore a head a shrink invalidated
   * (which would mark re-linearized/newer output as already persisted and strand
   * it). Absent on states created before this field; treated as 0.
   */
  resetSeq?: number;
  /**
   * Set while the ring continues a pre-shrink snapshot on disk; see
   * {@link PreShrinkLink}. Absent on states created before this field.
   */
  preShrink?: PreShrinkLink | null;
}

export function createDtachRingState(
  id: SessionId,
  capacity: number = RING_BUFFER_BYTES,
): DtachRingState {
  const cap = Math.max(1, Math.floor(capacity));
  return {
    id,
    ringHead: 0,
    lastByteAt: null,
    ringBuffer: Buffer.alloc(cap),
    lastFlushedHead: -1,
    resetSeq: 0,
    preShrink: null,
  };
}

/** Current allocated capacity of a ring (buffer length). */
export function ringCapacity(state: DtachRingState): number {
  return state.ringBuffer.length;
}

/** Sum of allocated capacities across a fleet of rings. */
export function totalRingFleetBytes(states: Iterable<DtachRingState>): number {
  let total = 0;
  for (const state of states) total += state.ringBuffer.length;
  return total;
}

export interface RingFleetBudgetSnapshot {
  /** Sum of `ringBuffer.length` across live rings. */
  totalBytes: number;
  /**
   * Configured fleet budget in bytes. `0` means enforcement is disabled
   * (unlimited).
   */
  budgetBytes: number;
  /** `max(0, totalBytes - budgetBytes)` when budget is enabled; else 0. */
  overBudgetBytes: number;
  /** Count of rings currently below full capacity. */
  shrunkenSessions: number;
}

export function ringFleetBudgetSnapshot(
  states: Iterable<DtachRingState>,
  budgetBytes: number,
): RingFleetBudgetSnapshot {
  let totalBytes = 0;
  let shrunkenSessions = 0;
  for (const state of states) {
    totalBytes += state.ringBuffer.length;
    if (state.ringBuffer.length < RING_BUFFER_BYTES) shrunkenSessions += 1;
  }
  const budget = budgetBytes > 0 ? budgetBytes : 0;
  return {
    totalBytes,
    budgetBytes: budget,
    overBudgetBytes: budget > 0 ? Math.max(0, totalBytes - budget) : 0,
    shrunkenSessions,
  };
}

/**
 * Shrink `state` to at most `newCapacity` bytes, retaining the most recent
 * logical bytes. No-op when already at or below the target. Returns true when
 * the buffer was reallocated smaller.
 */
export function shrinkRing(state: DtachRingState, newCapacity: number): boolean {
  const target = Math.max(1, Math.floor(newCapacity));
  const current = state.ringBuffer.length;
  if (current <= target) return false;

  const available = Math.min(state.ringHead, current);
  const keep = Math.min(available, target);
  const next = Buffer.alloc(target);
  if (keep > 0) {
    const retained = Buffer.alloc(keep);
    copyLogicalBytes(state.ringBuffer, state.ringHead, keep, retained);
    retained.copy(next, 0, 0, keep);
  }
  state.ringBuffer = next;
  relinearizeHead(state, keep);
  // Force a later flush so disk meta matches the truncated in-memory view.
  // This function drops the older bytes; DtachRingStore.shrink saves them to
  // the pre-shrink snapshot first. Bump resetSeq so a snapshot enqueued
  // before this shrink cannot, on completion, restore the pre-shrink
  // lastFlushedHead and strand re-linearized output.
  state.lastFlushedHead = -1;
  state.resetSeq = (state.resetSeq ?? 0) + 1;
  return true;
}

/**
 * Expand `state` up to `newCapacity` (typically {@link RING_BUFFER_BYTES}),
 * re-linearizing retained bytes at the start of the new buffer. Returns true
 * when the buffer grew.
 */
export function expandRing(state: DtachRingState, newCapacity: number): boolean {
  const target = Math.max(1, Math.floor(newCapacity));
  const current = state.ringBuffer.length;
  if (current >= target) return false;

  const available = Math.min(state.ringHead, current);
  const next = Buffer.alloc(target);
  if (available > 0) {
    const retained = Buffer.alloc(available);
    copyLogicalBytes(state.ringBuffer, state.ringHead, available, retained);
    retained.copy(next, 0, 0, available);
  }
  state.ringBuffer = next;
  relinearizeHead(state, available);
  state.lastFlushedHead = -1;
  state.resetSeq = (state.resetSeq ?? 0) + 1;
  return true;
}

/**
 * Re-linearizing moves the retained bytes to the start of a new buffer, so
 * every head-relative position moves down by the same amount.
 */
function relinearizeHead(state: DtachRingState, newHead: number): void {
  if (state.preShrink) state.preShrink.end -= state.ringHead - newHead;
  state.ringHead = newHead;
}

export interface EnforceRingFleetBudgetResult {
  /** Rings that were shrunk this call. */
  shrunk: number;
  /** Fleet capacity after enforcement. */
  totalBytes: number;
  /** Bytes still over budget after shrinking as far as the idle floor allows. */
  overBudgetBytes: number;
}

/**
 * When `budgetBytes > 0` and the fleet's allocated capacity exceeds it, shrink
 * least-recently-active rings (by `lastByteAt`, null treated as oldest) down
 * to `idleCapacity` until under budget or no further shrink candidates remain.
 *
 * `budgetBytes <= 0` disables enforcement (returns current totals only).
 * `shrink` performs each shrink; the backend passes
 * {@link DtachRingStore.shrink} so the dropped scrollback is saved first.
 */
export function enforceRingFleetBudget(
  states: Iterable<DtachRingState>,
  budgetBytes: number,
  idleCapacity: number = RING_IDLE_CAPACITY_BYTES,
  shrink: (state: DtachRingState, capacity: number) => boolean = shrinkRing,
): EnforceRingFleetBudgetResult {
  const list = [...states];
  let totalBytes = totalRingFleetBytes(list);
  if (!(budgetBytes > 0) || totalBytes <= budgetBytes) {
    return {
      shrunk: 0,
      totalBytes,
      overBudgetBytes: budgetBytes > 0 ? Math.max(0, totalBytes - budgetBytes) : 0,
    };
  }

  const floor = Math.max(1, Math.floor(idleCapacity));
  const candidates = list
    .filter((s) => s.ringBuffer.length > floor)
    .sort((a, b) => (a.lastByteAt ?? 0) - (b.lastByteAt ?? 0));

  let shrunk = 0;
  for (const state of candidates) {
    if (totalBytes <= budgetBytes) break;
    const before = state.ringBuffer.length;
    if (!shrink(state, floor)) continue;
    totalBytes -= before - state.ringBuffer.length;
    shrunk += 1;
  }

  return {
    shrunk,
    totalBytes,
    overBudgetBytes: Math.max(0, totalBytes - budgetBytes),
  };
}

export class DtachRingStore {
  private readonly asyncWriter: ReturnType<typeof createLatestSnapshotWriter> | null;
  private readonly snapshotOwners = new WeakMap<Uint8Array, { state: DtachRingState; head: number; resetSeq: number }>();

  constructor(private readonly ringsDir: string, options: { asyncPersistence?: boolean; asyncMaxBytes?: number } = {}) {
    ensureDtachDir(this.ringsDir);
    this.asyncWriter = options.asyncPersistence ? createLatestSnapshotWriter({
      commit: (id, bytes) => this.commitAsync(id, bytes),
      onError: (id, error) => console.warn(`[dtach-backend] failed to persist ring for ${id}: ${String(error)}`),
      ...(options.asyncMaxBytes !== undefined ? { maxBytes: options.asyncMaxBytes } : {}),
    }) : null;
  }

  copyFrom(state: DtachRingState, head: number, size: number, out: Buffer): void {
    if (size === 0) return;
    copyLogicalBytes(state.ringBuffer, head, size, out);
  }

  copyInto(state: DtachRingState, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const cap = state.ringBuffer.length;
    const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let retained = source;
    let firstLogical = state.ringHead;
    if (source.length > cap) {
      retained = source.subarray(source.length - cap);
      firstLogical += source.length - cap;
    }

    const startSlot = positiveMod(firstLogical, cap);
    const tail = Math.min(retained.length, cap - startSlot);
    retained.copy(state.ringBuffer, startSlot, 0, tail);
    if (tail < retained.length) {
      retained.copy(state.ringBuffer, 0, tail);
    }
    state.ringHead += source.length;
  }

  /**
   * Write a ring snapshot in logical order, oldest byte first.
   *
   * Data and metadata are packed into one file (`<id>.ring`: a JSON header, a
   * `\n`, then the raw bytes) and committed with a single atomic rename. Because
   * the whole generation is swapped in by one rename, a crash or ENOSPC leaves
   * either the previous complete snapshot or the new complete snapshot on disk —
   * never a mismatched data/metadata pair that {@link load} would reject and so
   * silently discard valid scrollback (issue #2829). The previous generation is
   * only replaced once the new file is fully written, so the last recoverable
   * scrollback is never destroyed before its successor is durable.
   */
  persist(state: DtachRingState): void {
    try {
      if (this.asyncWriter) {
        const { head, bytes } = this.snapshot(state);
        this.snapshotOwners.set(bytes, { state, head, resetSeq: state.resetSeq ?? 0 });
        if (this.asyncWriter.enqueue(state.id, bytes)) return;
        this.snapshotOwners.delete(bytes);
        // A synchronous rename must never pass an older async rename for the
        // same file. Keep this ring dirty for a later tick; shutdown drains old
        // writes before its final flush. A session with no write in flight
        // can still use the synchronous fallback safely.
        if (this.asyncWriter.owns(state.id)) return;
      }
      // `rings/` sits under the /tmp instance directory and can be swept away
      // while the server runs. Re-create it here so a vanished directory costs
      // one snapshot rather than every snapshot from now on (#3042).
      ensureDtachDir(this.ringsDir);
      const { head, bytes } = this.snapshot(state);
      writeFileAtomicSync(this.ringPathFor(state.id), bytes);

      // The combined file is now the authoritative generation; drop any legacy
      // two-file snapshot left over from before the format upgrade so it can no
      // longer shadow or confuse recovery.
      this.removeLegacy(state.id);

      state.lastFlushedHead = head;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[dtach-backend] failed to persist ring for ${state.id}: ${String(err)}`);
    }
  }

  /**
   * Shrink `state` like {@link shrinkRing}, but first save the bytes the
   * shrink drops to `<id>.pre-shrink.ring` (issue #3565). Later flushes write
   * only the smaller ring to `<id>.ring` and name the snapshot in its header,
   * and {@link load} joins the two, so a restart still gets the full
   * scrollback. A failed save is logged and the shrink goes ahead: the fleet
   * budget matters more than one session's older scrollback.
   */
  shrink(state: DtachRingState, newCapacity: number): boolean {
    const target = Math.max(1, Math.floor(newCapacity));
    if (state.ringBuffer.length <= target) return false;
    // A ring that fits in the target loses nothing, and any snapshot it
    // already continues stays valid through the re-linearization.
    const snapshotId = Math.min(state.ringHead, state.ringBuffer.length) > target
      ? this.savePreShrink(state)
      : null;
    shrinkRing(state, target);
    if (snapshotId) state.preShrink = { snapshotId, end: state.ringHead };
    return true;
  }

  /** Write the full logical history to the pre-shrink file; null on failure. */
  private savePreShrink(state: DtachRingState): string | null {
    try {
      ensureDtachDir(this.ringsDir);
      const head = state.ringHead;
      const size = Math.min(head, state.ringBuffer.length);
      const ring = Buffer.alloc(size);
      copyLogicalBytes(state.ringBuffer, head, size, ring);
      // A ring shrunk before, then expanded, still continues the older
      // snapshot: carry that history into the new one.
      const ref = this.preShrinkRef(state, head, size);
      const earlier = ref ? this.readPreShrink(state.id, ref.snapshotId) : null;
      let payload = earlier && ref ? Buffer.concat([earlier, ring.subarray(ref.join)]) : ring;
      if (payload.length > RING_BUFFER_BYTES) payload = payload.subarray(payload.length - RING_BUFFER_BYTES);
      const snapshotId = randomUUID();
      writeFileAtomicSync(this.preShrinkPathFor(state.id), encodeSnapshot({
        version: RING_META_VERSION_COMBINED,
        size: payload.length,
        savedAt: new Date().toISOString(),
        snapshotId,
      }, payload));
      return snapshotId;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[dtach-backend] failed to save pre-shrink scrollback for ${state.id}: ${String(err)}`);
      return null;
    }
  }

  /**
   * The header reference for a `.ring` payload covering logical bytes
   * `[head - size, head)`, or null when the ring does not continue a
   * snapshot. Once more bytes have arrived since the shrink than the ring
   * holds, joining the snapshot would splice across a hole: drop it.
   */
  private preShrinkRef(state: DtachRingState, head: number, size: number): PreShrinkRef | null {
    const link = state.preShrink;
    if (!link) return null;
    const join = link.end - (head - size);
    if (join >= 0 && join <= size) return { snapshotId: link.snapshotId, join };
    state.preShrink = null;
    this.removePreShrink(state.id);
    return null;
  }

  /** The pre-shrink snapshot's bytes when it is the one `snapshotId` names. */
  private readPreShrink(id: SessionId, snapshotId: string): Buffer | null {
    const path = this.preShrinkPathFor(id);
    if (!existsSync(path)) return null;
    try {
      const file = readFileSync(path);
      const sep = file.indexOf(RING_SNAPSHOT_MARKER);
      if (sep < 0) return null;
      const meta = JSON.parse(file.subarray(0, sep).toString('utf-8')) as {
        version?: number; size?: number; snapshotId?: unknown;
      };
      const payload = file.subarray(sep + 1);
      if (meta.version !== RING_META_VERSION_COMBINED || meta.snapshotId !== snapshotId) return null;
      if (meta.size !== payload.length) return null;
      return payload;
    } catch {
      return null;
    }
  }

  private removePreShrink(id: SessionId): void {
    try {
      unlinkSync(this.preShrinkPathFor(id));
    } catch {
      // best-effort: absent already, or the next remove() retries
    }
  }

  /**
   * Restore a snapshot, preferring the combined single-file format and falling
   * back to the legacy two-file layout. Fail-open: malformed snapshots leave the
   * in-memory ring empty instead of preventing the backend from serving the
   * session.
   */
  load(state: DtachRingState): void {
    if (!this.loadCombined(state)) this.loadLegacy(state);
    // A snapshot the restored ring does not continue can never be joined.
    if (!state.preShrink) this.removePreShrink(state.id);
  }

  /**
   * Load the combined `<id>.ring` file. Returns true when a snapshot file was
   * present and consumed (whether or not it yielded bytes), so the caller knows
   * not to fall back to the legacy layout.
   */
  private loadCombined(state: DtachRingState): boolean {
    const ringPath = this.ringPathFor(state.id);
    if (!existsSync(ringPath)) return false;
    try {
      const file = readFileSync(ringPath);
      const sep = file.indexOf(RING_SNAPSHOT_MARKER);
      if (sep < 0) return true; // header truncated: nothing to recover, fail-open
      const meta = JSON.parse(file.subarray(0, sep).toString('utf-8')) as {
        version?: number;
        size?: number;
        lastByteAt?: unknown;
        preShrink?: Partial<PreShrinkRef>;
      };
      // A present `.ring` is authoritative even when unreadable: a successful
      // persist removes the legacy pair, so a valid `.ring` is always the newest
      // generation. Returning true (rather than falling back to a legacy pair)
      // is deliberate — the worst case is an empty ring, never resurrected stale
      // scrollback.
      if (meta.version !== RING_META_VERSION_COMBINED) return true;
      const payload = file.subarray(sep + 1);
      if (typeof meta.size !== 'number' || meta.size !== payload.length) return true;
      const { snapshotId, join } = meta.preShrink ?? {};
      const earlier = typeof snapshotId === 'string' && typeof join === 'number'
        && Number.isInteger(join) && join >= 0 && join <= payload.length
        ? this.readPreShrink(state.id, snapshotId)
        : null;
      if (!earlier || snapshotId === undefined || join === undefined) {
        this.applySnapshot(state, payload, meta.lastByteAt);
        return true;
      }
      const joined = Buffer.concat([earlier, payload.subarray(join)]);
      this.applySnapshot(state, joined, meta.lastByteAt);
      // Keep the link in the loaded ring's coordinates, so its next flush
      // still names the snapshot until the ring no longer joins onto it.
      const dropped = joined.length - state.ringHead;
      state.preShrink = { snapshotId, end: earlier.length - dropped };
    } catch {
      // fail-open: a torn header/body leaves the ring empty rather than crashing
    }
    return true;
  }

  /** Load the pre-#2829 `<id>.bin` + `<id>.meta.json` pair. */
  private loadLegacy(state: DtachRingState): void {
    const binPath = this.legacyBinPathFor(state.id);
    const metaPath = this.legacyMetaPathFor(state.id);
    if (!existsSync(binPath) || !existsSync(metaPath)) return;
    try {
      const metaRaw = readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(metaRaw) as { version?: number; size?: number; lastByteAt?: unknown };
      if (meta.version !== RING_META_VERSION_LEGACY) return;
      const buf = readFileSync(binPath);
      if (typeof meta.size !== 'number' || meta.size !== buf.length) return;
      this.applySnapshot(state, buf, meta.lastByteAt);
    } catch {
      // fail-open
    }
  }

  /** Copy a validated snapshot payload into the in-memory ring. */
  private applySnapshot(state: DtachRingState, buf: Buffer, lastByteAt: unknown): void {
    const cap = state.ringBuffer.length;
    const size = Math.min(buf.length, cap);
    if (size === 0) return;
    // Prefer the most recent `size` bytes when the disk snapshot exceeds the
    // current capacity (e.g. a previously-full ring loaded into a test ring).
    const srcOffset = buf.length - size;
    buf.copy(state.ringBuffer, 0, srcOffset, srcOffset + size);
    state.ringHead = size;
    state.lastByteAt = typeof lastByteAt === 'number' && Number.isFinite(lastByteAt)
      ? lastByteAt
      : null;
    state.lastFlushedHead = size;
  }

  remove(id: SessionId): void | Promise<void> {
    if (this.asyncWriter) return this.removeAsync(id);
    for (const path of [this.ringPathFor(id), this.preShrinkPathFor(id), this.legacyBinPathFor(id), this.legacyMetaPathFor(id)]) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // best-effort
      }
    }
  }

  /** Waits for admitted snapshots; the host supplies the shutdown deadline. */
  async drain(): Promise<void> { await this.asyncWriter?.drain(); }

  persistenceStats() {
    return this.asyncWriter?.stats() ?? { pendingBytes: 0, sessions: 0, rejected: 0 };
  }

  private snapshot(state: DtachRingState): { head: number; bytes: Buffer } {
    const head = state.ringHead;
    const size = Math.min(head, state.ringBuffer.length);
    const preShrink = this.preShrinkRef(state, head, size);
    const header = Buffer.from(JSON.stringify({ version: RING_META_VERSION_COMBINED, size,
      savedAt: new Date().toISOString(), lastByteAt: state.lastByteAt,
      ...(preShrink ? { preShrink } : {}) }) + '\n');
    // One owned allocation; the fixed-size ring can keep accepting output while
    // this immutable generation is written off the JavaScript event loop.
    const bytes = Buffer.allocUnsafe(header.length + size);
    header.copy(bytes);
    copyLogicalBytes(state.ringBuffer, head, size, bytes.subarray(header.length));
    return { head, bytes };
  }

  private async commitAsync(id: SessionId, bytes: Uint8Array): Promise<void> {
    await mkdir(this.ringsDir, { recursive: true, mode: 0o700 });
    const target = this.ringPathFor(id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, target);
      const owner = this.snapshotOwners.get(bytes);
      // Only mark this head persisted if the ring has not been re-linearized
      // (shrunk/expanded) since the snapshot was captured. Otherwise a shrink's
      // lastFlushedHead reset would be undone here, stranding re-linearized/newer
      // output as "already flushed" and losing it across a restart.
      if (owner && (owner.state.resetSeq ?? 0) === owner.resetSeq) owner.state.lastFlushedHead = owner.head;
      await Promise.all([this.legacyBinPathFor(id), this.legacyMetaPathFor(id)]
        .map((path) => unlink(path).catch(() => {})));
    } finally { await unlink(temporary).catch(() => {}); }
  }

  private async removeAsync(id: SessionId): Promise<void> {
    const writer = this.asyncWriter!;
    await writer.retire(id);
    try {
      await Promise.all([this.ringPathFor(id), this.preShrinkPathFor(id), this.legacyBinPathFor(id), this.legacyMetaPathFor(id)]
        .map((path) => unlink(path).catch(() => {})));
    } finally { writer.release(id); }
  }

  private removeLegacy(id: SessionId): void {
    for (const path of [this.legacyBinPathFor(id), this.legacyMetaPathFor(id)]) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // best-effort
      }
    }
  }

  private ringPathFor(id: SessionId): string {
    return join(this.ringsDir, `${id}.ring`);
  }

  /** Session ids are `[A-Za-z0-9_-]`, so this never collides with a `.ring`. */
  private preShrinkPathFor(id: SessionId): string {
    return join(this.ringsDir, `${id}.pre-shrink.ring`);
  }

  private legacyBinPathFor(id: SessionId): string {
    return join(this.ringsDir, `${id}.bin`);
  }

  private legacyMetaPathFor(id: SessionId): string {
    return join(this.ringsDir, `${id}.meta.json`);
  }
}

function encodeSnapshot(header: Record<string, unknown>, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(JSON.stringify(header), 'utf-8'),
    Buffer.from([RING_SNAPSHOT_MARKER]),
    payload,
  ]);
}

/** Write via a temp file and one rename, so a crash leaves old or new, never torn. */
function writeFileAtomicSync(path: string, bytes: Uint8Array): void {
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    writeFileSync(tmpPath, bytes, { mode: 0o600 });
    renameSync(tmpPath, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try { unlinkSync(tmpPath); } catch { /* best-effort temp cleanup */ }
    }
  }
}

function positiveMod(value: number, mod: number): number {
  const r = value % mod;
  return r < 0 ? r + mod : r;
}

function copyLogicalBytes(ringBuffer: Buffer, head: number, size: number, out: Buffer): void {
  if (size === 0) return;
  const cap = ringBuffer.length;
  const firstLogical = head - size;
  const startSlot = positiveMod(firstLogical, cap);
  const tail = Math.min(size, cap - startSlot);
  ringBuffer.copy(out, 0, startSlot, startSlot + tail);
  if (tail < size) {
    ringBuffer.copy(out, tail, 0, size - tail);
  }
}
