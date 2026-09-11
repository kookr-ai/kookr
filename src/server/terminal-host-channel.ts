import type { Socket } from 'node:net';
import { terminalHostPayloadSize, TerminalHostUnavailableError } from './terminal-host-contract.js';

interface Packet {
  value: unknown;
  bytes: number;
  bulk: boolean;
  handle?: Socket;
  done?: (error?: Error | null) => void;
}

function complete(done: Packet['done'], error?: Error | null): void {
  // Completion reports ownership release. A failing observer must not strand
  // later packets or prevent the rest of a failed channel from being closed.
  try { done?.(error); } catch { /* Reporting failure cannot retain IPC work. */ }
}

/**
 * Bounds Node's otherwise unbounded process.send queue, including socket
 * transfers. Bulk replies cannot consume the final two MiB reserved for
 * authorization and input control. A failed transfer is never replayed.
 */
export class TerminalHostChannel {
  private queue: Packet[] = [];
  private active: Packet | null = null;
  private bytes = 0;
  private closed = false;

  constructor(private readonly transmit: (value: unknown, handle: Socket | undefined,
    done: (error?: Error | null) => void) => void) {}

  get pendingBytes() { return this.bytes; }
  get pendingCount() { return this.queue.length + (this.active ? 1 : 0); }

  send(value: unknown, options: { bulk?: boolean; handle?: Socket; done?: Packet['done'] } = {}): boolean {
    const bytes = terminalHostPayloadSize(value) + 256;
    const limit = (options.bulk ? 14 : 16) * 1024 * 1024;
    if (this.closed || bytes > 8 * 1024 * 1024 || this.bytes + bytes > limit
      || this.pendingCount >= (options.bulk ? 112 : 128)) {
      complete(options.done, new TerminalHostUnavailableError('Terminal host IPC capacity unavailable'));
      return false;
    }
    this.bytes += bytes;
    this.queue.push({ value, bytes, bulk: options.bulk === true, handle: options.handle, done: options.done });
    this.pump();
    return true;
  }

  private pump() {
    if (this.closed || this.active) return;
    const control = this.queue.findIndex((packet) => !packet.bulk);
    const [packet] = this.queue.splice(control >= 0 ? control : 0, 1);
    if (!packet) return;
    this.active = packet;
    const done = (error?: Error | null) => {
      if (this.active !== packet) return;
      this.active = null;
      this.bytes -= packet.bytes;
      complete(packet.done, error);
      if (error) this.close(error); else this.pump();
    };
    try { this.transmit(packet.value, packet.handle, done); }
    catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
  }

  close(error = new TerminalHostUnavailableError()): void {
    if (this.closed) return;
    this.closed = true;
    const packets = this.active ? [this.active, ...this.queue] : this.queue;
    this.active = null;
    this.queue = [];
    this.bytes = 0;
    for (const packet of packets) complete(packet.done, error);
  }
}
