import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  snapshotDeadlineMs,
  type StreamingAttachSnapshotOptions,
  type StreamingAttachSnapshotResult,
  type StreamingAttachSnapshotUnavailableReason,
} from './streaming-attach-snapshot.js';

/** Options that survive a trip to the worker thread (functions do not). */
type WorkerOptions = Omit<StreamingAttachSnapshotOptions, 'nowMs'>;

interface Pending {
  bytes: number;
  startedAt: number;
  resolve(result: StreamingAttachSnapshotResult): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Jobs allowed in flight; each retains a copy of a ring of up to 1 MiB. */
const MAX_PENDING_JOBS = 8;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;

/**
 * Builds screen-snapshot attach seeds (issue #3564) in a worker thread.
 *
 * The emulator parses untrusted program output one control sequence at a time,
 * synchronously, so a hostile or merely unlucky ring can occupy its thread for
 * minutes (`ESC[999999999b` alone takes tens of seconds). A thread that is
 * busy that way cannot time itself out. Here the host thread keeps a deadline
 * per job instead: when it passes, the worker is terminated, every job waiting
 * on it resolves as unavailable, and the next job starts a fresh worker. The
 * attach that triggered it falls back to the byte-tail seed. A parser
 * exception, which would otherwise surface as an uncaught exception on the
 * host, ends only the worker.
 *
 * One worker, started on first use and not kept alive by itself: it never
 * stops the process from exiting. Jobs run one at a time inside it (see
 * `streaming-attach-snapshot.ts`).
 */
export class TerminalSnapshotWorker {
  private worker: Worker | null = null;
  private stopping: Promise<unknown> | null = null;
  private closed = false;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private retainedBytes = 0;

  get pendingBytes(): number { return this.retainedBytes; }

  private start(): Worker | null {
    if (this.closed || this.stopping) return null;
    if (this.worker) return this.worker;
    const source = __filename.endsWith('.ts');
    const worker = new Worker(join(__dirname, `terminal-snapshot-worker-entry.${source ? 'ts' : 'js'}`), {
      execArgv: source ? ['--import', 'tsx'] : [],
    });
    worker.unref();
    this.worker = worker;
    worker.on('message', (message: { id: number; result: StreamingAttachSnapshotResult }) => {
      if (this.worker === worker) this.finish(message.id, message.result);
    });
    worker.on('error', (error) => {
      if (this.worker !== worker) return;
      console.error('[terminal-snapshot-worker] worker failed; attaches fall back to the byte-tail seed:', error);
      void this.retire('failed');
    });
    worker.on('exit', () => { if (this.worker === worker) void this.retire('failed'); });
    return worker;
  }

  snapshot(bytes: Uint8Array, options: StreamingAttachSnapshotOptions): Promise<StreamingAttachSnapshotResult> {
    const startedAt = performance.now();
    const unavailable = (reason: StreamingAttachSnapshotUnavailableReason): StreamingAttachSnapshotResult =>
      ({ kind: 'unavailable', reason, elapsedMs: performance.now() - startedAt });
    if (bytes.length === 0) return Promise.resolve(unavailable('empty'));
    if (this.pending.size >= MAX_PENDING_JOBS || this.retainedBytes + bytes.length > MAX_RETAINED_BYTES) {
      return Promise.resolve(unavailable('busy'));
    }
    const worker = this.start();
    if (!worker) return Promise.resolve(unavailable('failed'));

    const { nowMs: _nowMs, ...cloneable }: StreamingAttachSnapshotOptions = options;
    const workerOptions: WorkerOptions = cloneable;
    const id = ++this.nextId;
    const owned = Uint8Array.from(bytes); // the caller keeps its copy of the ring
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.error(`[terminal-snapshot-worker] replay ran past ${snapshotDeadlineMs(options)} ms; terminating the worker`);
        void this.retire('budget-exceeded');
      }, snapshotDeadlineMs(options));
      timer.unref?.();
      this.pending.set(id, { bytes: bytes.length, startedAt, resolve, timer });
      this.retainedBytes += bytes.length;
      try { worker.postMessage({ id, bytes: owned, options: workerOptions }, [owned.buffer]); }
      catch { this.finish(id, unavailable('failed')); }
    });
  }

  private finish(id: number, result: StreamingAttachSnapshotResult): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.retainedBytes -= pending.bytes;
    pending.resolve(result);
  }

  private async retire(reason: StreamingAttachSnapshotUnavailableReason): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    for (const [id, pending] of this.pending) {
      this.finish(id, { kind: 'unavailable', reason, elapsedMs: performance.now() - pending.startedAt });
    }
    if (!worker) { await this.stopping; return; }
    // A replacement cannot start until the old thread has positively exited.
    const stopping = worker.terminate();
    this.stopping = stopping;
    await stopping;
    if (this.stopping === stopping) this.stopping = null;
  }

  /** Stop the worker and fail whatever is waiting on it. Later jobs are refused. */
  async close(): Promise<void> {
    this.closed = true;
    await this.retire('failed');
  }
}

let shared: TerminalSnapshotWorker | null = null;

/**
 * The seed builder `SessionBridge` uses by default: one process-wide worker.
 * Same signature as `snapshotStreamingAttachSeed`, which it stands in for.
 */
export function snapshotStreamingAttachSeedIsolated(
  bytes: Uint8Array,
  options: StreamingAttachSnapshotOptions,
): Promise<StreamingAttachSnapshotResult> {
  shared ??= new TerminalSnapshotWorker();
  return shared.snapshot(bytes, options);
}

/** Stop the shared worker (process shutdown, tests). A later call starts a new one. */
export async function closeSharedTerminalSnapshotWorker(): Promise<void> {
  const worker = shared;
  shared = null;
  await worker?.close();
}
