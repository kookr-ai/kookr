import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalRingReader } from '../adapters/terminal-ring-observer.js';
import type { TerminalStreamSnapshot } from '../shared/terminal-stream.js';
import { LiveScreenModelSet, type LiveScreenJob } from './terminal-live-screen.js';
import {
  estimateLiveScreenModelBytes,
  liveScreenBudgetFromEnv,
  liveScreenEnabledFromEnv,
  LiveScreenModels,
  type LiveScreenWorkerPort,
} from './terminal-live-screen-models.js';
import type { LiveScreenWorkerResult } from './terminal-snapshot-worker.js';

const encode = (text: string) => new TextEncoder().encode(text);
const ONE_MODEL = estimateLiveScreenModelBytes(80, 24);

/**
 * Stands in for the worker thread: runs every job, in order, through a real
 * model set in this thread, and records it. `refuse` makes it answer the way
 * a full worker does; `retire` imitates a stalled thread being terminated.
 */
class FakeWorker implements LiveScreenWorkerPort {
  readonly models = new LiveScreenModelSet();
  readonly jobs: Array<{ job: LiveScreenJob; bytes: number }> = [];
  refuse: LiveScreenWorkerResult | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly onRetire: (culprit: string | undefined) => void) {}
  get pendingBytes() { return 0; }
  get pendingJobs() { return 0; }
  live(job: LiveScreenJob, bytes: Uint8Array): Promise<LiveScreenWorkerResult> {
    this.jobs.push({ job, bytes: bytes.byteLength });
    if (this.refuse) return Promise.resolve(this.refuse);
    const copy = bytes.slice();
    const result = this.queue.then(() => this.models.run(job, copy));
    this.queue = result;
    return result;
  }
  retire(culprit?: string) { this.models.dispose(); this.onRetire(culprit); }
  async close() { this.models.dispose(); }
  ops(op: LiveScreenJob['op']) { return this.jobs.filter((entry) => entry.job.op === op); }
}

/** A session's ring as the backend holds it: positions, geometry, and the bytes it still retains. */
class FakeRing implements TerminalRingReader {
  private readonly rings = new Map<string, { all: Uint8Array; start: number; cols: number; rows: number }>();
  constructor(private readonly models: LiveScreenModels) {}
  captureStreamSnapshot(id: string): TerminalStreamSnapshot {
    const ring = this.rings.get(id)!;
    const end = ring.all.byteLength;
    return {
      bytes: ring.all.slice(ring.start), epoch: 'e', start: ring.start, end, geometryRevision: 1,
      cols: ring.cols, rows: ring.rows, originComplete: ring.start === 0,
    };
  }
  /** Retain `text` and tell the observer, the way `LocalDtachStream` does. */
  emit(id: string, text: string | Uint8Array, geometry = { cols: 80, rows: 24 }) {
    const bytes = typeof text === 'string' ? encode(text) : text;
    const ring = this.rings.get(id) ?? { all: new Uint8Array(0), start: 0, ...geometry };
    const start = ring.all.byteLength;
    const all = new Uint8Array(start + bytes.byteLength);
    all.set(ring.all, 0); all.set(bytes, start);
    this.rings.set(id, { ...ring, ...geometry, all });
    this.models.onRingAppend(id, bytes, { epoch: 'e', start, end: all.byteLength, geometryRevision: 1, ...geometry }, this);
  }
  /** Keep only the last `bytes` of the ring, as the fleet budget's shrink does. */
  shrink(id: string, bytes: number) {
    const ring = this.rings.get(id)!;
    ring.start = Math.max(0, ring.all.byteLength - bytes);
  }
}

