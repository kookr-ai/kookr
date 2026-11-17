/**
 * Live screen models, host side (issue #3564, step 2).
 *
 * Decides which sessions keep a live terminal emulator, feeds those emulators
 * with every byte their ring retains, and asks one for a seed when a browser
 * attaches. The emulators themselves live in a worker thread
 * (`terminal-live-screen.ts`), behind the same deadline, terminate-and-respawn
 * and per-session backoff as the step-1 snapshot worker. It is a separate
 * instance of that worker: a live feed that stalls the parser costs the live
 * models, while the ring-replay fallback keeps working in its own thread.
 *
 * On the PTY data path this class only appends the bytes to a per-session
 * buffer. A timer flushes the buffers to the worker as one job per session,
 * so a busy agent costs a few messages a second rather than one per read.
 *
 * Memory: each model is charged an estimate from its geometry against a fleet
 * budget. Output never evicts a model: a session that does not fit simply has
 * none, so many chattering sessions over budget cannot thrash. An attach to a
 * session without a model evicts the least recently seeded one and builds a
 * model for the next attach. Attaches happen at human pace, and so do
 * evictions.
 *
 * Every failure is soft. A session without a usable model falls back to the
 * step-1 seed (a replay of the ring, or the ring itself).
 */

import { performance } from 'node:perf_hooks';
import type { TerminalRingObserver, TerminalRingReader } from '../adapters/terminal-ring-observer.js';
import type { TerminalSourceRange } from '../shared/terminal-stream.js';
import { LIVE_SCREEN_SCROLLBACK_ROWS, type LiveScreenJob } from './terminal-live-screen.js';
import { TerminalSnapshotWorker, type LiveScreenWorkerResult } from './terminal-snapshot-worker.js';

/** Default fleet budget for the models' estimated memory: about 100 sessions at 120x40. */
export const DEFAULT_LIVE_SCREEN_BUDGET_BYTES = 48 * 1024 * 1024;
/** How long output may wait on the host before it is sent to the worker. */
const DEFAULT_FLUSH_MS = 200;
/** Flush a session at once when this much output is waiting. */
const FLUSH_BYTES = 64 * 1024;
/** Bootstraps (ring replays) allowed in flight at once. */
const MAX_BOOTSTRAPS_IN_FLIGHT = 2;
/**
 * Deadline for one job: a base, plus time for the work queued ahead of it in
 * the worker. Bytes get about 1 ms per KiB (ten times the measured parse cost),
 * jobs 5 ms each (a job costs about 1.7 ms of timer turns measured on a loaded
 * host). A real parser stall, which this exists to catch, runs for tens of
 * seconds.
 */
const JOB_BASE_DEADLINE_MS = 2500;
const JOB_DEADLINE_MS_PER_KIB = 1;
const JOB_DEADLINE_MS_PER_QUEUED_JOB = 5;
/**
 * In-flight caps for the live worker. Every modelled session can flush on the
 * same timer tick, so the job cap is well above any fleet size; the byte cap is
 * the real backpressure. A refused feed costs that session its model.
 */
const WORKER_MAX_PENDING_JOBS = 1024;
const WORKER_MAX_RETAINED_BYTES = 16 * 1024 * 1024;
/** A model dropped because it lost bytes (worker busy, out-of-order feed) may be rebuilt after this. */
const DESYNC_COOLDOWN_MS = 30_000;
/** A session blamed for stalling the worker is not modelled again for this long, doubling per repeat. */
const STALL_COOLDOWN_MS = 60_000;
const MAX_STALL_COOLDOWN_MS = 60 * 60_000;
/** How often the installed registry logs its stats, when they changed (issue #4067). */
export const LIVE_SCREEN_STATS_LOG_MS = 5 * 60_000;
/** Bytes per emulator cell (xterm stores three 32-bit words per cell) plus fixed overhead per model. */
const CELL_BYTES = 12;
const MODEL_OVERHEAD_BYTES = 64 * 1024;

