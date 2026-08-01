import type { WebSocket } from 'ws';
import {
  type SessionId,
  type TerminalBackend,
  SessionAttachFailedError,
  SessionGoneError,
} from '../adapters/terminal-backend.js';
import {
  asTerminalInputWriterPort,
  type TerminalInputWriterPort,
} from '../core/ports/terminal-input-writer-port.js';
import type { TerminalSessionDataSource } from '../core/ports/terminal-session-stream-port.js';
import { isAbsolutePositionTuiRing } from './absolute-position-tui-ring.js';
import { extractLastSubstantialAbsoluteFrame } from './absolute-position-tui-frame.js';
import { reconstructAbsoluteTuiScreen } from './absolute-position-tui-screen.js';
import { getHotPathSampler } from '../core/hot-path-sampler.js';

/**
 * SessionBridge — per-WS-client view over the backend's byte stream.
 *
 * V8 (rfc-v8-tmux-removal.md) makes the bridge a fan-out view, not an
 * independent owner of the attach:
 *   - on WS open, optionally replay the backend's ring buffer via
 *     `captureBytes` before wiring live updates — unless the ring looks like
 *     a dense absolute-position TUI (Grok Build), in which case we skip the
 *     smashy history and seed one clean frame by reconstructing the VT cell
 *     buffer from the ring (fallback: last sync frame / multi-attach / WINCH);
 *   - subscribe to live bytes via `backend.onData`;
 *   - forward inbound WS frames through the input-writer port and resize via the backend;
 *   - on WS close, unsubscribe.
 *
 * The ring buffer moved to the backend (one owner per session), so every
 * consumer — stuck detection, diagnostics, WS clients — sees the same bytes
 * without a second buffer. Per-WS-client bookkeeping (the unsubscribe
 * function, Enter-detection callbacks) stays here.
 *
 * WebSocket protocol (wire-compatible with the v7 TerminalBridge):
 *   Browser → Server: binary frames (preferred) OR raw text (fallback) OR
 *                     JSON text control frames:
 *                       `{"type":"resize","cols":N,"rows":M}`
 *                       `{"type":"paste","text":"..."}`  (see kookr #356)
 *   Server → Browser: binary frames carrying raw child PTY output.
 */

/**
 * Bracketed-paste markers (xterm DECSET 2004). Wrapping pasted text in these
 * lets an agent TUI distinguish a paste from typed input, so newlines inside
 * the paste are buffered as literal characters instead of submitting a prompt
 * each. Exported for the paste-path tests.
 */
export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

const DEFAULT_OUTPUT_BATCH_MS = 5;
const DEFAULT_BACKPRESSURE_RETRY_MS = 25;
const DEFAULT_BACKPRESSURE_SOFT_BYTES = 1 * 1024 * 1024;
const DEFAULT_VIEWER_BACKPRESSURE_HARD_BYTES = 16 * 1024 * 1024;
const DEFAULT_OWNER_BACKPRESSURE_HARD_BYTES = 64 * 1024 * 1024;
/** Wait for the browser's first FitAddon resize before replaying the ring. */
const DEFAULT_INITIAL_RESIZE_WAIT_MS = 400;
/** Coalesce FitAddon/layout thrash so multi-tab owners do not WINCH-storm the agent. */
const DEFAULT_RESIZE_DEBOUNCE_MS = 80;
/** Pause between cols-1 and cols when forcing a live TUI repaint. */
const DEFAULT_LIVE_REDRAW_NUDGE_MS = 40;
const ON_DATA_SUBSCRIBE_RETRY_DELAYS_MS = [16, 32, 64] as const;

export type RingReplayPolicy = 'auto' | 'full' | 'skip-live-redraw';

interface PreReplayChunk {
  bytes: Buffer;
  countsAsLive: boolean;
  countsAsReplay: boolean;
}

interface TerminalSize {
  cols: number;
  rows: number;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Like {@link readPositiveIntegerEnv} but accepts 0 (used to disable waits in tests). */
function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * dtach's attach client always emits ESC[H ESC[J before replaying its screen.
 * When the reconstructed screen is only sparse differential cells (common for
 * Grok --no-alt-screen), that leading clear leaves the browser blank. Strip
 * only a leading home+clear so any remaining dump still applies.
 */
export function stripLeadingTerminalClear(bytes: Uint8Array): Uint8Array {
  // ESC [ H ESC [ J  or  ESC [ H ESC [ 2 J
  if (bytes.length >= 6
    && bytes[0] === 0x1b && bytes[1] === 0x5b && bytes[2] === 0x48
    && bytes[3] === 0x1b && bytes[4] === 0x5b && bytes[5] === 0x4a) {
    return bytes.subarray(6);
  }
  if (bytes.length >= 7
    && bytes[0] === 0x1b && bytes[1] === 0x5b && bytes[2] === 0x48
    && bytes[3] === 0x1b && bytes[4] === 0x5b && bytes[5] === 0x32 && bytes[6] === 0x4a) {
    return bytes.subarray(7);
  }
  return bytes;
}

/** Construction options for {@link SessionBridge}. */
export interface SessionBridgeOptions {
  /**
   * When true, the bridge is **output-only**: the inbound `ws.on('message')`
   * handler is never registered, so no keystroke, resize, or paste frame can
   * reach the PTY (kookr #807, read-only shared view). Read-only is enforced
   * here — by not wiring the write path at all — rather than by omitting the
   * `onInput`/`onAnyKeystroke` activity callbacks, which are notifications and
   * not the write path. The output replay + `onData` stream still wire, so a
   * read-only viewer keeps receiving PTY output. Default: false (owner).
   */
  readOnly?: boolean;

