import {
  parseTerminalServerControl, TERMINAL_CLOSE, TERMINAL_CREDIT_BYTES, TERMINAL_FRAME_BYTES,
  TERMINAL_V2_PROTOCOL, type TerminalClientControl, type TerminalResumeCursor, type TerminalServerControl,
} from '../shared/terminal-protocol.js';
import type { TerminalSourceRange } from '../shared/terminal-stream.js';
import { createTerminalAttachMetrics } from './terminal-attach-metrics.js';
import type { createTerminalWriter, TerminalWriteSession } from './terminal-writer.js';

export interface TerminalContinuity {
  cursor: TerminalResumeCursor | null;
  hadView: boolean;
}
export interface TerminalStreamState {
  kind: 'negotiating' | 'seeding' | 'live' | 'suspended' | 'lagged' | 'incompatible'
    | 'access-denied' | 'ended' | 'unavailable' | 'continuity-unavailable';
  reason?: string;
  approximate?: boolean;
}
export interface TerminalRetryBudget { attempts: number[]; }
interface TerminalSocket extends Pick<WebSocket, 'readyState' | 'close' | 'onopen' | 'onmessage' | 'onclose' | 'onerror'> {
  readonly protocol: string;
  binaryType: string;
  send(data: string): void;
}
interface StreamClientOptions {
  writer: ReturnType<typeof createTerminalWriter>;
  continuity: TerminalContinuity;
  retryBudget?: TerminalRetryBudget;
  createSocket(): TerminalSocket;
  getSize(): { cols: number; rows: number };
  onState(state: TerminalStreamState): void;
  onOutput?(bytes: Uint8Array): void;
  getMetadata(): Record<string, unknown>;
  onTelemetry(event: { type: 'terminal_switch_latency'; [key: string]: unknown }): void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
  document?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
}
interface Attempt {
  socket: TerminalSocket;
  writer: TerminalWriteSession;
  metrics: ReturnType<typeof createTerminalAttachMetrics>;
  metadata: Record<string, unknown>;
  generation: string | null;
  attachId: string;
  wireState: 'waiting' | 'seed' | 'live' | 'gap';
  transaction: string | null;
  source: TerminalSourceRange | null;
  expectedSource: { epoch: string; position: number } | null;
  requestedCursor: TerminalResumeCursor | null;
  ready: boolean;
  retiring: boolean;
  processed: number;
  received: number;
  acknowledged: number;
  helloTimer: ReturnType<typeof setTimeout> | null;
  seedTimer: ReturnType<typeof setTimeout> | null;
  ackTimer: ReturnType<typeof setTimeout> | null;
  metricsTimer: ReturnType<typeof setTimeout> | null;
  healthySince: number | null;
  lastProgress: number | null;
}