/**
 * Estimated memory of a model at this geometry: the normal buffer with its
 * scrollback, the alternate screen, and a fixed overhead. Measured in-thread
 * at 0.39 MiB for 120x40 and 0.57 MiB for 200x50 (estimate 0.41 / 0.66 MiB).
 */
export function estimateLiveScreenModelBytes(cols: number, rows: number): number {
  return cols * (rows + LIVE_SCREEN_SCROLLBACK_ROWS) * CELL_BYTES + cols * rows * CELL_BYTES + MODEL_OVERHEAD_BYTES;
}

export type LiveScreenSeedResult =
  | {
    kind: 'seed';
    /** Serialized screen, then raw bytes the model has not parsed yet. Paints into a freshly reset terminal. */
    bytes: Uint8Array;
    /** Ring source epoch and position the seed represents: live output continues from `end`. */
    epoch: string;
    end: number;
    elapsedMs: number;
  }
  | { kind: 'unavailable'; reason: string; elapsedMs: number };

/** What `SessionBridge` needs: a seed for a session, at the PTY geometry it just applied. */
export interface LiveScreenSeedSource {
  seed(sessionId: string, request: { cols: number; rows: number; maxBytes: number }): Promise<LiveScreenSeedResult>;
}

/** The part of `TerminalSnapshotWorker` the registry uses; a fake stands in for it in tests. */
export interface LiveScreenWorkerPort {
  live(job: LiveScreenJob, bytes: Uint8Array, deadlineMs: number): Promise<LiveScreenWorkerResult>;
  readonly pendingBytes: number;
  readonly pendingJobs: number;
  /** The retired thread is still terminating: jobs sent now are refused, so wait for the next output. */
  readonly restarting: boolean;
  close(): Promise<void>;
}

export interface LiveScreenModelsOptions {
  budgetBytes?: number;
  flushMs?: number;
  /** Build the worker; `onRetire` must be called when the thread is retired. Tests inject a fake. */
  createWorker?: (onRetire: (culprit: string | undefined) => void) => LiveScreenWorkerPort;
  now?: () => number;
  /**
   * Log a stats line this often, skipping intervals in which nothing changed.
   * Off when absent or 0. `installLiveScreenModelsFromEnv` turns it on.
   */
  statsLogMs?: number;
}

export interface LiveScreenModelsStats {
  models: number;
  estimatedBytes: number;
  budgetBytes: number;
  bootstraps: number;
  evictions: number;
  desyncs: number;
  workerRetires: number;
}

interface SessionState {
  id: string;
  /** Whether the worker holds a model for this session that has seen every byte up to `end`. */
  modelled: boolean;
  epoch: string;
  /** Source position after the last byte handed to the model (sent or waiting in `pending`). */
  end: number;
  cols: number;
  rows: number;
  /** Output not yet sent to the worker, all at `pendingCols` x `pendingRows`, starting at `pendingStart`. */
  pending: Uint8Array[];
  pendingBytes: number;
  pendingStart: number;
  pendingCols: number;
  pendingRows: number;
  estimateBytes: number;
  /** When the model was built or last served a seed: eviction order. */
  lastUsedAt: number;
  /** No model is built before this time. */
  retryAfter: number;
  /** Stalls this session has been blamed for: the cool-down doubles with each. */
  stalls: number;
  /** Bumped per model built: a late answer about an earlier model must not drop this one. */
  incarnation: number;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!.slice();
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

export class LiveScreenModels implements TerminalRingObserver, LiveScreenSeedSource {
  private readonly sessions = new Map<string, SessionState>();
  private readonly dirty = new Set<SessionState>();
  private readonly worker: LiveScreenWorkerPort;
  private readonly budgetBytes: number;
  private readonly flushMs: number;
  private readonly now: () => number;
  private ring: TerminalRingReader | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private estimatedBytes = 0;
  private bootstrapsInFlight = 0;
  /** Bumped when the worker thread is retired: results of jobs sent to an older thread are ignored. */
  private generation = 0;
  private closed = false;
  private readonly counters = { bootstraps: 0, evictions: 0, desyncs: 0, workerRetires: 0 };
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  /** The stats the last log line showed, and when: the next line reports the change since. */
  private lastLogged: { stats: LiveScreenModelsStats; at: number } | null = null;

