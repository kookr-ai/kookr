/**
 * In-process cache of last successful absolute-TUI seed frames.
 *
 * SessionBridge paints these immediately on browser attach so task switches
 * do not wait for ring capture + VT reconstruct. A cache hit is a small
 * (~2–20 KiB) clean frame, not the full 1 MiB ring.
 *
 * Entries are process-local and intentionally not persisted: a restarted
 * Kookr rebuilds seeds on the next successful attach. Cap size so a long-lived
 * daemon with many historical session ids cannot retain unbounded memory.
 */

import type { SessionId } from '../adapters/terminal-backend.js';

export type TerminalSeedKind = 'absolute-reconstruct' | 'absolute-frame' | 'absolute-snapshot';

export interface TerminalSeedFrame {
  sessionId: SessionId;
  bytes: Uint8Array;
  kind: TerminalSeedKind;
  cols: number;
  rows: number;
  /** Wall-clock ms when this seed was stored. */
  storedAtMs: number;
  /** Byte length of the ring snapshot that produced this seed (staleness signal). */
  sourceRingBytes: number;
}

/** Soft cap: beyond this, oldest entries are dropped on write. */
export const DEFAULT_TERMINAL_SEED_CACHE_MAX_ENTRIES = 64;

/** Reject absurd frames so a corrupt reconstruct cannot pin megabytes. */
export const DEFAULT_TERMINAL_SEED_MAX_BYTES = 256 * 1024;

export interface TerminalSeedFrameCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  nowMs?: () => number;
}

export class TerminalSeedFrameCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly nowMs: () => number;
  private readonly entries = new Map<SessionId, TerminalSeedFrame>();

  constructor(options: TerminalSeedFrameCacheOptions = {}) {
    this.maxEntries = positiveInt(options.maxEntries, DEFAULT_TERMINAL_SEED_CACHE_MAX_ENTRIES);
    this.maxBytes = positiveInt(options.maxBytes, DEFAULT_TERMINAL_SEED_MAX_BYTES);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  get(sessionId: SessionId): TerminalSeedFrame | null {
    return this.entries.get(sessionId) ?? null;
  }

  /**
   * Store a seed. No-ops for empty/oversized payloads. Touches insertion order
   * so repeated updates of the same session count as "recent" under eviction.
   */
  set(
    sessionId: SessionId,
    bytes: Uint8Array,
    meta: {
      kind: TerminalSeedKind;
      cols: number;
      rows: number;
      sourceRingBytes: number;
    },
  ): boolean {
    if (bytes.length === 0 || bytes.length > this.maxBytes) return false;
    if (!Number.isInteger(meta.cols) || meta.cols <= 0) return false;
    if (!Number.isInteger(meta.rows) || meta.rows <= 0) return false;

    // Copy so callers can reuse/mutate the source buffer after set().
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);

    // Re-insert to refresh Map iteration order (LRU-ish eviction).
    if (this.entries.has(sessionId)) this.entries.delete(sessionId);
    this.entries.set(sessionId, {
      sessionId,
      bytes: copy,
      kind: meta.kind,
      cols: meta.cols,
      rows: meta.rows,
      storedAtMs: this.nowMs(),
      sourceRingBytes: Math.max(0, meta.sourceRingBytes | 0),
    });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }

  delete(sessionId: SessionId): void {
    this.entries.delete(sessionId);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

let defaultCache: TerminalSeedFrameCache | undefined;

/** Process-wide seed cache used by SessionBridge. */
export function getTerminalSeedFrameCache(): TerminalSeedFrameCache {
  return (defaultCache ??= new TerminalSeedFrameCache());
}

/** Test seam. */
export function resetTerminalSeedFrameCacheForTests(): void {
  defaultCache = undefined;
}

/** Byte-exact equality for deciding whether a fresh seed should replace a cache hit. */
export function seedFramesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
