/**
 * Screen-snapshot seed for streaming attaches (issue #3564).
 *
 * When a browser opens a terminal pane, the server has to hand it a starting
 * picture before live output can continue. The viewport-first attach (#1934)
 * sent the last 64 KiB of raw PTY bytes for that. That is only a picture of
 * the screen if those bytes repaint the screen from scratch — and agent TUIs
 * such as Claude Code do not. They redraw differentially: each frame moves
 * the cursor relative to where the previous frame left it and rewrites only
 * the cells that changed. A suffix of that stream is a list of edits with
 * nothing to edit. Replayed into an empty terminal, every "cursor up" clamps
 * at the top row and the edits land on a blank screen. A waiting agent emits
 * about 700 bytes of spinner frames per second, so after roughly 90 seconds
 * of waiting the 64 KiB window holds spinner ticks and nothing else.
 *
 * This module builds the seed from what the screen *is* instead: it replays
 * the retained ring through a headless terminal emulator (the same parser the
 * browser's xterm uses) and serializes the resulting screen, cursor, colors
 * and modes. tmux and VS Code's terminal reconnection work the same way.
 *
 * The snapshot is only as good as the bytes it is given. A ring that has
 * itself lost the base screen (wrapped during a very long quiet period, or
 * shrunk by the fleet budget) still replays to an incomplete screen.
 *
 * Every failure here is soft: the caller falls back to the 64 KiB cut, which
 * is the previous behavior.
 */

import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { SerializeAddon } from '@xterm/addon-serialize';
import { DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES } from './streaming-attach-seed.js';

/**
 * Scrollback rows carried in the seed, above the visible screen.
 *
 * Serializing costs time on the shared event loop in proportion to the rows
 * sent (about 3 ms for 200 rows, 15 ms for a full 1 MiB ring's worth). 200 rows
 * is several screens of recent output — more than the 64 KiB byte tail ever
 * held for a differentially rendering agent — and anything older stays
 * reachable through request-history.
 */
const DEFAULT_SNAPSHOT_SCROLLBACK_ROWS = 200;

/**
 * xterm parses one `write()` call as a single synchronous block, and only
 * yields to the event loop between calls. Feeding the ring in slices keeps a
 * full 1 MiB replay from stalling keystroke delivery for other sessions: one
 * slice parses in a few milliseconds. Much smaller slices would not help,
 * because each one also costs a timer round trip before the parser starts.
 */
const EMULATE_CHUNK_BYTES = 64 * 1024;

/**
 * Wall-clock budget for one replay. A full 1 MiB ring takes about 25 ms on an
 * idle machine; the budget only matters when the event loop is saturated. It
 * must stay well under the browser's 5 s wait for the seed.
 */
const DEFAULT_MAX_MS = 1000;

/**
 * A replay that has not finished this long after its budget is treated as
 * dead. xterm parses inside its own timer, so an exception there would never
 * reach this module: the write callback would simply not fire. Without a
 * deadline that replay would hold the single slot forever and every later
 * attach would wait out the queue and then fall back.
 */
const watchdogMs = (maxMs: number): number => maxMs * 2 + 250;

/** How long a caller waits for the single replay slot before falling back. */
const DEFAULT_MAX_QUEUE_WAIT_MS = 750;

/**
 * How far back to look for the escape character that starts the last, possibly
 * unfinished, control sequence. Escape sequences in agent output are far
 * shorter than this.
 */
const BOUNDARY_LOOKBACK_BYTES = 4096;

/**
 * Hard ceiling for a seed that holds the visible screen alone. The scrollback
 * that rides along is trimmed to the caller's byte budget first; this only
 * rejects a screen that is itself implausibly large.
 */
const MAX_SCREEN_ONLY_BYTES = 512 * 1024;

export type StreamingAttachSnapshotUnavailableReason =
  /** Nothing to emulate, or a geometry the emulator cannot be built with. */
  | 'empty'
  | 'invalid-geometry'
  /** The emulator packages could not be loaded in this runtime. */
  | 'load-failed'
  /** Another replay held the slot for longer than the queue wait. */
  | 'busy'
  /** The replay ran past its wall-clock budget. */
  | 'budget-exceeded'
  /** The visible screen alone serialized larger than the hard ceiling. */
  | 'oversized'
  /** The emulator threw while parsing or serializing. */
  | 'failed';