  constructor(options: LiveScreenModelsOptions = {}) {
    this.budgetBytes = options.budgetBytes ?? DEFAULT_LIVE_SCREEN_BUDGET_BYTES;
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
    this.now = options.now ?? (() => performance.now());
    const onRetire = (culprit: string | undefined) => this.onWorkerRetired(culprit);
    this.worker = options.createWorker?.(onRetire) ?? new TerminalSnapshotWorker({
      maxPendingJobs: WORKER_MAX_PENDING_JOBS,
      maxRetainedBytes: WORKER_MAX_RETAINED_BYTES,
      onRetire,
    });
    if (options.statsLogMs && options.statsLogMs > 0) {
      this.lastLogged = { stats: this.stats(), at: this.now() };
      this.statsTimer = setInterval(() => this.logStats(), options.statsLogMs);
      this.statsTimer.unref?.();
    }
  }

  stats(): LiveScreenModelsStats {
    let models = 0;
    for (const state of this.sessions.values()) if (state.modelled) models++;
    return { models, estimatedBytes: this.estimatedBytes, budgetBytes: this.budgetBytes, ...this.counters };
  }

  /**
   * One line for operators: models and estimated memory against the budget
   * (pressure), and how many bootstraps, evictions, desyncs and worker retires
   * happened since the last line (thrash). Nothing is logged when nothing
   * changed, so an idle host stays quiet.
   */
  logStats(): void {
    const stats = this.stats();
    const at = this.now();
    const last = this.lastLogged;
    if (last && (Object.keys(stats) as Array<keyof LiveScreenModelsStats>).every((key) => stats[key] === last.stats[key])) return;
    const mib = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
    const percent = stats.budgetBytes > 0 ? Math.round((stats.estimatedBytes / stats.budgetBytes) * 100) : 0;
    const delta = (key: 'bootstraps' | 'evictions' | 'desyncs' | 'workerRetires') =>
      `${key}=+${stats[key] - (last?.stats[key] ?? 0)} (total ${stats[key]})`;
    const window = last ? ` over the last ${Math.round((at - last.at) / 1000)} s` : '';
    console.log(`[terminal-live-screen] stats${window}: models=${stats.models}`
      + ` estimated=${mib(stats.estimatedBytes)}/${mib(stats.budgetBytes)} MiB (${percent}% of budget)`
      + ` ${delta('bootstraps')} ${delta('evictions')} ${delta('desyncs')} ${delta('workerRetires')}`);
    this.lastLogged = { stats, at };
  }

  // ── PTY data path ────────────────────────────────────────────────────────