  /** Live PTY output coalescing window. Defaults to `KOOKR_SESSION_BRIDGE_OUTPUT_BATCH_MS` or 5 ms. */
  outputBatchMs?: number;

  /** Retry cadence while `ws.bufferedAmount` is over the soft threshold. */
  backpressureRetryMs?: number;

  /** Above this `ws.bufferedAmount`, live output stays queued instead of sending. */
  backpressureSoftBytes?: number;

  /** Hard queued+buffered ceiling for owner bridges. */
  ownerBackpressureHardBytes?: number;

  /** Hard queued+buffered ceiling for read-only viewer bridges. */
  viewerBackpressureHardBytes?: number;

  /**
   * How to handle ring-buffer replay on connect:
   * - `auto` (default): skip + live WINCH redraw when the ring looks like a
   *   dense absolute-position TUI (Grok); otherwise full replay.
   * - `full`: always replay `captureBytes` (legacy behaviour).
   * - `skip-live-redraw`: never replay; always nudge a live redraw when the
   *   bridge is writable.
   */
  ringReplay?: RingReplayPolicy;

  /**
   * Milliseconds to wait for the browser's first `resize` control frame before
   * deciding on ring replay. Defaults to
   * `KOOKR_SESSION_BRIDGE_INITIAL_RESIZE_WAIT_MS` or 400. Set to 0 in unit tests.
   */
  initialResizeWaitMs?: number;

  /**
   * Coalesce subsequent resize control frames. Defaults to
   * `KOOKR_SESSION_BRIDGE_RESIZE_DEBOUNCE_MS` or 80. Set to 0 to apply immediately.
   */
  resizeDebounceMs?: number;

  /** Pause between the two WINCH steps of a live-redraw nudge. */
  liveRedrawNudgeMs?: number;

  /** Cross-signal browser bridge lifecycle hooks. Replay and live bytes are tracked separately. */
  onBridgeOpened?: (sessionId: SessionId) => void;
  onBridgeReplay?: (sessionId: SessionId) => void;
  onBridgeLiveBytes?: (sessionId: SessionId) => void;
  onBridgeClosed?: (sessionId: SessionId) => void;
}

export class SessionBridge {
  private unsubscribeData: (() => void) | null = null;
  private closed = false;
  private pendingOutputChunks: Buffer[] = [];
  private pendingOutputBytes = 0;
  private pendingOutputHasLiveBytes = false;
  private pendingOutputHasReplayBytes = false;
  private outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly sessionId: SessionId;
  private readonly ws: WebSocket;
  private readonly backend: TerminalBackend;
  private readonly inputWriter: TerminalInputWriterPort;
  private readonly onInput?: (sessionId: SessionId) => void;
  private readonly onAnyKeystroke?: (sessionId: SessionId) => void;
  private readonly readOnly: boolean;
  private readonly outputBatchMs: number;
  private readonly backpressureRetryMs: number;
  private readonly backpressureSoftBytes: number;
  private readonly backpressureHardBytes: number;
  private readonly onBridgeOpened?: (sessionId: SessionId) => void;
  private readonly onBridgeReplay?: (sessionId: SessionId) => void;
  private readonly onBridgeLiveBytes?: (sessionId: SessionId) => void;
  private readonly onBridgeClosed?: (sessionId: SessionId) => void;
  private readonly ringReplayPolicy: RingReplayPolicy;
  private readonly initialResizeWaitMs: number;
  private readonly resizeDebounceMs: number;
  private readonly liveRedrawNudgeMs: number;
  private bridgeHealthStarted = false;
  /** Latest browser-reported size observed before startup settles. */
  private pendingInitialResize: TerminalSize | null = null;
  private initialResizeResolver: (() => void) | null = null;
  /** After startup, further resizes are debounced. */
  private startupComplete = false;
  private inboundWired = false;
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debouncedResize: TerminalSize | null = null;
  private lastAppliedResize: TerminalSize | null = null;

