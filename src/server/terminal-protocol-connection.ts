import { randomUUID } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import {
  parseTerminalClientControl, TERMINAL_CLOSE, TERMINAL_CONTROL_BYTES,
  TERMINAL_CREDIT_BYTES, TERMINAL_FRAME_BYTES, TERMINAL_INPUT_BYTES,
  type TerminalClientControl,
} from '../shared/terminal-protocol.js';
import { TerminalOutputQueue } from './terminal-output-queue.js';

export type TerminalAttachRequest = Extract<TerminalClientControl, { type: 'attach' }>;
type InputControl = Exclude<TerminalClientControl, { type: 'attach' | 'ack' }>;
interface ConnectionOptions {
  ws: WebSocket;
  readOnly: boolean;
  onAttach(request: TerminalAttachRequest): void | Promise<void>;
  onControl(control: InputControl): void;
  onClosed?(): void;
}

/** Negotiation and credit are independent of permission to write agent input. */
export class TerminalProtocolConnection {
  readonly generation = randomUUID();
  readonly output: TerminalOutputQueue;
  private started = false;
  private disposed = false;
  private attachAllowed = true;
  private ready = false;
  private negotiationTimer: ReturnType<typeof setTimeout> | null = null;
  private controlWindow = performance.now();
  private controlCount = 0;

  constructor(private readonly options: ConnectionOptions) {
    this.output = new TerminalOutputQueue({
      id: this.generation, generation: this.generation,
      send: (data, flushed) => options.ws.send(data, flushed),
      close: (reason) => this.close(TERMINAL_CLOSE.lagged, reason),
    });
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const ws = this.options.ws;
    ws.on('error', this.onError);
    ws.on('close', this.onClose);
    ws.on('message', this.onMessage);
    this.negotiationTimer = setTimeout(() => this.close(TERMINAL_CLOSE.incompatible, 'terminal hello timed out'), 2000);
    this.negotiationTimer.unref?.();
    try {
      ws.send(JSON.stringify({ type: 'hello', version: 2, generation: this.generation,
        creditBytes: TERMINAL_CREDIT_BYTES, frameBytes: TERMINAL_FRAME_BYTES }));
    } catch { this.close(TERMINAL_CLOSE.unavailable, 'terminal handshake failed'); }
  }

  private onMessage = (data: RawData, binary: boolean): void => {
    if (this.disposed) return;
    const size = Array.isArray(data) ? data.reduce((sum, item) => sum + item.byteLength, 0) : data.byteLength;
    if (binary || size > (this.options.readOnly ? TERMINAL_CONTROL_BYTES : TERMINAL_INPUT_BYTES)) {
      this.close(TERMINAL_CLOSE.incompatible, 'invalid terminal envelope');
      return;
    }
    const now = performance.now();
    if (now - this.controlWindow >= 1000) {
      this.controlWindow = now;
      this.controlCount = 0;
    }
    if (++this.controlCount > 4000) {
      this.close(TERMINAL_CLOSE.incompatible, 'terminal control rate exceeded');
      return;
    }
    const text = Buffer.isBuffer(data) ? data.toString('utf8')
      : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8')
        : Buffer.concat(data).toString('utf8');
    const control = parseTerminalClientControl(text);
    if (!control || control.generation !== this.generation) {
      this.close(TERMINAL_CLOSE.incompatible, 'invalid terminal control');
      return;
    }
    if (control.type === 'ack') {
      if (!this.output.acknowledge(control.generation, control.processed)) {
        this.close(TERMINAL_CLOSE.incompatible, 'invalid terminal acknowledgement');
      }
      return;
    }
    if (control.type === 'attach') {
      if (!this.attachAllowed) {
        this.close(TERMINAL_CLOSE.incompatible, 'duplicate terminal attach');
        return;
      }
      this.attachAllowed = false;
      this.ready = false;
      if (this.negotiationTimer !== null) clearTimeout(this.negotiationTimer);
      this.negotiationTimer = null;
      try {
        void Promise.resolve(this.options.onAttach(control)).catch(() => {
          this.close(TERMINAL_CLOSE.unavailable, 'terminal attach failed');
        });
      } catch { this.close(TERMINAL_CLOSE.unavailable, 'terminal attach failed'); }
      return;
    }
    if (this.options.readOnly) return;
    if (!this.ready) {
      this.close(TERMINAL_CLOSE.incompatible, 'terminal input before ready');
      return;
    }
    try { this.options.onControl(control); }
    catch { this.close(TERMINAL_CLOSE.unavailable, 'terminal input unavailable'); }
  };

  /** A disclosed continuity gap requires a new explicit attach request. */
  allowNewAttach(): void { this.attachAllowed = true; this.ready = false; }
  markReady(): void { if (!this.disposed) this.ready = true; }

  private onError = (): void => { this.close(TERMINAL_CLOSE.unavailable, 'terminal socket failed'); };
  private onClose = (): void => { this.dispose(); };

  close(code: number, reason: string): void {
    if (this.disposed) return;
    this.dispose();
    try {
      this.options.ws.close(code, reason);
      // A close handshake queues behind pending output. Do not retain a
      // non-reading viewer's allocations until the socket's close timeout.
      if (this.options.ws.bufferedAmount > 0) this.options.ws.terminate();
    } catch { /* Already disconnected. */ }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.negotiationTimer !== null) clearTimeout(this.negotiationTimer);
    this.negotiationTimer = null;
    this.output.dispose();
    this.options.ws.off('message', this.onMessage);
    this.options.ws.off('close', this.onClose);
    // Keep the guarded error handler until the socket itself is collected.
    this.options.onClosed?.();
  }
}