  onRingAppend(id: string, bytes: Uint8Array, range: TerminalSourceRange, ring: TerminalRingReader): void {
    if (this.closed || bytes.byteLength === 0) return;
    this.ring = ring;
    let state = this.sessions.get(id);
    if (!state) {
      state = {
        id, modelled: false, epoch: range.epoch, end: range.end, cols: range.cols, rows: range.rows,
        pending: [], pendingBytes: 0, pendingStart: range.end, pendingCols: range.cols, pendingRows: range.rows,
        estimateBytes: 0, lastUsedAt: this.now(), retryAfter: 0, stalls: 0, incarnation: 0,
      };
      this.sessions.set(id, state);
    }
    if (!state.modelled) {
      state.cols = range.cols;
      state.rows = range.rows;
      // The ring already holds these bytes, so a bootstrap from it covers them.
      this.bootstrap(state, false);
      return;
    }
    if (range.start !== state.end) {
      // Bytes went missing between the ring and the model. Never seed from it.
      this.invalidate(state, 'desync', DESYNC_COOLDOWN_MS);
      return;
    }
    if (state.pendingBytes > 0 && (range.cols !== state.pendingCols || range.rows !== state.pendingRows)) {
      // The geometry changed: what was written at the old size goes first.
      this.flush(state);
    }
    if (state.pendingBytes === 0) {
      state.pendingStart = range.start;
      state.pendingCols = range.cols;
      state.pendingRows = range.rows;
    }
    state.pending.push(bytes);
    state.pendingBytes += bytes.byteLength;
    state.end = range.end;
    state.epoch = range.epoch;
    if (state.cols !== range.cols || state.rows !== range.rows) this.setGeometry(state, range.cols, range.rows);
    if (state.pendingBytes >= FLUSH_BYTES) this.flush(state);
    else this.scheduleFlush(state);
  }

  onSessionDisposed(id: string): void {
    const state = this.sessions.get(id);
    if (!state) return;
    this.invalidate(state, 'disposed', 0);
    this.sessions.delete(id);
  }

  // ── Attach ───────────────────────────────────────────────────────────────

