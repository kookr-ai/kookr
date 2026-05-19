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
 */
export const RING_BUFFER_BYTES = 1 * 1024 * 1024;
export const DEFAULT_RING_FLUSH_INTERVAL_MS = 2_000;
const RING_META_VERSION = 1;

export interface DtachRingState {
  id: SessionId;
  /**
   * Counter of bytes ingested into the ring. Monotonically increases for the
   * lifetime of a single backend instance. After a Kookr restart that
   * recovered the session via `load`, this is reset to the persisted byte
   * count; nothing outside the backend depends on the absolute value.
   */
  ringHead: number;
  /** Fixed-size backing store for the ring buffer. */
  ringBuffer: Buffer;
  /**
   * `ringHead` value at the last successful disk flush. `-1` until the first
   * flush completes. Used to skip idle sessions whose ring has not changed.
   */
  lastFlushedHead: number;
}

export function createDtachRingState(id: SessionId): DtachRingState {
  return {
    id,
    ringHead: 0,
    ringBuffer: Buffer.alloc(RING_BUFFER_BYTES),
    lastFlushedHead: -1,
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
    const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let retained = source;
    let firstLogical = state.ringHead;
    if (source.length > RING_BUFFER_BYTES) {
      retained = source.subarray(source.length - RING_BUFFER_BYTES);
      firstLogical += source.length - RING_BUFFER_BYTES;
    }

    const startSlot = firstLogical % RING_BUFFER_BYTES;
    const tail = Math.min(retained.length, RING_BUFFER_BYTES - startSlot);
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
      const size = Math.min(head, RING_BUFFER_BYTES);
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
      const meta = JSON.parse(metaRaw) as { version?: number; size?: number };
      if (meta.version !== RING_META_VERSION) return;
      const buf = readFileSync(binPath);
      if (typeof meta.size !== 'number' || meta.size !== buf.length) return;
      const size = Math.min(buf.length, RING_BUFFER_BYTES);
      if (size === 0) return;
      buf.copy(state.ringBuffer, 0, 0, size);
      state.ringHead = size;
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

function copyLogicalBytes(ringBuffer: Buffer, head: number, size: number, out: Buffer): void {
  if (size === 0) return;
  const firstLogical = head - size;
  const startSlot = firstLogical % RING_BUFFER_BYTES;
  const tail = Math.min(size, RING_BUFFER_BYTES - startSlot);
  ringBuffer.copy(out, 0, startSlot, startSlot + tail);
  if (tail < size) {
    ringBuffer.copy(out, tail, 0, size - tail);
  }
}
