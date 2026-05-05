import type { WebSocket } from 'ws';
import {
  type SessionId,
  type TerminalBackend,
  SessionAttachFailedError,
  SessionGoneError,
} from '../adapters/terminal-backend.js';

/**
 * SessionBridge — per-WS-client view over the backend's byte stream.
 *
 * V8 (rfc-v8-tmux-removal.md) makes the bridge a fan-out view, not an
 * independent owner of the attach:
 *   - on WS open, replay the backend's ring buffer via `captureBytes`
 *     before wiring live updates;
 *   - subscribe to live bytes via `backend.onData`;
 *   - forward inbound WS frames to `backend.write` / `backend.resize`;
 *   - on WS close, unsubscribe.
 *
 * The ring buffer moved to the backend (one owner per session), so every
 * consumer — stuck detection, diagnostics, WS clients — sees the same bytes
 * without a second buffer. Per-WS-client bookkeeping (the unsubscribe
 * function, Enter-detection callbacks) stays here.
 *
 * WebSocket protocol (wire-compatible with the v7 TerminalBridge):
 *   Browser → Server: binary frames (preferred) OR raw text (fallback) OR
 *                     JSON text `{"type":"resize","cols":N,"rows":M}`
 *   Server → Browser: binary frames carrying raw child PTY output.
 */

export class SessionBridge {
  private unsubscribeData: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly sessionId: SessionId,
    private readonly ws: WebSocket,
    private readonly backend: TerminalBackend,
    private readonly onInput?: (sessionId: SessionId) => void,
    private readonly onAnyKeystroke?: (sessionId: SessionId) => void,
  ) {}

  async start(_cols = 120, _rows = 40): Promise<void> {
    // Install the ws 'error' listener FIRST — before any awaits or safeSend
    // calls. Without this, a socket fault during the initial replay window
    // hits EventEmitter's no-listener path and re-raises as
    // uncaughtException. Must be the first thing we do.
    this.ws.on('error', (err) => {
      console.error(`[session-bridge] ws error for ${this.sessionId}:`, err);
      this.closeBridgeForFailure('ws error');
    });

    // Replay any buffered bytes to the client first, then wire live updates.
    // The backend owns the single ring buffer; this bridge is a stateless
    // view. `captureBytes` is lock-free and does not force a re-attach.
    let replay: Uint8Array;
    try {
      replay = await this.backend.captureBytes(this.sessionId);
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

    if (replay.length > 0) {
      this.safeSend(Buffer.from(replay));
    }

    try {
      this.unsubscribeData = this.backend.onData(this.sessionId, (bytes: Uint8Array) => {
        // The backend fans bytes out under its own try/catch per subscriber,
        // so a throw here does not crash the backend. We still guard ws.send
        // because a broken socket throws synchronously on some ws versions
        // and the listener is otherwise the last thing between us and a
        // process-fatal exception.
        this.safeSend(Buffer.from(bytes));
      });
    } catch (err) {
      if (this.isBackendSessionFailure(err)) {
        this.closeBridgeForFailure(`session ${this.sessionId} is gone`);
        return;
      }
      console.error(`[session-bridge] onData subscribe failed for ${this.sessionId}:`, err);
      this.closeBridgeForFailure('onData subscribe failed');
      return;
    }

    this.ws.on('message', (data, isBinary) => {
      if (this.closed) return;

      // Binary frames: PTY input, verbatim. Byte-transparent.
      if (isBinary && Buffer.isBuffer(data)) {
        const bytes = new Uint8Array(data);
        this.safeForwardWrite(bytes);
        this.notifyInput(bytes);
        return;
      }

      // Text frames: resize control or keystroke. Resize is JSON so it
      // can't collide with keystrokes.
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
              this.safeForwardResize(parsed.cols, parsed.rows);
            }
            return;
          }
        } catch {
          // Not resize JSON — fall through as keystroke text.
        }
      }
      const bytes = new TextEncoder().encode(text);
      this.safeForwardWrite(bytes);
      this.notifyInput(bytes);
    });

    this.ws.on('close', () => {
      try {
        this.dispose();
      } catch (err) {
        console.error(`[session-bridge] dispose failed for ${this.sessionId}:`, err);
      }
    });
  }

  /**
   * Send a buffer to the WS, contained. ws.send throws synchronously on some
   * socket states; a throw from the onData callback (or the initial replay)
   * would otherwise propagate up to the backend's subscriber loop or to
   * `start()`'s caller. We handle it locally and close the bridge.
   */
  private safeSend(payload: Buffer): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(payload);
    } catch (err) {
      console.error(`[session-bridge] ws.send failed for ${this.sessionId}:`, err);
      this.closeBridgeForFailure('ws.send failed');
    }
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
    this.backend.write(this.sessionId, bytes).catch((err: unknown) => {
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
    this.closed = true;
    this.unsubscribeData?.();
    this.unsubscribeData = null;
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