  async seed(sessionId: string, request: { cols: number; rows: number; maxBytes: number }): Promise<LiveScreenSeedResult> {
    const startedAt = this.now();
    const unavailable = (reason: string): LiveScreenSeedResult => ({ kind: 'unavailable', reason, elapsedMs: this.now() - startedAt });
    if (this.closed) return unavailable('closed');
    const state = this.sessions.get(sessionId);
    if (!state) return unavailable('no-model');
    if (!state.modelled) {
      // Build one for the next attach; this one falls back.
      this.bootstrap(state, true);
      return unavailable('no-model');
    }
    this.flush(state);
    state.lastUsedAt = this.now();
    const generation = this.generation;
    const incarnation = state.incarnation;
    const job: LiveScreenJob = { op: 'seed', sessionKey: sessionId, cols: request.cols, rows: request.rows, maxBytes: request.maxBytes };
    const result = await this.worker.live(job, new Uint8Array(0), this.deadlineMs(0));
    if (generation !== this.generation) return unavailable('worker-restarted');
    if (result.kind === 'seed') {
      this.setGeometry(state, request.cols, request.rows);
      return { kind: 'seed', bytes: result.bytes, epoch: result.epoch, end: result.end, elapsedMs: this.now() - startedAt };
    }
    if (result.kind === 'unavailable' && incarnation === state.incarnation
      && (result.reason === 'no-model' || result.reason === 'desync')) {
      // The worker no longer has the model this registry believed in.
      this.invalidate(state, result.reason, DESYNC_COOLDOWN_MS);
    }
    return unavailable(result.kind === 'unavailable' ? result.reason : 'failed');
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private bootstrap(state: SessionState, forAttach: boolean): void {
    const ring = this.ring;
    if (!ring || state.modelled || this.closed) return;
    if (this.now() < state.retryAfter || this.bootstrapsInFlight >= MAX_BOOTSTRAPS_IN_FLIGHT) return;
    // The retired thread is still terminating and would refuse the job. No
    // cool-down: the session's next output tries again (issue #4067).
    if (this.worker.restarting) return;
    // Output never evicts (see the module comment); an attach does. Checked
    // before the ring is copied: this runs on every chunk of a session that
    // does not fit.
    if (!forAttach && this.estimatedBytes + estimateLiveScreenModelBytes(state.cols, state.rows) > this.budgetBytes) return;
    let snapshot;
    try { snapshot = ring.captureStreamSnapshot(state.id); }
    catch { return; }
    const estimate = estimateLiveScreenModelBytes(snapshot.cols, snapshot.rows);
    if (this.estimatedBytes + estimate > this.budgetBytes && (!forAttach || !this.evictFor(estimate, state))) return;
    state.modelled = true;
    state.epoch = snapshot.epoch;
    state.end = snapshot.end;
    state.cols = snapshot.cols;
    state.rows = snapshot.rows;
    state.pending = [];
    state.pendingBytes = 0;
    state.estimateBytes = estimate;
    state.lastUsedAt = this.now();
    this.estimatedBytes += estimate;
    this.bootstrapsInFlight++;
    this.counters.bootstraps++;
    const generation = this.generation;
    const incarnation = ++state.incarnation;
    const job: LiveScreenJob = {
      op: 'reset', sessionKey: state.id, epoch: snapshot.epoch, end: snapshot.end, cols: snapshot.cols, rows: snapshot.rows,
    };
    void this.worker.live(job, snapshot.bytes, this.deadlineMs(snapshot.bytes.byteLength)).then((result) => {
      if (generation !== this.generation) return;
      this.bootstrapsInFlight--;
      if (result.kind === 'unavailable' && incarnation === state.incarnation) {
        // Refused only because the old thread was still terminating: retry on the next output.
        // The `restarting` check above runs in the same tick as the send, so this is a backstop
        // for a worker port that starts restarting between the two.
        if (result.reason === 'restarting') this.invalidate(state, 'restarting', 0);
        else this.invalidate(state, `bootstrap ${result.reason}`, DESYNC_COOLDOWN_MS);
      }
    });
  }

  private flush(state: SessionState): void {
    this.dirty.delete(state);
    if (!state.modelled || state.pendingBytes === 0) return;
    const bytes = concatChunks(state.pending, state.pendingBytes);
    const job: LiveScreenJob = {
      op: 'feed', sessionKey: state.id, epoch: state.epoch, start: state.pendingStart, end: state.pendingStart + bytes.byteLength,
      cols: state.pendingCols, rows: state.pendingRows,
    };
    state.pending = [];
    state.pendingBytes = 0;
    const generation = this.generation;
    const incarnation = state.incarnation;
    void this.worker.live(job, bytes, this.deadlineMs(bytes.byteLength)).then((result) => {
      if (generation !== this.generation || incarnation !== state.incarnation || this.sessions.get(state.id) !== state) return;
      // A refused feed (busy, backoff) leaves the model behind the ring for good.
      if (result.kind === 'unavailable') this.invalidate(state, `feed ${result.reason}`, DESYNC_COOLDOWN_MS);
    });
  }

  private scheduleFlush(state: SessionState): void {
    this.dirty.add(state);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      for (const dirty of [...this.dirty]) this.flush(dirty);
    }, this.flushMs);
    this.flushTimer.unref?.();
  }

  private deadlineMs(bytes: number): number {
    return JOB_BASE_DEADLINE_MS + Math.ceil((this.worker.pendingBytes + bytes) / 1024) * JOB_DEADLINE_MS_PER_KIB
      + this.worker.pendingJobs * JOB_DEADLINE_MS_PER_QUEUED_JOB;
  }

  private setGeometry(state: SessionState, cols: number, rows: number): void {
    state.cols = cols;
    state.rows = rows;
    if (!state.modelled) return;
    const estimate = estimateLiveScreenModelBytes(cols, rows);
    this.estimatedBytes += estimate - state.estimateBytes;
    state.estimateBytes = estimate;
    if (this.estimatedBytes > this.budgetBytes) this.evictFor(0, state);
  }

