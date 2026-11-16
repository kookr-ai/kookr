/**
 * Live screen models: one headless terminal emulator per session, kept up to
 * date as output arrives (issue #3564, step 2).
 *
 * Step 1 (`streaming-attach-snapshot.ts`) seeds an attach by replaying the
 * retained ring. That fails once the ring itself has lost the base screen —
 * shrunk to 64 KiB by the fleet budget, or wrapped during a long quiet spell
 * of spinner frames — because a differentially rendering agent never repaints
 * it. A model that has seen every byte since the session started still knows
 * the screen, so an attach can be seeded from it instead.
 *
 * This module is the emulator side. It runs inside the live-screen worker
 * thread (`terminal-snapshot-worker-entry.ts`), never on the serving thread:
 * the bytes are untrusted program output, and one control sequence can keep
 * the parser busy for tens of seconds. The host side, which decides which
 * sessions get a model and feeds them, is `terminal-live-screen-models.ts`.
 *
 * Jobs for one model must run one at a time and in order; the worker entry
 * runs every live job through a single queue.
 */

import { performance } from 'node:perf_hooks';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { SerializeAddon } from '@xterm/addon-serialize';
import {
  DEFAULT_SNAPSHOT_SCROLLBACK_ROWS,
  findSnapshotBoundary,
  loadEmulator,
  serializeWithinBudget,
  writeChunk,
} from './streaming-attach-snapshot.js';
import { DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES } from './streaming-attach-seed.js';

/** Scrollback rows each model keeps above its screen: what a seed can carry. */
export const LIVE_SCREEN_SCROLLBACK_ROWS = DEFAULT_SNAPSHOT_SCROLLBACK_ROWS;

/**
 * Largest single write handed to the emulator. xterm grows an internal decode
 * buffer to the largest write it has seen and keeps it: one 1 MiB write costs
 * a model about 0.5 MiB for the rest of its life. Bootstrap rings are cut into
 * slices of this size so every model stays small.
 */
export const LIVE_SCREEN_WRITE_SLICE_BYTES = 16 * 1024;

export type LiveScreenJob =
  /** Start (or restart) a model from the session's current ring, which ends at `end`. */
  | { op: 'reset'; sessionKey: string; epoch: string; end: number; cols: number; rows: number }
  /** Ring bytes `[start, end)` that followed what the model has seen. */
  | { op: 'feed'; sessionKey: string; epoch: string; start: number; end: number; cols: number; rows: number }
  /** Serialize the screen, at the PTY geometry the attach applied. */
  | { op: 'seed'; sessionKey: string; cols: number; rows: number; maxBytes?: number }
  | { op: 'drop'; sessionKey: string };

export type LiveScreenUnavailableReason =
  /** No model exists for the session in this thread (never built, dropped, or the thread restarted). */
  | 'no-model'
  /** A feed did not continue where the model stopped; the model was dropped. */
  | 'desync'
  /** The geometry cannot build a terminal. */
  | 'invalid-geometry'
  /** The emulator packages could not be loaded. */
  | 'load-failed'
  /** The screen alone serialized larger than the hard ceiling. */
  | 'oversized'
  /** The emulator threw. */
  | 'failed';

export type LiveScreenJobResult =
  | { kind: 'done'; elapsedMs: number }
  | {
    kind: 'seed';
    /** Serialized screen and scrollback, then the raw bytes after the last clean parser boundary. */
    bytes: Uint8Array;
    /** Ring source epoch and position the seed represents: live output continues from `end`. */
    epoch: string;
    end: number;
    elapsedMs: number;
  }
  | { kind: 'unavailable'; reason: LiveScreenUnavailableReason; elapsedMs: number };

interface Model {
  terminal: HeadlessTerminal;
  serializer: SerializeAddon;
  epoch: string;
  /** Source position after the last byte received: the emulated bytes plus `tail`. */
  end: number;
  /**
   * Received bytes not yet given to the emulator: everything from the last
   * escape character on (see `findSnapshotBoundary`). Holding them back keeps
   * the parser at rest, so a serialized screen never loses half of a control
   * sequence; a seed sends them raw after the screen.
   */
  tail: Uint8Array;
}

const validGeometry = (cols: number, rows: number): boolean =>
  Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && cols <= 2000 && rows <= 1000;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

export class LiveScreenModelSet {
  private readonly models = new Map<string, Model>();

  get size(): number { return this.models.size; }