  constructor(
    sessionId: SessionId,
    ws: WebSocket,
    backend: TerminalBackend,
    inputWriterOrOnInput?: TerminalInputWriterPort | ((sessionId: SessionId) => void),
    onInputOrAnyKeystroke?: (sessionId: SessionId) => void,
    onAnyKeystroke?: (sessionId: SessionId) => void,
    options?: SessionBridgeOptions,
  ) {
    this.sessionId = sessionId;
    this.ws = ws;
    this.backend = backend;
    this.onBridgeOpened = options?.onBridgeOpened;
    this.onBridgeReplay = options?.onBridgeReplay;
    this.onBridgeLiveBytes = options?.onBridgeLiveBytes;
    this.onBridgeClosed = options?.onBridgeClosed;
    this.readOnly = options?.readOnly ?? false;
    this.ringReplayPolicy = options?.ringReplay ?? 'auto';
    this.initialResizeWaitMs = options?.initialResizeWaitMs
      ?? readNonNegativeIntegerEnv(
        'KOOKR_SESSION_BRIDGE_INITIAL_RESIZE_WAIT_MS',
        DEFAULT_INITIAL_RESIZE_WAIT_MS,
      );
    this.resizeDebounceMs = options?.resizeDebounceMs
      ?? readNonNegativeIntegerEnv(
        'KOOKR_SESSION_BRIDGE_RESIZE_DEBOUNCE_MS',
        DEFAULT_RESIZE_DEBOUNCE_MS,
      );
    this.liveRedrawNudgeMs = options?.liveRedrawNudgeMs
      ?? readNonNegativeIntegerEnv(
        'KOOKR_SESSION_BRIDGE_LIVE_REDRAW_NUDGE_MS',
        DEFAULT_LIVE_REDRAW_NUDGE_MS,
      );
    this.outputBatchMs = options?.outputBatchMs
      ?? readPositiveIntegerEnv('KOOKR_SESSION_BRIDGE_OUTPUT_BATCH_MS', DEFAULT_OUTPUT_BATCH_MS);
    this.backpressureRetryMs = options?.backpressureRetryMs
      ?? readPositiveIntegerEnv('KOOKR_SESSION_BRIDGE_BACKPRESSURE_RETRY_MS', DEFAULT_BACKPRESSURE_RETRY_MS);
    this.backpressureSoftBytes = options?.backpressureSoftBytes
      ?? readPositiveIntegerEnv(
        'KOOKR_SESSION_BRIDGE_BACKPRESSURE_SOFT_BYTES',
        DEFAULT_BACKPRESSURE_SOFT_BYTES,
      );
    const ownerHardBytes = options?.ownerBackpressureHardBytes
      ?? readPositiveIntegerEnv(
        'KOOKR_SESSION_BRIDGE_OWNER_BACKPRESSURE_HARD_BYTES',
        DEFAULT_OWNER_BACKPRESSURE_HARD_BYTES,
      );
    const viewerHardBytes = options?.viewerBackpressureHardBytes
      ?? readPositiveIntegerEnv(
        'KOOKR_SESSION_BRIDGE_VIEWER_BACKPRESSURE_HARD_BYTES',
        DEFAULT_VIEWER_BACKPRESSURE_HARD_BYTES,
      );
    this.backpressureHardBytes = this.readOnly ? viewerHardBytes : ownerHardBytes;
    if (inputWriterOrOnInput && typeof inputWriterOrOnInput === 'object' && 'writeInput' in inputWriterOrOnInput) {
      this.inputWriter = inputWriterOrOnInput;
      this.onInput = onInputOrAnyKeystroke;
      this.onAnyKeystroke = onAnyKeystroke;
    } else {
      this.inputWriter = asTerminalInputWriterPort(backend);
      this.onInput = inputWriterOrOnInput as ((sessionId: SessionId) => void) | undefined;
      this.onAnyKeystroke = onInputOrAnyKeystroke;
    }
  }

