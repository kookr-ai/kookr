import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  snapshotDeadlineMs,
  type StreamingAttachSnapshotOptions,
  type StreamingAttachSnapshotResult,
  type StreamingAttachSnapshotUnavailableReason,
} from './streaming-attach-snapshot.js';

/** Options that survive a trip to the worker thread: the injected test clock, a function, does not. */
export type TerminalSnapshotJobOptions = Omit<StreamingAttachSnapshotOptions, 'nowMs'>;

interface Pending {
  bytes: number;
  sessionKey: string | undefined;
  startedAt: number;
  resolve(result: StreamingAttachSnapshotResult): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Jobs allowed in flight; each retains a copy of a ring of up to 1 MiB. */
const MAX_PENDING_JOBS = 8;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;

/**
 * Extra time for a worker's first job: the thread has to start and load the
 * emulator packages, which measured about 100 ms on an idle host and can take
 * seconds on a loaded one. Without it a slow start would be mistaken for a stall.
 */
const COLD_START_ALLOWANCE_MS = 1500;

/**
 * A ring is not replayed again for this long after it stalled the worker. The
 * ring persists, so without this every re-attach (a browser tab regaining
 * focus is one) would burn a full deadline of CPU and a worker respawn on the
 * same bytes. The attach falls back to the byte-tail seed meanwhile.
 */
const DEFAULT_BACKOFF_MS = 60_000;
const MAX_BACKOFF_ENTRIES = 256;

export interface TerminalSnapshotWorkerOptions {
  /** How long a session whose replay stalled the worker is skipped. */
  backoffMs?: number;
}
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
  /** True once the current worker has answered a job, i.e. is past its cold start. */
  private served = false;
  private readonly backoffMs: number;
  private readonly stalledSessions = new Map<string, number>();

  constructor(options: TerminalSnapshotWorkerOptions = {}) {
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  get pendingBytes(): number { return this.retainedBytes; }

  private start(): Worker | null {
    if (this.closed || this.stopping) return null;
    if (this.worker) return this.worker;
    const source = __filename.endsWith('.ts');
    const worker = new Worker(join(__dirname, `terminal-snapshot-worker-entry.${source ? 'ts' : 'js'}`), {
      execArgv: source ? ['--import', 'tsx'] : [],
    });
    this.worker = worker;
    this.served = false;
    worker.on('message', (message: { id: number; result: StreamingAttachSnapshotResult }) => {
      if (this.worker !== worker) return;
      this.served = true;
      // A replay that ran past its own budget is expensive however it ended, and the
      // ring will cost the same next time. Back the session off, as for a stall.
      if (message.result.kind === 'unavailable' && message.result.reason === 'budget-exceeded') {
        this.markStalled(this.pending.get(message.id)?.sessionKey);
      }
      this.finish(message.id, message.result);
    });
    worker.on('error', (error) => {
      if (this.worker !== worker) return;
      // An exception in the thread (a parser handler throwing) is attributed like a
      // stall: the oldest job was the one running, and the same ring would throw again.
      const crashed = this.oldestPending();
      console.error('[terminal-snapshot-worker] worker failed; attaches fall back to the byte-tail seed:', error);
      this.markStalled(crashed?.sessionKey);
      void this.retire('failed');
    });
    worker.on('exit', () => { if (this.worker === worker) void this.retire('failed'); });
    // After the listeners: adding a 'message' listener takes a reference on the
    // thread's port, which would undo an earlier unref() and keep the process alive.
    worker.unref();
    return worker;
  }

  snapshot(bytes: Uint8Array, options: TerminalSnapshotJobOptions): Promise<StreamingAttachSnapshotResult> {
    const startedAt = performance.now();
    const unavailable = (reason: StreamingAttachSnapshotUnavailableReason): StreamingAttachSnapshotResult =>
      ({ kind: 'unavailable', reason, elapsedMs: performance.now() - startedAt });
    if (bytes.length === 0) return Promise.resolve(unavailable('empty'));
    if (this.isBackingOff(options.sessionKey)) return Promise.resolve(unavailable('backoff'));
    if (this.pending.size >= MAX_PENDING_JOBS || this.retainedBytes + bytes.length > MAX_RETAINED_BYTES) {
      return Promise.resolve(unavailable('busy'));
    }
    let worker: Worker | null;
    try { worker = this.start(); }
    catch (error) {
      console.error('[terminal-snapshot-worker] could not start the worker; attaches fall back to the byte-tail seed:', error);
      return Promise.resolve(unavailable('failed'));
    }
    if (!worker) return Promise.resolve(unavailable('failed'));

    const id = ++this.nextId;
    const owned = Uint8Array.from(bytes); // the caller keeps its copy of the ring
    const deadlineMs = snapshotDeadlineMs(options) + (this.served ? 0 : COLD_START_ALLOWANCE_MS);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // If this thread was itself stalled past the deadline, the worker's reply may
        // already be waiting in the port. Let the poll phase deliver it before blaming
        // the worker: a healthy reply must not cost a healthy session its snapshots.
        setImmediate(() => {
          if (!this.pending.has(id)) return;
          const stuck = this.oldestPending();
          console.error(`[terminal-snapshot-worker] replay ran past ${deadlineMs} ms; terminating the worker`
            + (stuck?.sessionKey ? ` (session ${stuck.sessionKey} skipped for ${this.backoffMs} ms)` : ''));
          this.markStalled(stuck?.sessionKey);
          void this.retire('budget-exceeded');
        });
      }, deadlineMs);
      timer.unref?.();
      this.pending.set(id, { bytes: bytes.length, sessionKey: options.sessionKey, startedAt, resolve, timer });
      this.retainedBytes += bytes.length;
      try { worker.postMessage({ id, bytes: owned, options }, [owned.buffer]); }
      catch { this.finish(id, unavailable('failed')); }
    });
  }

  /** The worker runs one job at a time and takes messages in order: the oldest waiting job is the running one. */
  private oldestPending(): Pending | undefined {
    return this.pending.values().next().value;
  }

  private isBackingOff(sessionKey: string | undefined): boolean {
    if (!sessionKey) return false;
    const until = this.stalledSessions.get(sessionKey);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.stalledSessions.delete(sessionKey);
    return false;
  }

  private markStalled(sessionKey: string | undefined): void {
    if (!sessionKey || this.backoffMs <= 0) return;
    if (this.stalledSessions.size >= MAX_BACKOFF_ENTRIES) {
      for (const key of this.stalledSessions.keys()) { this.stalledSessions.delete(key); break; }
    }
    this.stalledSessions.set(sessionKey, Date.now() + this.backoffMs);
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
  options: TerminalSnapshotJobOptions,
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
