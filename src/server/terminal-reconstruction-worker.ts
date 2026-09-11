import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { getReconstructAbsoluteTuiScreenStats, type AbsoluteTuiScreenResult,
  type ReconstructAbsoluteTuiScreenOptions, type ReconstructAbsoluteTuiScreenStats } from './absolute-position-tui-screen.js';

interface PendingReconstruction {
  bytes: number;
  unavailable: AbsoluteTuiScreenResult;
  resolve(result: AbsoluteTuiScreenResult): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One worker and one existing reconstruction scheduler, with bounded IPC admission. */
export class TerminalReconstructionWorker {
  private worker: Worker | null = null;
  private stopping: Promise<unknown> | null = null;
  private closed = false;
  private nextId = 0;
  private readonly pending = new Map<number, PendingReconstruction>();
  private retainedBytes = 0;
  private stats = getReconstructAbsoluteTuiScreenStats();

  get pendingBytes(): number { return this.retainedBytes; }
  getStats(): ReconstructAbsoluteTuiScreenStats { return { ...this.stats }; }

  private start(): Worker | null {
    if (this.closed || this.stopping) return null;
    if (this.worker) return this.worker;
    const source = __filename.endsWith('.ts');
    const worker = new Worker(join(__dirname, `terminal-reconstruction-worker-entry.${source ? 'ts' : 'js'}`), {
      execArgv: source ? ['--import', 'tsx'] : [],
    });
    this.worker = worker;
    worker.on('message', (message: { id: number; result: AbsoluteTuiScreenResult; stats: ReconstructAbsoluteTuiScreenStats }) => {
      if (this.worker !== worker) return;
      this.stats = message.stats;
      this.finish(message.id, message.result);
    });
    worker.on('error', () => { if (this.worker === worker) void this.retire(); });
    worker.on('exit', () => { if (this.worker === worker) void this.retire(); });
    return worker;
  }

  reconstruct(bytes: Uint8Array, options: ReconstructAbsoluteTuiScreenOptions = {}): Promise<AbsoluteTuiScreenResult> {
    const unavailable: AbsoluteTuiScreenResult = { kind: 'unavailable', reason: 'busy', bytes: null,
      consumedBytes: 0, totalBytes: bytes.length, ...(options.source ? { source: options.source } : {}) };
    if (bytes.length > 1024 * 1024 || this.pending.size >= 16
      || this.retainedBytes + bytes.length > 8 * 1024 * 1024 || options.nowMs || options.yieldFn) {
      return Promise.resolve(unavailable);
    }
    const worker = this.start();
    if (!worker) return Promise.resolve(unavailable);
    const id = ++this.nextId;
    const owned = Uint8Array.from(bytes);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { void this.retire(); }, 2000);
      this.pending.set(id, { bytes: bytes.length, unavailable, resolve, timer });
      this.retainedBytes += bytes.length;
      try { worker.postMessage({ id, bytes: owned, options }, [owned.buffer]); }
      catch { this.finish(id, unavailable); }
    });
  }

  private finish(id: number, result: AbsoluteTuiScreenResult) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.retainedBytes -= pending.bytes;
    pending.resolve(result);
  }

  private async retire(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    for (const [id, pending] of this.pending) this.finish(id, pending.unavailable);
    if (!worker) { await this.stopping; return; }
    // A replacement cannot start until the old thread has positively exited.
    const stopping = worker.terminate();
    this.stopping = stopping;
    await stopping;
    if (this.stopping === stopping) this.stopping = null;
  }

  async close(): Promise<void> { this.closed = true; await this.retire(); }
}