const live: LiveScreenModels[] = [];
function setup(options: { budgetBytes?: number; flushMs?: number } = {}) {
  let worker!: FakeWorker;
  let now = 1_000;
  const models = new LiveScreenModels({
    budgetBytes: options.budgetBytes ?? 10 * ONE_MODEL,
    flushMs: options.flushMs ?? 10_000,
    createWorker: (onRetire) => (worker = new FakeWorker(onRetire)),
    now: () => now,
  });
  live.push(models);
  return { models, worker, ring: new FakeRing(models), advance: (ms: number) => { now += ms; } };
}
afterEach(async () => {
  for (const models of live.splice(0)) await models.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const seedOf = (models: LiveScreenModels, id: string) => models.seed(id, { cols: 80, rows: 24, maxBytes: 64 * 1024 });

describe('LiveScreenModels (issue #3564, step 2)', () => {
  it('builds a model from the ring on first output, then feeds it what follows', async () => {
    const { models, worker, ring } = setup();
    ring.emit('s', 'hello\r\n');
    expect(worker.ops('reset')).toEqual([{ job: expect.objectContaining({ sessionKey: 's', end: 7 }), bytes: 7 }]);
    ring.emit('s', 'world');
    ring.emit('s', '!');
    expect(worker.ops('feed')).toHaveLength(0); // coalesced on the host until a flush

    const seed = await seedOf(models, 's');
    // The seed flushed the waiting output first, as one job.
    expect(worker.ops('feed')).toEqual([{ job: expect.objectContaining({ start: 7, end: 13 }), bytes: 6 }]);
    expect(seed).toMatchObject({ kind: 'seed', epoch: 'e', end: 13 });
    expect(models.stats()).toMatchObject({ models: 1, estimatedBytes: ONE_MODEL, bootstraps: 1 });
  });

  it('keeps the screen after the ring shrinks below the base screen', async () => {
    const { models, ring } = setup();
    ring.emit('s', 'the base screen\r\nspinner: \r\n');
    for (let i = 0; i < 200; i++) ring.emit('s', `\x1b[1A\x1b[10G${i % 10}\x1b[1B\r`);
    ring.shrink('s', 64);
    expect(Buffer.from(ring.captureStreamSnapshot('s').bytes).toString()).not.toContain('base');
    const seed = await seedOf(models, 's');
    if (seed.kind !== 'seed') throw new Error('no seed');
    expect(Buffer.from(seed.bytes).toString()).toContain('the base screen');
    expect(Buffer.from(seed.bytes).toString()).toContain('spinner: 9');
  });

  it('flushes on a timer, and at once when a session has much output waiting', async () => {
    vi.useFakeTimers();
    const { worker, ring } = setup({ flushMs: 200 });
    ring.emit('s', 'a');
    ring.emit('s', 'b');
    expect(worker.ops('feed')).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(worker.ops('feed')).toHaveLength(1);
    ring.emit('s', new Uint8Array(64 * 1024).fill(65));
    expect(worker.ops('feed')).toHaveLength(2);
  });

  it('sends output written at a new geometry as a separate feed, after the old one', async () => {
    const { models, worker, ring } = setup();
    ring.emit('s', 'x');
    ring.emit('s', 'at 80x24');
    ring.emit('s', 'at 100x30', { cols: 100, rows: 30 });
    await models.seed('s', { cols: 100, rows: 30, maxBytes: 64 * 1024 });
    expect(worker.ops('feed').map(({ job }) => job.op === 'feed' && [job.cols, job.rows, job.start, job.end]))
      .toEqual([[80, 24, 1, 9], [100, 30, 9, 18]]);
    expect(models.stats().estimatedBytes).toBe(estimateLiveScreenModelBytes(100, 30));
  });

  it('drops a model that missed bytes and does not rebuild it before the cool-down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { models, worker, ring, advance } = setup();
    ring.emit('s', 'x');
    // A range that does not continue the model's position: bytes went missing.
    models.onRingAppend('s', encode('y'), { epoch: 'e', start: 5, end: 6, geometryRevision: 1, cols: 80, rows: 24 }, ring);
    expect(models.stats()).toMatchObject({ models: 0, desyncs: 1, estimatedBytes: 0 });
    expect(worker.ops('drop')).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped the screen model of s (desync)'));
    ring.emit('s', 'z');
    expect(worker.ops('reset')).toHaveLength(1);
    expect(await seedOf(models, 's')).toMatchObject({ kind: 'unavailable', reason: 'no-model' });
    advance(30_001);
    ring.emit('s', 'z');
    expect(worker.ops('reset')).toHaveLength(2);
  });

  it('drops the model when the worker refuses a feed, since the model is then behind', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { models, worker, ring } = setup();
    ring.emit('s', 'x');
    await seedOf(models, 's');
    worker.refuse = { kind: 'unavailable', reason: 'busy', elapsedMs: 0 };
    ring.emit('s', 'y');
    const result = await seedOf(models, 's');
    expect(result.kind).toBe('unavailable');
    expect(models.stats()).toMatchObject({ models: 0, desyncs: 1 });
  });

  it('plain output never evicts: a session that does not fit has no model', async () => {
    const { models, worker, ring } = setup({ budgetBytes: 2 * ONE_MODEL });
    ring.emit('a', 'a'); ring.emit('b', 'b'); ring.emit('c', 'c');
    expect(worker.ops('reset').map(({ job }) => job.sessionKey)).toEqual(['a', 'b']);
    expect(models.stats()).toMatchObject({ models: 2, evictions: 0 });
    // More output from c changes nothing, and does not even copy its ring.
    const capture = vi.spyOn(ring, 'captureStreamSnapshot');
    for (let i = 0; i < 50; i++) ring.emit('c', 'tick');
    expect(capture).not.toHaveBeenCalled();
    expect(models.stats().evictions).toBe(0);
  });

  it('an attach to a session without a model evicts the least recently seeded one and builds its model', async () => {
    const { models, worker, ring, advance } = setup({ budgetBytes: 2 * ONE_MODEL });
    ring.emit('a', 'a'); advance(10);
    ring.emit('b', 'b'); advance(10);
    ring.emit('c', 'c');
    await seedOf(models, 'a'); // a is now the most recently used
    advance(10);

    expect(await seedOf(models, 'c')).toMatchObject({ kind: 'unavailable', reason: 'no-model' });
    expect(models.stats()).toMatchObject({ models: 2, evictions: 1 });
    expect(worker.ops('drop').map(({ job }) => job.sessionKey)).toEqual(['b']);
    expect(await seedOf(models, 'c')).toMatchObject({ kind: 'seed' });
    expect(await seedOf(models, 'a')).toMatchObject({ kind: 'seed' });
    expect(await seedOf(models, 'b')).toMatchObject({ kind: 'unavailable', reason: 'no-model' });
  });

  it('a retired worker takes every model with it; they come back on output, two at a time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { models, worker, ring, advance } = setup();
    for (const id of ['a', 'b', 'c', 'd']) { ring.emit(id, id); await seedOf(models, id); }
    expect(models.stats().models).toBe(4);

    worker.retire('b');
    expect(models.stats()).toMatchObject({ models: 0, estimatedBytes: 0, workerRetires: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('b stalled the screen-model worker; not modelled again for 60 s'));

    const resetsBefore = worker.ops('reset').length;
    for (const id of ['a', 'b', 'c', 'd']) ring.emit(id, '.');
    // b is cooling down; of the others, two bootstraps run at once.
    expect(worker.ops('reset').slice(resetsBefore).map(({ job }) => job.sessionKey)).toEqual(['a', 'c']);
    await seedOf(models, 'a');
    ring.emit('d', '.');
    expect(worker.ops('reset').slice(resetsBefore).map(({ job }) => job.sessionKey)).toEqual(['a', 'c', 'd']);

    // The culprit's cool-down doubles each time it stalls the worker again.
    advance(60_001);
    ring.emit('b', '.');
    expect(worker.ops('reset').at(-1)?.job.sessionKey).toBe('b');
    worker.retire('b');
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('not modelled again for 120 s'));
  });

  it('ignores answers from a worker that was retired since the job was sent', async () => {
    const { models, worker, ring } = setup();
    ring.emit('s', 'x');
    const pending = seedOf(models, 's');
    worker.retire(undefined);
    expect(await pending).toMatchObject({ kind: 'unavailable', reason: 'worker-restarted' });
    expect(models.stats().models).toBe(0);
  });

  it('a disposed session frees its share of the budget', async () => {
    const { models, worker, ring } = setup();
    ring.emit('s', 'x');
    models.onSessionDisposed('s');
    expect(models.stats()).toMatchObject({ models: 0, estimatedBytes: 0, desyncs: 0 });
    expect(worker.ops('drop')).toHaveLength(1);
    expect(await seedOf(models, 's')).toMatchObject({ kind: 'unavailable', reason: 'no-model' });
  });

  it('a closed registry ignores output and refuses seeds', async () => {
    const { models, worker, ring } = setup();
    await models.close();
    ring.emit('s', 'x');
    expect(worker.jobs).toHaveLength(0);
    expect(await seedOf(models, 's')).toMatchObject({ kind: 'unavailable', reason: 'closed' });
  });
});