  async start(_cols = 120, _rows = 40): Promise<void> {
    this.onBridgeOpened?.(this.sessionId);
    this.bridgeHealthStarted = true;
    // Install the ws 'error' listener FIRST — before any awaits or safeSend
    // calls. Without this, a socket fault during the initial replay window
    // hits EventEmitter's no-listener path and re-raises as
    // uncaughtException. Must be the first thing we do.
    this.ws.on('error', (err) => {
      console.error(`[session-bridge] ws error for ${this.sessionId}:`, err);
      this.closeBridgeForFailure('ws error');
    });
    this.ws.on('close', () => {
      try {
        this.dispose();
      } catch (err) {
        console.error(`[session-bridge] dispose failed for ${this.sessionId}:`, err);
      }
    });

    // Owner bridges accept resize before ring replay so the browser FitAddon
    // size lands first. Read-only viewers never resize the shared PTY (#807).
    if (!this.readOnly) {
      this.wireInboundHandler();
    }

    // Subscribe before replay capture so bytes emitted while we are opening the
    // bridge are either in the replay snapshot or in the local pre-replay
    // buffer. `onData` itself has no history, so capture-after-subscribe closes
    // the retry/backoff gap without adding a second backend subscription.
    const preReplayChunks: PreReplayChunk[] = [];
    let preReplayBytes = 0;
    let replaySent = false;
    const subscribed = await this.subscribeToDataWithRetry((
      bytes: Uint8Array,
      source?: TerminalSessionDataSource,
    ) => {
      if (!replaySent) {
        const projectedBytes = this.getBufferedAmount() + preReplayBytes + bytes.length;
        if (projectedBytes > this.backpressureHardBytes) {
          this.closeBridgeForFailure(
            `terminal output backpressure exceeded (${projectedBytes} bytes queued before replay)`,
          );
          return;
        }
        preReplayChunks.push({
          bytes: Buffer.from(bytes),
          countsAsLive: source !== 'attach-replay',
          countsAsReplay: source === 'attach-replay',
        });
        preReplayBytes += bytes.length;
        return;
      }
      this.enqueueOutput(bytes, source !== 'attach-replay', source === 'attach-replay');
    });
    if (!subscribed) {
      return;
    }

    // Prefer the browser's FitAddon size before replaying absolute-position
    // history. Without this, a 200-col Grok ring paints into a ~100-col xterm.
    await this.waitForInitialResize();
    if (this.closed) return;
    // Apply the latest pending size (may have been updated after the wait woke).
    this.applyPendingInitialResizeIfAny();

    // The backend owns the single ring buffer; this bridge is a stateless
    // view. `captureBytes` is lock-free and does not force a re-attach.
    let captured: Uint8Array;
    try {
      captured = await this.backend.captureBytes(this.sessionId);
    } catch (err) {
      if (this.isBackendSessionFailure(err)) {
        this.closeBridgeForFailure(`session ${this.sessionId} is gone`);
        return;
      }
      // Unknown failure mode — still don't let it escape to the process.
      // `start()` is called as `bridge.start().catch(log)` in the server,
      // so a throw only leaks to the caller, not to unhandledRejection.
      // Closing the bridge keeps the ws off as well.
      console.error(`[session-bridge] captureBytes failed for ${this.sessionId}:`, err);
      this.closeBridgeForFailure('captureBytes failed');
      return;
    }

    // The WS may close while captureBytes awaits; in that case dispose() has
    // already removed the subscriber and there is no client left to replay to.
    if (this.closed) return;

    // A late FitAddon frame may have arrived during capture — re-apply before
    // deciding on ring replay / live redraw so nudge uses the freshest size.
    this.applyPendingInitialResizeIfAny();

    const skipRingReplay = this.shouldSkipRingReplay(captured);
    let replay: Uint8Array = new Uint8Array(0);
    if (skipRingReplay) {
      // Dense absolute-position TUIs (Grok Build): replaying the *entire* ring
      // paints thousands of historical CUP frames at mixed widths. Instead:
      //
      //   0. Reconstruct the current screen by replaying the ring into a VT
      //      cell buffer (Grok paints differentially — last-sync-frame alone
      //      leaves missing letters; multi-attach is often empty for idle
      //      --no-alt-screen sessions). Browser xterm is pinned to ~200 cols.
      //   1. Fall back: last substantial DECSET-2026 sync frame
      //   2. Fall back: multi-attach + Ctrl+L (only when reconstruction failed)
      //   3. reconnectTransport / WINCH last resort
      //
      // When reconstruction succeeds we deliberately skip Ctrl+L: the live
      // repaint after a clear is sparse and would wipe the reconstructed seed.
      //
      // Read-only viewers never resize/snapshot/reconnect the shared PTY
      // (#807); they still get the reconstructed frame and live fan-out.
      const size = this.pendingInitialResize ?? this.lastAppliedResize;
      const seedCols = size?.cols && size.cols > 0 ? size.cols : 200;
      const seedRows = size?.rows && size.rows > 0 ? size.rows : 50;
      // Hot-path ranking (issue #1781): VT reconstruct is the terminal-lag
      // suspect the endpoint exists to rank. Timed via the sampler's O(1) wrapper.
      const reconstructed = getHotPathSampler().time('vt_reconstruct', () =>
        reconstructAbsoluteTuiScreen(captured, {
          cols: seedCols,
          rows: seedRows,
        }),
      );
      if (reconstructed && reconstructed.length > 0) {
        replay = reconstructed;
      } else {
        const ringFrame = extractLastSubstantialAbsoluteFrame(captured);
        if (ringFrame && ringFrame.length > 0) {
          replay = ringFrame;
        }
      }
      if (!this.readOnly) {
        if (size) {
          // Keep PTY size aligned for subsequent live paints even when we skip
          // the Ctrl+L refresh path.
          this.applyResizeNow(size.cols, size.rows);
          // Only force live refresh when we have no usable seed — Ctrl+L after
          // a good reconstruction often clears the browser and leaves spinner
          // differentials only.
          if (replay.length === 0) {
            const frame = await this.refreshAbsoluteTuiFrame(size);
            if (frame && frame.length > 0) {
              replay = frame;
            }
          }
        } else if (replay.length === 0) {
          console.warn(
            `[session-bridge] skipped absolute-TUI ring for ${this.sessionId} without a browser size; waiting for live frames`,
          );
        }
      }
      if (this.closed) return;
      if (replay.length > 0) {
        if (this.safeSend(Buffer.from(replay), true)) {
          this.onBridgeReplay?.(this.sessionId);
        }
      }
    } else {
      replay = captured;
      if (replay.length > 0) {
        if (this.safeSend(Buffer.from(replay), true)) {
          this.onBridgeReplay?.(this.sessionId);
        }
      }
    }

    replaySent = true;
    this.startupComplete = true;
    const bufferedPreReplay = this.removeReplayOverlap(replay, preReplayChunks);
    for (const chunk of bufferedPreReplay) {
      this.enqueueOutput(chunk.bytes, chunk.countsAsLive, chunk.countsAsReplay);
    }
  }

