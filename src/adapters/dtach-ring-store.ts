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
      const head = state.ringHead;
      const cap = state.ringBuffer.length;
      const size = Math.min(head, cap);
      const payload = Buffer.alloc(size);
      copyLogicalBytes(state.ringBuffer, head, size, payload);

      const header = Buffer.from(
        JSON.stringify({
          version: RING_META_VERSION_COMBINED,
          size,
          savedAt: new Date().toISOString(),
          lastByteAt: state.lastByteAt,
        }),
        'utf-8',
      );
      const snapshot = Buffer.concat([header, Buffer.from([RING_SNAPSHOT_MARKER]), payload]);

      const ringPath = this.ringPathFor(state.id);
      const tmpPath = `${ringPath}.${randomUUID()}.tmp`;
      let renamed = false;
      try {
        writeFileSync(tmpPath, snapshot, { mode: 0o600 });
        renameSync(tmpPath, ringPath);
        renamed = true;
      } finally {
        if (!renamed) {
          try { unlinkSync(tmpPath); } catch { /* best-effort temp cleanup */ }
        }
      }

      // The combined file is now the authoritative generation; drop any legacy
      // two-file snapshot left over from before the format upgrade so it can no
      // longer shadow or confuse recovery.
      if (renamed) this.removeLegacy(state.id);

      state.lastFlushedHead = head;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[dtach-backend] failed to persist ring for ${state.id}: ${String(err)}`);
    }
  }

  /**
   * Restore a snapshot, preferring the combined single-file format and falling
   * back to the legacy two-file layout. Fail-open: malformed snapshots leave the
   * in-memory ring empty instead of preventing the backend from serving the
   * session.
   */
  load(state: DtachRingState): void {
    if (this.loadCombined(state)) return;
    this.loadLegacy(state);
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
      };
      // A present `.ring` is authoritative even when unreadable: a successful
      // persist removes the legacy pair, so a valid `.ring` is always the newest
      // generation. Returning true (rather than falling back to a legacy pair)
      // is deliberate — the worst case is an empty ring, never resurrected stale
      // scrollback.
      if (meta.version !== RING_META_VERSION_COMBINED) return true;
      const payload = file.subarray(sep + 1);
      if (typeof meta.size !== 'number' || meta.size !== payload.length) return true;
      this.applySnapshot(state, payload, meta.lastByteAt);
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

  remove(id: SessionId): void {
    for (const path of [this.ringPathFor(id), this.legacyBinPathFor(id), this.legacyMetaPathFor(id)]) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // best-effort
      }
    }
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

  private legacyBinPathFor(id: SessionId): string {
    return join(this.ringsDir, `${id}.bin`);
  }

  private legacyMetaPathFor(id: SessionId): string {
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
