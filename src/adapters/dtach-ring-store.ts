import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
const RING_META_VERSION = 1;

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
  state.ringHead = keep;
  // Force a later flush so disk meta matches the (possibly truncated) in-memory
  // view. Full content may already have been persisted by the caller.
  state.lastFlushedHead = -1;
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
  state.ringHead = available;
  state.lastFlushedHead = -1;
  return true;
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
 */
export function enforceRingFleetBudget(
  states: Iterable<DtachRingState>,
  budgetBytes: number,
  idleCapacity: number = RING_IDLE_CAPACITY_BYTES,
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
    if (!shrinkRing(state, floor)) continue;
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
  constructor(private readonly ringsDir: string) {
    mkdirSync(this.ringsDir, { recursive: true, mode: 0o700 });
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
   * Write a ring snapshot in logical order, oldest byte first, using tmp+rename
   * for both data and metadata so a crash cannot leave a partial snapshot that
   * future loads accept.
   */
  persist(state: DtachRingState): void {
    try {
      const head = state.ringHead;
      const cap = state.ringBuffer.length;
      const size = Math.min(head, cap);
      const out = Buffer.alloc(size);
      copyLogicalBytes(state.ringBuffer, head, size, out);

      const binPath = this.ringPathFor(state.id);
      const metaPath = this.metaPathFor(state.id);
      const tmpBin = `${binPath}.${randomUUID()}.tmp`;
      const tmpMeta = `${metaPath}.${randomUUID()}.tmp`;
      writeFileSync(tmpBin, out, { mode: 0o600 });
      writeFileSync(
        tmpMeta,
        JSON.stringify({
          version: RING_META_VERSION,
          size,
          savedAt: new Date().toISOString(),
          lastByteAt: state.lastByteAt,
        }),
        { mode: 0o600 },
      );
      renameSync(tmpBin, binPath);
      renameSync(tmpMeta, metaPath);

      state.lastFlushedHead = head;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[dtach-backend] failed to persist ring for ${state.id}: ${String(err)}`);
    }
  }

  /**
   * Restore a snapshot if both data and metadata exist and agree. Fail-open:
   * malformed snapshots leave the in-memory ring empty instead of preventing
   * the backend from serving the session.
   */
  load(state: DtachRingState): void {
    const binPath = this.ringPathFor(state.id);
    const metaPath = this.metaPathFor(state.id);
    if (!existsSync(binPath) || !existsSync(metaPath)) return;
    try {
      const metaRaw = readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(metaRaw) as { version?: number; size?: number; lastByteAt?: unknown };
      if (meta.version !== RING_META_VERSION) return;
      const buf = readFileSync(binPath);
      if (typeof meta.size !== 'number' || meta.size !== buf.length) return;
      const cap = state.ringBuffer.length;
      const size = Math.min(buf.length, cap);
      if (size === 0) return;
      // Prefer the most recent `size` bytes when the disk snapshot exceeds the
      // current capacity (e.g. a previously-full ring loaded into a test ring).
      const srcOffset = buf.length - size;
      buf.copy(state.ringBuffer, 0, srcOffset, srcOffset + size);
      state.ringHead = size;
      state.lastByteAt = typeof meta.lastByteAt === 'number' && Number.isFinite(meta.lastByteAt)
        ? meta.lastByteAt
        : null;
      state.lastFlushedHead = size;
    } catch {
      // fail-open
    }
  }

  remove(id: SessionId): void {
    for (const path of [this.ringPathFor(id), this.metaPathFor(id)]) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // best-effort
      }
    }
  }

  private ringPathFor(id: SessionId): string {
    return join(this.ringsDir, `${id}.bin`);
  }

  private metaPathFor(id: SessionId): string {
    return join(this.ringsDir, `${id}.meta.json`);
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