  /**
   * Register the inbound `ws.on('message')` write path: keystrokes, resize, and
   * paste control frames all flow to the PTY here. Only owner (writable) bridges
   * call this; read-only viewer bridges skip it entirely (#807).
   */
  private wireInboundHandler(): void {
    if (this.inboundWired) return;
    this.inboundWired = true;
    this.ws.on('message', (data, isBinary) => {
      if (this.closed) return;

      // Binary frames: PTY input, verbatim. Byte-transparent.
      if (isBinary && Buffer.isBuffer(data)) {
        const bytes = new Uint8Array(data);
        this.safeForwardWrite(bytes);
        this.notifyInput(bytes);
        return;
      }

      // Text frames: control JSON (resize, paste) or raw keystroke text.
      // Control frames are JSON with a `type` field so they can't collide
      // with ordinary keystrokes.
      const text = data.toString();
      if (text.startsWith('{') && text.includes('"type"')) {
        try {
          const parsed = JSON.parse(text);
          if (parsed.type === 'resize') {
            if (
              Number.isInteger(parsed.cols)
              && parsed.cols > 0
              && Number.isInteger(parsed.rows)
              && parsed.rows > 0
            ) {
              this.handleResizeControl(parsed.cols, parsed.rows);
            }
            return;
          }
          if (parsed.type === 'paste') {
            // A `paste` frame is always a control frame, never stdin — drop
            // it silently when `text` is missing rather than leaking the
            // raw JSON to the PTY.
            if (typeof parsed.text === 'string') {
              this.forwardPaste(parsed.text);
            }
            return;
          }
        } catch {
          // Not a control frame — fall through as keystroke text.
        }
      }
      const bytes = new TextEncoder().encode(text);
      this.safeForwardWrite(bytes);
      this.notifyInput(bytes);
    });
  }

  private shouldSkipRingReplay(captured: Uint8Array): boolean {
    if (this.ringReplayPolicy === 'skip-live-redraw') return true;
    if (this.ringReplayPolicy === 'full') return false;
    return isAbsolutePositionTuiRing(captured);
  }

  private waitForInitialResize(): Promise<TerminalSize | null> {
    if (this.pendingInitialResize) return Promise.resolve(this.pendingInitialResize);
    if (this.initialResizeWaitMs <= 0 || this.readOnly) {
      return Promise.resolve(this.pendingInitialResize);
    }
    return new Promise((resolve) => {
      const finish = () => {
        if (timer) clearTimeout(timer);
        this.initialResizeResolver = null;
        resolve(this.pendingInitialResize);
      };
      this.initialResizeResolver = finish;
      const timer = setTimeout(finish, this.initialResizeWaitMs);
    });
  }

  private handleResizeControl(cols: number, rows: number): void {
    // Always remember the latest browser size for the startup path.
    this.pendingInitialResize = { cols, rows };
    if (!this.startupComplete) {
      // Unblock waitForInitialResize. Apply immediately so a late FitAddon
      // frame during capture/nudge is not dropped when no size was applied yet
      // (e.g. the wait timed out with no earlier resize).
      this.initialResizeResolver?.();
      this.initialResizeResolver = null;
      this.applyResizeNow(cols, rows);
      return;
    }
    this.scheduleDebouncedResize(cols, rows);
  }

  /** Apply `pendingInitialResize` if present and different from last applied. */
  private applyPendingInitialResizeIfAny(): void {
    if (this.readOnly || !this.pendingInitialResize) return;
    this.applyResizeNow(this.pendingInitialResize.cols, this.pendingInitialResize.rows);
  }

  private scheduleDebouncedResize(cols: number, rows: number): void {
    if (
      this.lastAppliedResize
      && this.lastAppliedResize.cols === cols
      && this.lastAppliedResize.rows === rows
    ) {
      return;
    }
    this.debouncedResize = { cols, rows };
    if (this.resizeDebounceMs <= 0) {
      this.flushDebouncedResize();
      return;
    }
    if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer);
    this.resizeDebounceTimer = setTimeout(() => {
      this.resizeDebounceTimer = null;
      this.flushDebouncedResize();
    }, this.resizeDebounceMs);
  }

  private flushDebouncedResize(): void {
    const next = this.debouncedResize;
    this.debouncedResize = null;
    if (!next || this.closed) return;
    this.applyResizeNow(next.cols, next.rows);
  }

  private applyResizeNow(cols: number, rows: number): void {
    if (
      this.lastAppliedResize
      && this.lastAppliedResize.cols === cols
      && this.lastAppliedResize.rows === rows
    ) {
      return;
    }
    this.lastAppliedResize = { cols, rows };
    this.safeForwardResize(cols, rows);
  }