  /** Drop least recently used models until `bytes` more fit. Never evicts `keep`. */
  private evictFor(bytes: number, keep: SessionState): boolean {
    const candidates = [...this.sessions.values()]
      .filter((state) => state.modelled && state !== keep)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const victim of candidates) {
      if (this.estimatedBytes + bytes <= this.budgetBytes) break;
      this.invalidate(victim, 'evicted', 0);
      this.counters.evictions++;
    }
    return this.estimatedBytes + bytes <= this.budgetBytes;
  }

  private invalidate(state: SessionState, reason: string, cooldownMs: number): void {
    this.dirty.delete(state);
    state.pending = [];
    state.pendingBytes = 0;
    if (cooldownMs > 0) state.retryAfter = Math.max(state.retryAfter, this.now() + cooldownMs);
    if (!state.modelled) return;
    state.modelled = false;
    this.estimatedBytes -= state.estimateBytes;
    state.estimateBytes = 0;
    if (reason !== 'evicted' && reason !== 'disposed' && reason !== 'restarting') {
      this.counters.desyncs++;
      console.warn(`[terminal-live-screen] dropped the screen model of ${state.id} (${reason}); its attaches replay the ring meanwhile`);
    }
    void this.worker.live({ op: 'drop', sessionKey: state.id }, new Uint8Array(0), this.deadlineMs(0));
  }

  private onWorkerRetired(culprit: string | undefined): void {
    // Every model died with the thread. Rebuild them from their rings as output
    // arrives, two at a time; the session blamed for the stall waits longer.
    this.generation++;
    this.counters.workerRetires++;
    this.bootstrapsInFlight = 0;
    this.estimatedBytes = 0;
    this.dirty.clear();
    for (const state of this.sessions.values()) {
      state.modelled = false;
      state.estimateBytes = 0;
      state.pending = [];
      state.pendingBytes = 0;
      if (state.id === culprit) {
        state.stalls++;
        const cooldown = Math.min(MAX_STALL_COOLDOWN_MS, STALL_COOLDOWN_MS * 2 ** (state.stalls - 1));
        state.retryAfter = this.now() + cooldown;
        console.warn(`[terminal-live-screen] ${state.id} stalled the screen-model worker; not modelled again for ${Math.round(cooldown / 1000)} s`);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.sessions.clear();
    this.dirty.clear();
    await this.worker.close();
  }
}

// ── Process-wide wiring ────────────────────────────────────────────────────

let installed: LiveScreenModels | null = null;

/** Off when `KOOKR_TERMINAL_LIVE_SCREEN` is 0/false/off/no, or the budget is 0. */
export function liveScreenEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.KOOKR_TERMINAL_LIVE_SCREEN?.trim().toLowerCase();
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no') && liveScreenBudgetFromEnv(env) > 0;
}

export function liveScreenBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KOOKR_TERMINAL_LIVE_SCREEN_BUDGET_BYTES?.trim();
  if (!raw) return DEFAULT_LIVE_SCREEN_BUDGET_BYTES;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_LIVE_SCREEN_BUDGET_BYTES;
}

/**
 * Create this process's live screen models, unless the switch is off, and
 * make them the default seed source of every `SessionBridge`. The caller
 * passes the result to `LocalDtachBackend` as its `ringObserver`. Returns
 * null when off: no observer, no thread, attach behaves exactly as before.
 */
export function installLiveScreenModelsFromEnv(env: NodeJS.ProcessEnv = process.env): LiveScreenModels | null {
  if (installed) return installed;
  if (!liveScreenEnabledFromEnv(env)) {
    console.log('[terminal-live-screen] off (KOOKR_TERMINAL_LIVE_SCREEN); attaches replay the ring');
    return null;
  }
  installed = new LiveScreenModels({ budgetBytes: liveScreenBudgetFromEnv(env), statsLogMs: LIVE_SCREEN_STATS_LOG_MS });
  console.log(`[terminal-live-screen] on: budget ${liveScreenBudgetFromEnv(env)} bytes`);
  return installed;
}

/** The installed models, or null (switch off, or not wired in this process). */
export function getInstalledLiveScreenModels(): LiveScreenModels | null {
  return installed;
}

/** Stop the installed models (process shutdown, tests). */
export async function closeInstalledLiveScreenModels(): Promise<void> {
  const models = installed;
  installed = null;
  await models?.close();
}