  async run(job: LiveScreenJob, bytes: Uint8Array): Promise<LiveScreenJobResult> {
    const startedAt = performance.now();
    const elapsed = () => performance.now() - startedAt;
    const unavailable = (reason: LiveScreenUnavailableReason): LiveScreenJobResult =>
      ({ kind: 'unavailable', reason, elapsedMs: elapsed() });
    try {
      switch (job.op) {
        case 'drop':
          this.drop(job.sessionKey);
          return { kind: 'done', elapsedMs: elapsed() };
        case 'reset': {
          this.drop(job.sessionKey);
          if (!validGeometry(job.cols, job.rows)) return unavailable('invalid-geometry');
          const modules = await loadEmulator();
          if (!modules) return unavailable('load-failed');
          const terminal = new modules.Terminal({
            cols: job.cols, rows: job.rows, scrollback: LIVE_SCREEN_SCROLLBACK_ROWS, allowProposedApi: true, logLevel: 'off',
          });
          const serializer = new modules.SerializeAddon();
          terminal.loadAddon(serializer);
          const model: Model = { terminal, serializer, epoch: job.epoch, end: job.end - bytes.byteLength, tail: new Uint8Array(0) };
          this.models.set(job.sessionKey, model);
          await this.append(model, bytes);
          return { kind: 'done', elapsedMs: elapsed() };
        }
        case 'feed': {
          const model = this.models.get(job.sessionKey);
          if (!model) return unavailable('no-model');
          if (job.start !== model.end || job.end - job.start !== bytes.byteLength) {
            this.drop(job.sessionKey);
            return unavailable('desync');
          }
          if (!this.fitGeometry(model, job.cols, job.rows)) {
            this.drop(job.sessionKey);
            return unavailable('invalid-geometry');
          }
          model.epoch = job.epoch;
          await this.append(model, bytes);
          return { kind: 'done', elapsedMs: elapsed() };
        }
        case 'seed': {
          const model = this.models.get(job.sessionKey);
          if (!model) return unavailable('no-model');
          if (!this.fitGeometry(model, job.cols, job.rows)) return unavailable('invalid-geometry');
          const maxBytes = job.maxBytes && job.maxBytes > 0 ? job.maxBytes : DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES;
          const screen = await serializeWithinBudget(model.serializer, LIVE_SCREEN_SCROLLBACK_ROWS, maxBytes);
          if (!screen) return unavailable('oversized');
          // A fresh buffer the worker can transfer: `screen` may sit in Node's shared pool.
          const seed = new Uint8Array(screen.byteLength + model.tail.byteLength);
          seed.set(screen, 0);
          seed.set(model.tail, screen.byteLength);
          return { kind: 'seed', bytes: seed, epoch: model.epoch, end: model.end, elapsedMs: elapsed() };
        }
      }
    } catch (error) {
      console.error('[terminal-live-screen] model job failed; the session falls back to the ring:', error);
      this.drop(job.sessionKey);
      return unavailable('failed');
    }
  }

  /**
   * Bring the model to the PTY geometry. A resize applies to everything the
   * emulator has parsed so far, which is the order a real terminal sees it in;
   * the held-back tail (at most one unfinished sequence) is parsed after it.
   */
  private fitGeometry(model: Model, cols: number, rows: number): boolean {
    if (!validGeometry(cols, rows)) return false;
    if (model.terminal.cols !== cols || model.terminal.rows !== rows) model.terminal.resize(cols, rows);
    return true;
  }

  private async append(model: Model, bytes: Uint8Array): Promise<void> {
    model.end += bytes.byteLength;
    const pending = concat(model.tail, bytes);
    const boundary = findSnapshotBoundary(pending);
    // Copy the tail: `pending` may be the caller's buffer, or a view of one.
    model.tail = pending.slice(boundary);
    if (boundary === 0) return;
    let last: Promise<void> = Promise.resolve();
    for (let offset = 0; offset < boundary; offset += LIVE_SCREEN_WRITE_SLICE_BYTES) {
      const slice = pending.subarray(offset, Math.min(offset + LIVE_SCREEN_WRITE_SLICE_BYTES, boundary));
      // Queue every slice and wait once: xterm parses queued writes in one loop,
      // and a timer turn per slice would cost more than the parse itself.
      last = writeChunk(model.terminal, slice);
    }
    await last;
  }

  private drop(sessionKey: string): void {
    const model = this.models.get(sessionKey);
    if (!model) return;
    this.models.delete(sessionKey);
    try { model.terminal.dispose(); } catch { /* discarded either way */ }
  }

  dispose(): void {
    for (const key of [...this.models.keys()]) this.drop(key);
  }
}
