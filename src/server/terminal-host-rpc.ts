import { SessionGoneError, WriteTimeoutError } from '../adapters/terminal-backend.js';
import { TerminalHostUnavailableError, terminalHostPayloadSize, type TerminalHostOperations,
  type TerminalHostMethod, type TerminalHostRequest, type TerminalHostResponse } from './terminal-host-contract.js';

import { isTerminalHostReadiness, TerminalHostAdmission } from './terminal-host-admission.js';

interface PendingRpc {
  releaseAdmission(): void;
  packet: TerminalHostRequest;
  bytes: number;
  charged: boolean;
  settled: boolean;
  transmitting: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}
const BULK = new Set<TerminalHostMethod>(['captureBytes', 'captureStreamSnapshot', 'captureCurrentFrame', 'getSessionDiagnostics']);

/**
 * One generation's asynchronous control channel. Byte/count admission bounds
 * queued calls; only unsent captures yield priority to input and lifecycle work.
 * A timed-out or failed write is never retried by this transport.
 */
export class TerminalHostRpcClient {
  private readonly admission = new TerminalHostAdmission();
  private readonly pending = new Map<number, PendingRpc>();
  private readonly queue: number[] = [];
  private nextId = 0;
  private retainedBytes = 0;
  private transmitting: PendingRpc | null = null;
  private closed = false;

  constructor(
    readonly generation: string,
    private readonly send: (packet: TerminalHostRequest, callback: (error?: Error | null) => void) => void,
    private readonly onResponse?: (response: TerminalHostResponse) => void,
  ) {}

  get pendingCount() { return this.pending.size; }
  get pendingBytes() { return this.retainedBytes; }

  request<K extends TerminalHostMethod>(method: K, args: Parameters<TerminalHostOperations[K]>, timeoutMs = 8000): Promise<Awaited<ReturnType<TerminalHostOperations[K]>>> {
    const bytes = terminalHostPayloadSize({ kind: 'request', generation: this.generation, id: this.nextId + 1,
      method, args, deadline: Date.now() + 30_000 }) + 256;
    const releaseAdmission = this.closed ? null : this.admission.acquire(method, bytes);
    if (!releaseAdmission) {
      return Promise.reject(new TerminalHostUnavailableError('Terminal host request capacity unavailable'));
    }
    const id = ++this.nextId;
    const duration = Math.min(30_000, Math.max(1, timeoutMs));
    // Own queued input so a caller cannot mutate bytes while another packet is
    // draining. Typed callers and the closed method list define the RPC boundary.
    let packet: TerminalHostRequest;
    try { packet = { kind: 'request', generation: this.generation, id,
      method, args: structuredClone(args), deadline: Date.now() + duration } as TerminalHostRequest; }
    catch { releaseAdmission(); return Promise.reject(new TerminalHostUnavailableError('Terminal host request cannot be serialized')); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(id, undefined,
        new TerminalHostUnavailableError(`Terminal host ${method} deadline exceeded; delivery may be uncertain`)), duration);
      const pending: PendingRpc = { releaseAdmission, packet, bytes, charged: true, settled: false, transmitting: false,
        timer, resolve: (value) => resolve(value as Awaited<ReturnType<TerminalHostOperations[K]>>), reject };
      this.pending.set(id, pending);
      this.retainedBytes += bytes;
      this.queue.push(id);
      this.pump();
    });
  }

  receive(response: TerminalHostResponse) {
    if (this.closed || response.kind !== 'response' || response.generation !== this.generation || !this.pending.has(response.id)) return;
    if (terminalHostPayloadSize(response) > 8 * 1024 * 1024) {
      this.finish(response.id, undefined, new TerminalHostUnavailableError('Oversized terminal host response')); return;
    }
    try { this.onResponse?.(response); } catch { /* Diagnostics must not strand an RPC. */ }
    const error = response.error;
    const failure = error?.name === 'SessionGoneError' ? new SessionGoneError(error.sessionId ?? '')
      : error?.name === 'WriteTimeoutError' ? new WriteTimeoutError(error.sessionId ?? '', error.durationMs ?? 0)
        : error ? new TerminalHostUnavailableError(error.message) : undefined;
    this.finish(response.id, response.result, failure);
  }

  private release(pending: PendingRpc) {
    if (!pending.charged) return;
    pending.charged = false;
    pending.releaseAdmission();
    this.retainedBytes -= pending.bytes;
  }

  private finish(id: number, value?: unknown, error?: Error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (!pending.transmitting) this.release(pending);
    if (error) pending.reject(error); else pending.resolve(value);
  }

  private pump() {
    if (this.closed || this.transmitting) return;
    const valid = this.queue.filter((id) => this.pending.has(id));
    this.queue.splice(0, this.queue.length, ...valid);
    const readiness = this.queue.findIndex((id) => isTerminalHostReadiness(this.pending.get(id)!.packet.method));
    const control = this.queue.findIndex((id) => !BULK.has(this.pending.get(id)!.packet.method));
    const index = readiness >= 0 ? readiness : control >= 0 ? control : 0;
    const [id] = this.queue.splice(index, 1);
    if (id === undefined) return;
    const pending = this.pending.get(id)!;
    if (pending.packet.deadline <= Date.now()) {
      this.finish(id, undefined, new TerminalHostUnavailableError('Terminal host request expired before transmission'));
      this.pump(); return;
    }
    this.transmitting = pending;
    pending.transmitting = true;
    const sent = (error?: Error | null) => {
      if (this.transmitting !== pending) return;
      pending.transmitting = false;
      this.transmitting = null;
      if (pending.settled) this.release(pending);
      // A failed send rejects only THIS request and keeps the client draining.
      // Channel backpressure (queue/size admission, including shared non-RPC traffic) must not become a permanent brownout that
      // fails every later request while stats keep the host `ready`. A genuine
      // child death is owned by the terminal-host 'disconnect'/'error'/'exit'
      // handlers (they retire and close this client) plus the stalled-stats
      // heartbeat — not by tearing the whole client down on one send.
      else if (error) this.finish(pending.packet.id, undefined,
        new TerminalHostUnavailableError(`Terminal host send failed: ${error.message}`));
      this.pump();
    };
    try { this.send(pending.packet, sent); } catch (error) { sent(error instanceof Error ? error : new Error(String(error))); }
  }

  close(error = new TerminalHostUnavailableError()): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.pending.keys()) this.finish(id, undefined, error);
    if (this.transmitting) this.release(this.transmitting);
    this.transmitting = null;
    this.queue.length = 0;
  }
}