  /**
   * Recover a readable frame after skipping absolute-TUI ring history.
   * 1. Apply the browser size (WINCH the agent so subsequent live paints match).
   * 2. Prefer `captureCurrentFrame` — temporary secondary dtach attach.
   * 3. Force a full TUI repaint via Ctrl+L and wait briefly so live paint
   *    lands in preReplayChunks — attach-replay alone is often only sparse
   *    differential cells after dtach's leading ESC[H ESC[J clear under
   *    Grok's --no-alt-screen differential painting.
   * 4. Fall back to `reconnectTransport` (primary attach recycle; rate-limited).
   * 5. Last resort: cols±1 WINCH nudge when both are missing/empty/capped.
   *
   * @returns Snapshot bytes to send as the client's initial frame, or null
   *   when recovery relied on reconnect attach-replay / live bytes instead.
   */
  private async refreshAbsoluteTuiFrame(size: TerminalSize): Promise<Uint8Array | null> {
    if (this.closed) return null;
    this.applyResizeNow(size.cols, size.rows);

    let snapshot: Uint8Array | null = null;
    const captureFrame = this.backend.captureCurrentFrame?.bind(this.backend);
    if (captureFrame) {
      try {
        const frame = await captureFrame(this.sessionId, {
          cols: size.cols,
          rows: size.rows,
          // Match the reconnect liveness floor so a slow Grok dump still lands.
          timeoutMs: Math.max(800, this.liveRedrawNudgeMs * 10 || 800),
        });
        if (frame.length > 0) {
          // Strip dtach attach's leading clear so a sparse dump after ESC[H ESC[J]
          // does not wipe a browser that already has useful cells.
          snapshot = stripLeadingTerminalClear(frame);
        } else {
          console.warn(
            `[session-bridge] absolute-TUI frame snapshot for ${this.sessionId} was empty; forcing live repaint`,
          );
        }
      } catch (err) {
        console.warn(
          `[session-bridge] absolute-TUI frame snapshot failed for ${this.sessionId}; forcing live repaint:`,
          err,
        );
      }
    }

    // Ctrl+L: full repaint for TUIs that honor it (and for dtach -r winch
    // redraw paths). Live bytes fan into preReplayChunks while we wait.
    // liveRedrawNudgeMs === 0 skips the wait in unit tests.
    this.safeForwardWrite(new Uint8Array([0x0c]));
    if (this.liveRedrawNudgeMs > 0) {
      await this.sleep(Math.max(450, this.liveRedrawNudgeMs * 12));
    }
    if (this.closed) return snapshot;

    // Anything beyond a bare clear/home is worth painting; live Ctrl+L bytes
    // still flush via preReplayChunks regardless.
    if (snapshot && snapshot.length > 16) {
      return snapshot;
    }

    const reconnect = this.backend.reconnectTransport?.bind(this.backend);
    if (reconnect) {
      try {
        const result = await reconnect(this.sessionId, {
          reason: 'absolute-tui-frame-refresh',
          // dtach attach-replay of a full Grok frame can take hundreds of ms;
          // a 200ms window was timing out as inconclusive and dropping content.
          livenessTimeoutMs: Math.max(800, this.liveRedrawNudgeMs * 10 || 800),
          actor: 'session-bridge',
        });
        if (result.outcome === 'success' || result.outcome === 'inconclusive') {
          // Attach-replay / live bytes fan out via onData into preReplayChunks
          // (before replaySent) or enqueueOutput (after).
          return snapshot;
        }
        console.warn(
          `[session-bridge] absolute-TUI reconnect for ${this.sessionId} was ${result.outcome}/${result.reason}; falling back to WINCH nudge`,
        );
      } catch (err) {
        console.warn(
          `[session-bridge] absolute-TUI reconnect failed for ${this.sessionId}; falling back to WINCH nudge:`,
          err,
        );
      }
    }

    await this.nudgeLiveRedraw(size.cols, size.rows);
    return snapshot;
  }

  /**
   * Toggle the PTY size by one column so absolute-position TUIs (Grok, Ink)
   * repaint the live viewport after we skipped historical ring replay.
   * No-ops when the bridge is closed or size is degenerate.
   */
  private async nudgeLiveRedraw(cols: number, rows: number): Promise<void> {
    if (this.closed || cols < 2 || rows < 1) return;
    this.applyResizeNow(cols - 1, rows);
    if (this.liveRedrawNudgeMs > 0) {
      await this.sleep(this.liveRedrawNudgeMs);
    }
    if (this.closed) return;
    this.applyResizeNow(cols, rows);
  }

  /**
   * Send a buffer to the WS, contained. ws.send throws synchronously on some
   * socket states; a throw from the onData callback (or the initial replay)
   * would otherwise propagate up to the backend's subscriber loop or to
   * `start()`'s caller. We handle it locally and close the bridge.
   */
  private safeSend(payload: Buffer, enforceBackpressure = false): boolean {
    if (this.ws.readyState !== this.ws.OPEN) return false;
    if (enforceBackpressure) {
      const projectedBufferedBytes = this.getBufferedAmount() + payload.length;
      if (projectedBufferedBytes > this.backpressureHardBytes) {
        this.closeBridgeForFailure(
          `terminal output backpressure exceeded (${projectedBufferedBytes} bytes in replay)`,
        );
        return false;
      }
    }
    try {
      this.ws.send(payload);
      return true;
    } catch (err) {
      console.error(`[session-bridge] ws.send failed for ${this.sessionId}:`, err);
      this.closeBridgeForFailure('ws.send failed');
      return false;
    }
  }