describe('live screen switch and budget from the environment', () => {
  it('is on by default and off for the usual false values or a zero budget', () => {
    expect(liveScreenEnabledFromEnv({})).toBe(true);
    for (const off of ['0', 'false', 'OFF', ' no ']) expect(liveScreenEnabledFromEnv({ KOOKR_TERMINAL_LIVE_SCREEN: off })).toBe(false);
    expect(liveScreenEnabledFromEnv({ KOOKR_TERMINAL_LIVE_SCREEN: '1' })).toBe(true);
    expect(liveScreenEnabledFromEnv({ KOOKR_TERMINAL_LIVE_SCREEN_BUDGET_BYTES: '0' })).toBe(false);
  });

  it('reads the budget, ignoring values that are not a non-negative integer', () => {
    expect(liveScreenBudgetFromEnv({})).toBe(48 * 1024 * 1024);
    expect(liveScreenBudgetFromEnv({ KOOKR_TERMINAL_LIVE_SCREEN_BUDGET_BYTES: '1048576' })).toBe(1048576);
    for (const bad of ['-1', 'lots', '1.5']) {
      expect(liveScreenBudgetFromEnv({ KOOKR_TERMINAL_LIVE_SCREEN_BUDGET_BYTES: bad })).toBe(48 * 1024 * 1024);
    }
  });
});