export type StreamingAttachSnapshotResult =
  | {
    kind: 'snapshot';
    /** Serialized screen followed by the raw bytes after the clean boundary. */
    bytes: Uint8Array;
    /** Ring bytes that went through the emulator. */
    emulatedBytes: number;
    /** Ring bytes appended raw after the snapshot (see {@link findSnapshotBoundary}). */
    rawTailBytes: number;
    elapsedMs: number;
  }
  | { kind: 'unavailable'; reason: StreamingAttachSnapshotUnavailableReason; elapsedMs: number };

export interface StreamingAttachSnapshotOptions {
  /** PTY geometry the ring's most recent output was drawn for. */
  cols: number;
  rows: number;
  /**
   * Byte budget for the serialized screen. Scrollback is included only as far
   * as it fits; the visible screen is always sent, even if it alone is larger.
   * Defaults to the streaming viewport budget (64 KiB).
   */
  maxBytes?: number;
  scrollbackRows?: number;
  maxMs?: number;
  maxQueueWaitMs?: number;
  /** Injected monotonic clock (tests). */
  nowMs?: () => number;
}

interface EmulatorModules {
  Terminal: new (options: Record<string, unknown>) => HeadlessTerminal;
  SerializeAddon: new () => SerializeAddon;
}

let emulatorModules: Promise<EmulatorModules | null> | null = null;

/**
 * Load the emulator on first use rather than at server start. Both packages
 * ship CommonJS bundles whose named exports are not visible to every module
 * loader, so the default export is checked too. A load failure must degrade
 * attach to the old seed, never stop the server from booting.
 */
function loadEmulator(): Promise<EmulatorModules | null> {
  emulatorModules ??= (async () => {
    try {
      const headless = await import('@xterm/headless') as unknown as Record<string, unknown>;
      const serialize = await import('@xterm/addon-serialize') as unknown as Record<string, unknown>;
      const pick = (mod: Record<string, unknown>, name: string): unknown =>
        mod[name] ?? (mod.default as Record<string, unknown> | undefined)?.[name];
      const Terminal = pick(headless, 'Terminal');
      const Serialize = pick(serialize, 'SerializeAddon');
      if (typeof Terminal !== 'function' || typeof Serialize !== 'function') {
        throw new Error('terminal emulator exports not found');
      }
      return {
        Terminal: Terminal as EmulatorModules['Terminal'],
        SerializeAddon: Serialize as EmulatorModules['SerializeAddon'],
      };
    } catch (err) {
      console.error('[streaming-attach-snapshot] terminal emulator unavailable; attaches fall back to the byte-tail seed:', err);
      return null;
    }
  })();
  return emulatorModules;
}

/** One replay at a time: the work is CPU on the shared event loop. */
let slotBusy = false;
const slotWaiters: Array<() => void> = [];

function acquireSlot(maxWaitMs: number): Promise<boolean> {
  if (!slotBusy) {
    slotBusy = true;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const grant = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      const index = slotWaiters.indexOf(grant);
      if (index !== -1) slotWaiters.splice(index, 1);
      resolve(false);
    }, maxWaitMs);
    timer.unref?.();
    slotWaiters.push(grant);
  });
}

function releaseSlot(): void {
  const next = slotWaiters.shift();
  if (next) next();
  else slotBusy = false;
}

/**
 * Where to stop emulating so the snapshot is taken with the parser at rest.
 *
 * A serialized screen cannot carry a half-read control sequence. If the ring
 * ends in the middle of one, snapshotting there drops the first half, and the
 * second half then arrives as live output and prints as literal text.
 *
 * An escape character always starts a sequence, so the last one in the ring
 * starts the only sequence that can still be unfinished. Emulation stops just
 * before it; everything from there on is appended to the seed as raw bytes,
 * and the browser's own parser carries any unfinished state into live output.
 *
 * With no escape character in range the ring ends in plain text, and the only
 * thing that can be cut is a multi-byte character.
 */
export function findSnapshotBoundary(bytes: Uint8Array): number {
  const floor = Math.max(0, bytes.length - BOUNDARY_LOOKBACK_BYTES);
  for (let i = bytes.length - 1; i >= floor; i--) {
    if (bytes[i] === 0x1b) return i;
  }
  return bytes.length - incompleteUtf8TailLength(bytes);
}

/** Bytes at the end that begin a UTF-8 character whose remaining bytes are missing. */
function incompleteUtf8TailLength(bytes: Uint8Array): number {
  for (let back = 1; back <= 3 && back <= bytes.length; back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: keep looking for its lead
    const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return expected > back ? back : 0;
  }
  return 0;
}