  private async subscribeToDataWithRetry(
    onBytes: (bytes: Uint8Array, source?: TerminalSessionDataSource) => void,
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= ON_DATA_SUBSCRIBE_RETRY_DELAYS_MS.length; attempt++) {
      // A client can disconnect while a retry backoff is sleeping; stop
      // before registering a backend subscriber with no live WS owner.
      if (this.closed) return false;
      try {
        this.unsubscribeData = this.backend.onData(this.sessionId, (
          bytes: Uint8Array,
          source?: TerminalSessionDataSource,
        ) => {
          onBytes(bytes, source);
        });
        return true;
      } catch (err) {
        this.unsubscribeData = null;
        if (this.isBackendSessionFailure(err)) {
          this.closeBridgeForFailure(`session ${this.sessionId} is gone`);
          return false;
        }
        const delayMs = ON_DATA_SUBSCRIBE_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined) {
          console.error(`[session-bridge] onData subscribe failed for ${this.sessionId}:`, err);
          this.closeBridgeForFailure('onData subscribe failed');
          return false;
        }
        console.warn(
          `[session-bridge] onData subscribe failed for ${this.sessionId}; retrying in ${delayMs}ms:`,
          err,
        );
        await this.sleep(delayMs);
      }
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private removeReplayOverlap(replay: Uint8Array, chunks: PreReplayChunk[]): PreReplayChunk[] {
    if (chunks.length === 0) return [];
    const buffered = chunks.length === 1
      ? chunks[0].bytes
      : Buffer.concat(chunks.map((chunk) => chunk.bytes));
    // Bytes emitted after subscribe but before capture returns can be present
    // in both places: at the replay snapshot's suffix and the live buffer's
    // prefix. Trim that shared prefix so startup neither drops nor duplicates
    // terminal output.
    const overlap = this.findSuffixPrefixOverlap(replay, buffered);
    if (overlap >= buffered.length) return [];

    let skip = overlap;
    const remaining: PreReplayChunk[] = [];
    for (const chunk of chunks) {
      if (skip >= chunk.bytes.length) {
        skip -= chunk.bytes.length;
        continue;
      }
      remaining.push({
        bytes: chunk.bytes.subarray(skip),
        countsAsLive: chunk.countsAsLive,
        countsAsReplay: chunk.countsAsReplay,
      });
      skip = 0;
    }
    return remaining;
  }