/** A connection owns credit; the retained xterm instance owns source continuity. */
export function createTerminalStreamClient(options: StreamClientOptions) {
  const budget = options.retryBudget ?? { attempts: [] };
  const doc = options.document ?? (typeof document === 'undefined' ? undefined : document);
  let active: Attempt | null = null;
  let stopped = true;
  let suspended = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let previousState = '';

  function state(next: TerminalStreamState) {
    const key = JSON.stringify(next);
    if (key === previousState) return;
    previousState = key;
    options.onState(next);
  }
  function send(attempt: Attempt, control: TerminalClientControl): boolean {
    if (active !== attempt || attempt.socket.readyState !== 1) return false;
    try { attempt.socket.send(JSON.stringify(control)); return true; }
    catch { if (!attempt.retiring) fail(attempt, 'unavailable', 'send failed'); return false; }
  }
  function ack(attempt: Attempt) {
    if (attempt.ackTimer !== null) clearTimeout(attempt.ackTimer);
    attempt.ackTimer = null;
    if (active !== attempt || !attempt.generation || attempt.processed === attempt.acknowledged) return;
    if (send(attempt, { type: 'ack', generation: attempt.generation, processed: attempt.processed })) {
      attempt.acknowledged = attempt.processed;
    }
  }
  function retire(attempt: Attempt, reason: 'superseded' | 'disconnected') {
    if (active !== attempt || attempt.retiring) return;
    attempt.retiring = true;
    ack(attempt);
    active = null;
    // A callback already inside xterm can still mutate the old parser. Without
    // its completion boundary the saved cursor no longer describes that parser.
    if (options.writer.hasInFlight || attempt.wireState === 'seed'
      || (attempt.wireState === 'live' && !attempt.ready)) options.continuity.cursor = null;
    attempt.writer.retire();
    for (const timer of [attempt.helloTimer, attempt.seedTimer, attempt.ackTimer, attempt.metricsTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    attempt.metrics.dispose(reason);
    attempt.socket.onopen = null;
    attempt.socket.onmessage = null;
    attempt.socket.onclose = null;
    attempt.socket.onerror = null;
    try { attempt.socket.close(); } catch { /* Already disconnected. */ }
  }
  function fail(attempt: Attempt, kind: TerminalStreamState['kind'], reason: string) {
    if (active !== attempt) return;
    retire(attempt, 'disconnected');
    state({ kind, reason });
  }
  function scheduleRetry() {
    if (stopped || suspended) return;
    const now = performance.now();
    budget.attempts = budget.attempts.filter((time) => now - time < 30_000);
    if (budget.attempts.length >= 3) { state({ kind: 'unavailable', reason: 'automatic retry limit reached' }); return; }
    retryTimer = setTimeout(() => { retryTimer = null; connect(false); }, 1000 * Math.max(1, budget.attempts.length));
  }
  function close(attempt: Attempt, code?: number) {
    if (active !== attempt) return;
    retire(attempt, 'disconnected');
    const kind = code === TERMINAL_CLOSE.lagged ? 'lagged'
      : code === TERMINAL_CLOSE.incompatible ? 'incompatible'
        : code === TERMINAL_CLOSE.accessDenied ? 'access-denied'
          : code === TERMINAL_CLOSE.ended ? 'ended'
            : code === TERMINAL_CLOSE.continuityLost ? 'continuity-unavailable' : 'unavailable';
    state({ kind });
    if (kind === 'unavailable') scheduleRetry();
  }
  function parsed(attempt: Attempt, bytes: number, source: TerminalSourceRange | null) {
    if (active !== attempt) return;
    const firstParse = attempt.processed === 0;
    attempt.processed += bytes;
    attempt.metrics.parsed();
    if (firstParse) {
      attempt.metricsTimer = setTimeout(() => { attempt.metricsTimer = null; attempt.metrics.flush(); }, 80);
    }
    if (source && options.continuity.cursor) {
      const size = options.getSize();
      options.continuity.cursor = source.cols === size.cols && source.rows === size.rows
        ? { epoch: source.epoch, position: source.end, geometryRevision: source.geometryRevision, cols: source.cols, rows: source.rows } : null;
    }
    if (attempt.processed - attempt.acknowledged >= 32 * 1024 || attempt.processed === attempt.received) ack(attempt);
    else if (attempt.ackTimer === null) attempt.ackTimer = setTimeout(() => ack(attempt), 8);
    const now = performance.now();
    if (attempt.ready) {
      if (attempt.lastProgress === null || now - attempt.lastProgress > 5000) attempt.healthySince = now;
      attempt.lastProgress = now;
      if (attempt.healthySince !== null && now - attempt.healthySince >= 30_000) budget.attempts = [];
    }
  }
  function receiveControl(attempt: Attempt, control: TerminalServerControl) {
    if (control.type === 'hello') {
      if (attempt.generation !== null) { fail(attempt, 'incompatible', 'duplicate hello'); return; }
      attempt.generation = control.generation;
      if (attempt.helloTimer !== null) clearTimeout(attempt.helloTimer);
      attempt.helloTimer = null;
      const size = attempt.requestedCursor ?? options.getSize();
      send(attempt, { type: 'attach', generation: control.generation, attachId: attempt.attachId,
        cols: size.cols, rows: size.rows, ...(attempt.requestedCursor ? { cursor: attempt.requestedCursor } : { acceptGap: true }) });
      attempt.seedTimer = setTimeout(() => { close(attempt, TERMINAL_CLOSE.unavailable); }, 5000);
      return;
    }
    if (!attempt.generation || control.generation !== attempt.generation) {
      fail(attempt, 'incompatible', 'control without matching hello'); return;
    }
    switch (control.type) {
      case 'seed-begin': {
        if (attempt.wireState === 'seed' || attempt.source || (control.mode === 'resume' && !attempt.requestedCursor)) {
          fail(attempt, 'incompatible', 'invalid seed transition'); return;
        }
        if (attempt.seedTimer !== null) clearTimeout(attempt.seedTimer);
        attempt.seedTimer = null;
        attempt.wireState = 'seed';
        attempt.ready = false;
        attempt.transaction = control.transaction;
        options.continuity.cursor = null;
        state({ kind: 'seeding' });
        if (control.mode === 'replace' && !attempt.writer.reset()) fail(attempt, 'lagged', 'parser queue full');
        break;
      }
      case 'seed-end': {
        if (attempt.wireState !== 'seed' || attempt.transaction !== control.transaction) {
          fail(attempt, 'incompatible', 'unmatched seed boundary'); return;
        }
        attempt.wireState = 'live';
        attempt.expectedSource = control.cursor;
        if (!attempt.writer.barrier(() => {
          if (active !== attempt) return;
          const size = options.getSize();
          options.continuity.cursor = control.cursor?.cols === size.cols && control.cursor.rows === size.rows ? control.cursor : null;
          options.continuity.hadView = true;
          attempt.ready = !control.screenUnavailable;
          state(control.screenUnavailable
            ? { kind: 'unavailable', reason: 'current terminal screen unavailable' }
            : { kind: 'live', approximate: control.approximate });
          ack(attempt);
        })) fail(attempt, 'lagged', 'parser queue full');
        break;
      }
      case 'source': {
        if (attempt.wireState !== 'live' || attempt.source
          || (attempt.expectedSource && (control.epoch !== attempt.expectedSource.epoch || control.start !== attempt.expectedSource.position))) {
          fail(attempt, 'continuity-unavailable', 'source position gap'); return;
        }
        attempt.source = control;
        attempt.expectedSource = { epoch: control.epoch, position: control.end };
        break;
      }
      case 'continuity-unavailable':
        if (attempt.seedTimer !== null) clearTimeout(attempt.seedTimer);
        attempt.seedTimer = null;
        attempt.wireState = 'gap';
        attempt.ready = false;
        state({ kind: 'continuity-unavailable', reason: control.reason });
        break;
      case 'history-unavailable': break;
      case 'attach_timing':
        Object.assign(attempt.metadata, {
          serverStrategy: control.strategy, seedCacheHit: control.seedCacheHit,
          recoveryUsed: control.recoveryUsed, serverTotalMs: control.totalMs,
          serverResizeWaitMs: control.resizeWaitMs, serverCaptureMs: control.captureMs,
          serverReconstructMs: control.reconstructMs,
        });
        attempt.metrics.flush();
        break;
    }
  }
  function receive(attempt: Attempt, data: unknown) {
    if (active !== attempt) return;
    if (typeof data === 'string') {
      const control = parseTerminalServerControl(data);
      if (!control) { fail(attempt, 'incompatible', 'unsupported terminal control'); return; }
      receiveControl(attempt, control);
      return;
    }
    if (!(data instanceof ArrayBuffer) || !attempt.generation || (attempt.wireState !== 'seed' && attempt.wireState !== 'live')) {
      fail(attempt, 'incompatible', 'output before negotiated seed'); return;
    }
    const bytes = new Uint8Array(data);
    const source = attempt.source;
    attempt.source = null;
    if (bytes.byteLength === 0 || bytes.byteLength > TERMINAL_FRAME_BYTES
      || bytes.byteLength > TERMINAL_CREDIT_BYTES - (attempt.received - attempt.acknowledged)
      || (attempt.wireState === 'live' && (!source || source.end - source.start !== bytes.byteLength))) {
      fail(attempt, 'incompatible', 'invalid terminal output frame'); return;
    }
    attempt.received += bytes.byteLength;
    attempt.metrics.received(bytes.byteLength);
    options.onOutput?.(bytes);
    if (!attempt.writer.write(bytes, (count) => parsed(attempt, count, source))) fail(attempt, 'lagged', 'parser queue full');
  }
  function connect(newView: boolean) {
    if (stopped || suspended || active) return;
    if (!newView && options.continuity.hadView && !options.continuity.cursor) {
      state({ kind: 'continuity-unavailable', reason: 'parser continuity unavailable' }); return;
    }
    const now = performance.now();
    budget.attempts = budget.attempts.filter((time) => now - time < 30_000);
    if (budget.attempts.length >= 3) { state({ kind: 'unavailable', reason: 'automatic retry limit reached' }); return; }
    budget.attempts.push(now);
    state({ kind: 'negotiating' });
    let socket: TerminalSocket;
    try { socket = options.createSocket(); } catch { state({ kind: 'unavailable' }); scheduleRetry(); return; }
    socket.binaryType = 'arraybuffer';
    const attachId = globalThis.crypto?.randomUUID?.() ?? `attach-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const metadata: Record<string, unknown> = {
      attachId, clientWarm: options.continuity.hadView, warmLabel: options.continuity.hadView ? 'warm' : 'cold',
    };
    const metrics = createTerminalAttachMetrics({ getMetadata: () => ({ ...options.getMetadata(), ...metadata }),
      emit: options.onTelemetry, requestFrame: options.requestFrame, cancelFrame: options.cancelFrame });
    const size = options.getSize();
    const cursor = options.continuity.cursor;
    const requestedCursor = !newView && cursor?.cols === size.cols && cursor.rows === size.rows ? cursor : null;
    if (!newView && options.continuity.hadView && !requestedCursor) {
      try { socket.close(); } catch { /* Already disconnected. */ }
      metrics.dispose('superseded');
      state({ kind: 'continuity-unavailable', reason: 'parser geometry changed' }); return;
    }
    const attempt: Attempt = {
      socket, writer: options.writer.begin(false), metrics, metadata, generation: null, attachId,
      wireState: 'waiting', transaction: null, source: null, expectedSource: null, requestedCursor,
      ready: false, retiring: false, processed: 0, received: 0, acknowledged: 0,
      helloTimer: null, seedTimer: null, ackTimer: null, metricsTimer: null, healthySince: null, lastProgress: null,
    };
    active = attempt;
    attempt.helloTimer = setTimeout(() => fail(attempt, 'incompatible', 'terminal hello timed out'), 2000);
    socket.onopen = () => {
      if (active !== attempt) return;
      if (socket.protocol !== TERMINAL_V2_PROTOCOL) { fail(attempt, 'incompatible', 'terminal protocol unavailable'); return; }
      metrics.opened();
    };
    socket.onmessage = (event) => receive(attempt, event.data);
    socket.onclose = (event) => close(attempt, event?.code);
    socket.onerror = () => close(attempt);
  }
  function suspend() {
    suspended = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    if (active) retire(active, 'superseded');
    state({ kind: 'suspended' });
  }
  function resume() {
    if (stopped || !suspended || doc?.hidden) return;
    suspended = false;
    connect(false);
  }
  const visibility = () => { if (doc?.hidden) suspend(); else resume(); };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      doc?.addEventListener('visibilitychange', visibility);
      doc?.addEventListener('freeze', suspend);
      doc?.addEventListener('resume', resume);
      if (doc?.hidden) suspend(); else connect(false);
    },
    stop() {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      doc?.removeEventListener('visibilitychange', visibility);
      doc?.removeEventListener('freeze', suspend);
      doc?.removeEventListener('resume', resume);
      if (active) retire(active, 'superseded');
    },
    retry(newView = false) {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      if (active) retire(active, 'superseded');
      if (newView) options.continuity.cursor = null;
      budget.attempts = [];
      connect(newView);
    },
    isEstablished() { return active?.ready === true; },
    sendInput(data: string | Uint8Array): boolean {
      if (!active?.ready || !active.generation) return false;
      if (typeof data === 'string') return send(active, { type: 'input', generation: active.generation, text: data });
      // Raw paste remains byte-exact without a control/input JSON collision.
      let binary = '';
      for (let offset = 0; offset < data.length; offset += 8192) binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
      return send(active, { type: 'input-bytes', generation: active.generation, base64: btoa(binary) });
    },
    paste(text: string): boolean {
      return !!active?.ready && !!active.generation && send(active, { type: 'paste', generation: active.generation, text });
    },
    resize(cols: number, rows: number): boolean {
      return !!active?.ready && !!active.generation && send(active, { type: 'resize', generation: active.generation, cols, rows });
    },
    requestHistory(): boolean {
      return !!active?.ready && !!active.generation && send(active, { type: 'request-history', generation: active.generation });
    },
  };
}

export type TerminalStreamClient = ReturnType<typeof createTerminalStreamClient>;