/**
 * Serialize the visible screen plus as much scrollback as fits in `maxBytes`.
 *
 * The scrollback row count shrinks in proportion to the overshoot (with some
 * margin) until the result fits, so a dense transcript costs a second or
 * third pass rather than one per row. Returns null only when the visible
 * screen alone exceeds the hard ceiling.
 */
async function serializeWithinBudget(
  serializer: SerializeAddon,
  scrollbackRows: number,
  maxBytes: number,
): Promise<Buffer | null> {
  let rows = scrollbackRows;
  for (;;) {
    // Each pass is one synchronous block; let queued keystrokes through first.
    await yieldToEventLoop();
    const screen = Buffer.from(serializer.serialize({ scrollback: rows }), 'utf-8');
    if (screen.length <= maxBytes) return screen;
    if (rows === 0) return screen.length <= MAX_SCREEN_ONLY_BYTES ? screen : null;
    rows = Math.floor(rows * (maxBytes / screen.length) * 0.8);
  }
}

function writeChunk(terminal: HeadlessTerminal, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve) => terminal.write(chunk, resolve));
}

/**
 * Build an attach seed that paints the terminal's current screen.
 *
 * `bytes` is the retained ring in logical order. The result paints correctly
 * into a freshly reset terminal of the same geometry, and live PTY output can
 * follow it directly.
 */
export async function snapshotStreamingAttachSeed(
  bytes: Uint8Array,
  options: StreamingAttachSnapshotOptions,
): Promise<StreamingAttachSnapshotResult> {
  const now = options.nowMs ?? (() => performance.now());
  const startedAt = now();
  const unavailable = (reason: StreamingAttachSnapshotUnavailableReason): StreamingAttachSnapshotResult =>
    ({ kind: 'unavailable', reason, elapsedMs: now() - startedAt });

  if (bytes.length === 0) return unavailable('empty');
  const cols = Math.floor(options.cols);
  const rows = Math.floor(options.rows);
  if (!(cols > 0) || !(rows > 0)) return unavailable('invalid-geometry');

  const modules = await loadEmulator();
  if (!modules) return unavailable('load-failed');

  if (!(await acquireSlot(options.maxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS))) return unavailable('busy');

  const scrollback = Math.max(0, Math.floor(options.scrollbackRows ?? DEFAULT_SNAPSHOT_SCROLLBACK_ROWS));
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES;
  let terminal: HeadlessTerminal | null = null;

  const replay = async (): Promise<StreamingAttachSnapshotResult> => {
    try {
      terminal = new modules.Terminal({ cols, rows, scrollback, allowProposedApi: true });
      const serializer = new modules.SerializeAddon();
      terminal.loadAddon(serializer);

      const boundary = findSnapshotBoundary(bytes);
      for (let offset = 0; offset < boundary; offset += EMULATE_CHUNK_BYTES) {
        await writeChunk(terminal, bytes.subarray(offset, Math.min(offset + EMULATE_CHUNK_BYTES, boundary)));
        if (now() - startedAt > maxMs) return unavailable('budget-exceeded');
      }

      const screen = await serializeWithinBudget(serializer, scrollback, maxBytes);
      if (!screen) return unavailable('oversized');

      const rawTail = bytes.subarray(boundary);
      const seed = new Uint8Array(screen.length + rawTail.length);
      seed.set(screen, 0);
      seed.set(rawTail, screen.length);
      return {
        kind: 'snapshot',
        bytes: seed,
        emulatedBytes: boundary,
        rawTailBytes: rawTail.length,
        elapsedMs: now() - startedAt,
      };
    } catch (err) {
      console.error('[streaming-attach-snapshot] replay failed; attach falls back to the byte-tail seed:', err);
      return unavailable('failed');
    }
  };

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<StreamingAttachSnapshotResult>((resolve) => {
    watchdog = setTimeout(() => {
      console.error('[streaming-attach-snapshot] replay stalled; attach falls back to the byte-tail seed');
      resolve(unavailable('failed'));
    }, watchdogMs(maxMs));
    watchdog.unref?.();
  });
  try {
    return await Promise.race([replay(), stalled]);
  } finally {
    clearTimeout(watchdog);
    // Disposing with input still queued is safe: xterm drains it into the
    // discarded instance. The slot is released exactly once, here.
    try {
      (terminal as HeadlessTerminal | null)?.dispose();
    } catch {
      // The emulator is being discarded either way.
    }
    releaseSlot();
  }
}