  private findSuffixPrefixOverlap(suffixSource: Uint8Array, prefixSource: Uint8Array): number {
    const maxOverlap = Math.min(suffixSource.length, prefixSource.length);
    for (let length = maxOverlap; length > 0; length--) {
      let matched = true;
      const suffixStart = suffixSource.length - length;
      for (let i = 0; i < length; i++) {
        if (suffixSource[suffixStart + i] !== prefixSource[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return length;
    }
    return 0;
  }

  /**
   * Live PTY output can arrive as a fire-hose of tiny chunks. Queue it briefly
   * so each bridge sends fewer binary frames, and isolate slow sockets with a
   * per-bridge backpressure policy instead of pushing on the shared backend
   * stream.
   */
  private enqueueOutput(bytes: Uint8Array, countsAsLive = true, countsAsReplay = false): void {
    if (this.closed || bytes.length === 0) return;
    const projectedBufferedBytes = this.getBufferedAmount() + this.pendingOutputBytes + bytes.length;
    if (projectedBufferedBytes > this.backpressureHardBytes) {
      this.closeBridgeForFailure(
        `terminal output backpressure exceeded (${projectedBufferedBytes} bytes queued)`,
      );
      return;
    }
    this.pendingOutputChunks.push(Buffer.from(bytes));
    this.pendingOutputBytes += bytes.length;
    this.pendingOutputHasLiveBytes ||= countsAsLive;
    this.pendingOutputHasReplayBytes ||= countsAsReplay;
    this.scheduleOutputFlush(this.outputBatchMs);
  }

  private scheduleOutputFlush(delayMs: number): void {
    if (this.closed || this.outputFlushTimer) return;
    this.outputFlushTimer = setTimeout(() => {
      this.outputFlushTimer = null;
      this.flushOutput();
    }, delayMs);
  }

  private flushOutput(): void {
    if (this.closed || this.pendingOutputBytes === 0) return;
    if (this.ws.readyState !== this.ws.OPEN) return;

    const bufferedAmount = this.getBufferedAmount();
    const projectedBufferedBytes = bufferedAmount + this.pendingOutputBytes;
    if (projectedBufferedBytes > this.backpressureHardBytes) {
      this.closeBridgeForFailure(
        `terminal output backpressure exceeded (${projectedBufferedBytes} bytes queued)`,
      );
      return;
    }

    if (bufferedAmount > this.backpressureSoftBytes) {
      this.scheduleOutputFlush(this.backpressureRetryMs);
      return;
    }

    const payload = this.pendingOutputChunks.length === 1
      ? this.pendingOutputChunks[0]
      : Buffer.concat(this.pendingOutputChunks, this.pendingOutputBytes);
    const hasLiveBytes = this.pendingOutputHasLiveBytes;
    const hasReplayBytes = this.pendingOutputHasReplayBytes;
    this.pendingOutputChunks = [];
    this.pendingOutputBytes = 0;
    this.pendingOutputHasLiveBytes = false;
    this.pendingOutputHasReplayBytes = false;
    if (this.safeSend(payload)) {
      if (hasReplayBytes) this.onBridgeReplay?.(this.sessionId);
      if (hasLiveBytes) this.onBridgeLiveBytes?.(this.sessionId);
    }
  }

  private getBufferedAmount(): number {
    const bufferedAmount = (this.ws as WebSocket & { bufferedAmount?: number }).bufferedAmount;
    return typeof bufferedAmount === 'number' && Number.isFinite(bufferedAmount)
      ? Math.max(0, bufferedAmount)
      : 0;
  }

  /**
   * Fire-and-forget backend.write with its rejection contained. Pre-fix this
   * path was `void this.backend.write(...)` — a rejecting promise escaped as
   * an unhandledRejection, which in Node 15+ terminates the process by
   * default. SessionGoneError / SessionAttachFailedError / WriteTimeoutError
   * all land here; each one retires this bridge rather than crashing the
   * server.
   */
  private safeForwardWrite(bytes: Uint8Array): void {
    if (this.closed) return;
    this.inputWriter.writeInput(this.sessionId, bytes, { reason: 'browser-terminal-input' }).catch((err: unknown) => {
      this.handleBackendRejection(err, 'write');
    });
  }

  /** Same contract as safeForwardWrite but for resize. */
  private safeForwardResize(cols: number, rows: number): void {
    if (this.closed) return;
    this.backend.resize(this.sessionId, cols, rows).catch((err: unknown) => {
      this.handleBackendRejection(err, 'resize');
    });
  }

  /**
   * Forward a browser paste as one bracketed-paste write.
   *
   * The frontend routes multiline / large pastes here (TerminalPanel,
   * kookr #356) instead of letting xterm.js stream raw bytes: streamed raw,
   * every newline in the paste makes the agent TUI submit a prompt, so one
   * pasted JSON blob becomes dozens of prompts.
   *
   * Wrapping the text in DECSET-2004 markers tells the agent TUI "this is one
   * paste" — newlines land as literal characters in its input buffer and the
   * user submits once. The markers are honored by the *child PTY*, which
   * enabled bracketed-paste mode itself; they do not depend on this server
   * (or a late-connecting browser's xterm, whose replay buffer may have
   * wrapped past the child's original DECSET) still tracking that mode.
   *
   * A paste is deliberately not a submit: `onAnyKeystroke` fires (the activity
   * is real) but `onInput` does not — the user still presses Enter separately.
   * Running `notifyInput`'s CR/LF scan over the wrapped bytes would misfire
   * `onInput` for every newline in the blob.
   */
  private forwardPaste(text: string): void {
    if (this.closed) return;
    // Strip embedded paste markers so pasted content cannot break out of the
    // bracketed-paste envelope (the classic bracketed-paste injection).
    const sanitized = text
      .replaceAll(BRACKETED_PASTE_START, '')
      .replaceAll(BRACKETED_PASTE_END, '');
    const bytes = new TextEncoder().encode(
      BRACKETED_PASTE_START + sanitized + BRACKETED_PASTE_END,
    );
    this.safeForwardWrite(bytes);
    this.onAnyKeystroke?.(this.sessionId);
  }

  private handleBackendRejection(err: unknown, op: 'write' | 'resize'): void {
    // Once the bridge is closed, rejections from writes that were already
    // in flight don't add information — just noise. `closed` flips on the
    // first close path (closeBridgeForFailure or ws 'close'), so subsequent
    // rejections get a single no-op instead of duplicate close attempts
    // and duplicate log lines.
    if (this.closed) return;
    if (this.isBackendSessionFailure(err)) {
      // Session genuinely gone from under us — retire this WS.
      console.warn(`[session-bridge] ${op} rejected for ${this.sessionId}: ${String(err)}`);
      this.closeBridgeForFailure(`session ${this.sessionId} is gone`);
      return;
    }
    // Unknown failure (timeout, EIO, …) — log and close the bridge. Keeping
    // it open would let the client keep sending inputs the backend can't
    // deliver, which silently loses keystrokes.
    console.error(`[session-bridge] ${op} failed for ${this.sessionId}:`, err);
    this.closeBridgeForFailure(`${op} failed`);
  }

  /**
   * Typed backend errors that mean "this session is permanently unreachable
   * from this bridge's perspective". Both SessionGoneError (socket gone) and
   * SessionAttachFailedError (reattach cap exhausted) fall in this bucket —
   * keeping the WS open after either one is just silent keystroke loss.
   */
  private isBackendSessionFailure(err: unknown): boolean {
    return err instanceof SessionGoneError || err instanceof SessionAttachFailedError;
  }

  private closeBridgeForFailure(reason: string): void {
    try {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.close(1011, reason);
      }
    } catch {
      // ws.close can itself throw on a broken socket. Ignore — the bridge
      // is ending either way.
    }
    try {
      this.dispose();
    } catch (err) {
      // dispose throws are not a reason to cross back into the caller with
      // an exception, but we log for parity with the ws 'close' handler so
      // operators see both paths on the same channel.
      console.error(`[session-bridge] dispose failed for ${this.sessionId}:`, err);
    }
  }

  dispose(): void {
    const wasClosed = this.closed;
    this.closed = true;
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = null;
    }
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
    this.debouncedResize = null;
    // Unblock start() if it is still waiting for the browser FitAddon size.
    const pendingResolver = this.initialResizeResolver;
    this.initialResizeResolver = null;
    pendingResolver?.();
    this.pendingOutputChunks = [];
    this.pendingOutputBytes = 0;
    this.pendingOutputHasLiveBytes = false;
    this.pendingOutputHasReplayBytes = false;
    this.unsubscribeData?.();
    this.unsubscribeData = null;
    if (!wasClosed && this.bridgeHealthStarted) {
      this.bridgeHealthStarted = false;
      this.onBridgeClosed?.(this.sessionId);
    }
  }

  private notifyInput(bytes: Uint8Array): void {
    this.onAnyKeystroke?.(this.sessionId);
    // Fire onInput when the user submits — Enter key. Parity with the v7
    // TerminalBridge behavior used by permission-response detection.
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x0d /* \r */ || bytes[i] === 0x0a /* \n */) {
        this.onInput?.(this.sessionId);
        return;
      }
    }
  }
}
