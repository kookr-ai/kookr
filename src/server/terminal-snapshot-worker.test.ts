import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { snapshotStreamingAttachSeed } from './streaming-attach-snapshot.js';
import { TerminalSnapshotWorker } from './terminal-snapshot-worker.js';
import { diffRenderedAgentStream, SPINNER_ONLY_FRAMES } from './__fixtures__/diff-rendered-agent-stream.js';

const workers: TerminalSnapshotWorker[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  vi.restoreAllMocks();
});

const encode = (text: string) => new TextEncoder().encode(text);
const geometry = { cols: 80, rows: 24 };
function newWorker(options?: ConstructorParameters<typeof TerminalSnapshotWorker>[0]) {
  const worker = new TerminalSnapshotWorker(options); workers.push(worker); return worker;
}

/**
 * Start the worker and wait until it has answered once, so the start-up time of a
 * thread that loads tsx first (seconds on a busy host) is not charged to the tight
 * deadline of the job under test. Retries because a start that misses even the
 * cold-start allowance retires the worker and the next call begins a fresh one.
 */
async function warmUp(worker: TerminalSnapshotWorker) {
  await vi.waitFor(async () => {
    expect((await worker.snapshot(encode('warm up\r\n'), geometry)).kind).toBe('snapshot');
  }, { timeout: 25_000, interval: 200 });
}

/**
 * A ring that stalls the emulator's parser. `ESC[999999999b` asks it to repeat
 * the previous character a billion times, one synchronous call; measured at
 * tens of seconds in xterm 6. The last escape character of a ring is left raw
 * by the snapshot, so this one must come before another to be emulated.
 */
const poisonedRing = encode(`${'plain output line\r\n'.repeat(500)}x\x1b[999999999bmore text\x1b[0m`);

// A worker thread started from TypeScript source loads tsx first, which is slow on a busy host.
describe('isolated screen-snapshot seeds (issue #3564)', { timeout: 30_000 }, () => {
  it('builds the same seed in a worker thread as in the calling thread', async () => {
    const stream = diffRenderedAgentStream(SPINNER_ONLY_FRAMES);
    const inThread = await snapshotStreamingAttachSeed(stream.bytes, geometry);
    const isolated = await newWorker().snapshot(stream.bytes, geometry);
    if (inThread.kind !== 'snapshot' || isolated.kind !== 'snapshot') throw new Error('snapshot unavailable');
    expect(Buffer.from(isolated.bytes).equals(Buffer.from(inThread.bytes))).toBe(true);
    expect(isolated).toMatchObject({ emulatedBytes: inThread.emulatedBytes, rawTailBytes: inThread.rawTailBytes });
    expect(stream.bytes.byteLength).toBeGreaterThan(0); // the caller's ring was copied, not detached
  });

  it('terminates a worker stuck in the parser without blocking the host thread, and recovers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const worker = newWorker();
    await warmUp(worker);
    terminate.mockClear(); // a warm-up that had to retry may have retired a worker

    let longestGapMs = 0;
    let last = performance.now();
    const ticker = setInterval(() => { const now = performance.now(); longestGapMs = Math.max(longestGapMs, now - last); last = now; }, 20);
    const startedAt = performance.now();
    const result = await worker.snapshot(poisonedRing, { ...geometry, maxMs: 150, maxQueueWaitMs: 50 });
    const waitedMs = performance.now() - startedAt;
    clearInterval(ticker);

    expect(result).toMatchObject({ kind: 'unavailable', reason: 'budget-exceeded' });
    // Giving up is not enough: the thread must actually be stopped, or it keeps a core busy.
    expect(terminate).toHaveBeenCalledTimes(1);
    // The same ring takes tens of seconds in the calling thread (about 36 s measured).
    // The host waited for its 700 ms deadline, plus whatever a loaded machine adds, and
    // its own timers kept running; the bounds are wide only to survive load, not the stall.
    expect(waitedMs).toBeLessThan(10_000);
    expect(longestGapMs).toBeLessThan(10_000);
    expect(worker.pendingBytes).toBe(0);

    // The stuck thread is gone; a later attach gets a fresh worker and a real seed.
    await vi.waitFor(async () => {
      expect((await worker.snapshot(encode('after the stall\r\n'), geometry)).kind).toBe('snapshot');
    }, { timeout: 20_000, interval: 100 });
  });

  it('fails jobs waiting behind a stuck one instead of leaving them hanging', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const worker = newWorker();
    await warmUp(worker);
    const options = { ...geometry, maxMs: 150, maxQueueWaitMs: 50 };
    const results = await Promise.all([
      worker.snapshot(poisonedRing, options),
      worker.snapshot(encode('queued behind the stall\r\n'), options),
    ]);
    expect(results.map((result) => result.kind)).toEqual(['unavailable', 'unavailable']);
    expect(worker.pendingBytes).toBe(0);
  });

  it('skips a session whose ring stalled the worker, for a while, and only that session', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const worker = newWorker({ backoffMs: 1500 });
    await warmUp(worker);
    const tight = { ...geometry, maxMs: 150, maxQueueWaitMs: 50 };
    expect(await worker.snapshot(poisonedRing, { ...tight, sessionKey: 'poisoned' }))
      .toMatchObject({ kind: 'unavailable', reason: 'budget-exceeded' });

    // The stuck session is refused at once, without starting a worker or burning a deadline...
    const refusedAt = performance.now();
    expect(await worker.snapshot(encode('clean ring\r\n'), { ...geometry, sessionKey: 'poisoned' }))
      .toMatchObject({ kind: 'unavailable', reason: 'backoff' });
    expect(performance.now() - refusedAt).toBeLessThan(1000);
    // ...while another session, and a job with no session at all, are served.
    await vi.waitFor(async () => {
      expect((await worker.snapshot(encode('other session\r\n'), { ...geometry, sessionKey: 'healthy' })).kind).toBe('snapshot');
    }, { timeout: 20_000, interval: 100 });
    expect((await worker.snapshot(encode('no session\r\n'), geometry)).kind).toBe('snapshot');

    // The penalty expires, so a ring that has since been cleared of the poison is replayed again.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect((await worker.snapshot(encode('poison has left the ring\r\n'), { ...geometry, sessionKey: 'poisoned' })).kind).toBe('snapshot');
  });

  it('does not penalize a session for a job that merely sat behind a healthy one', async () => {
    const worker = newWorker({ backoffMs: 60_000 });
    await warmUp(worker);
    const bytes = encode('line of output\r\n'.repeat(2000));
    const results = await Promise.all([
      worker.snapshot(bytes, { ...geometry, sessionKey: 'a' }),
      worker.snapshot(bytes, { ...geometry, sessionKey: 'b' }),
    ]);
    expect(results.map((result) => result.kind)).toEqual(['snapshot', 'snapshot']);
    expect((await worker.snapshot(bytes, { ...geometry, sessionKey: 'a' })).kind).toBe('snapshot');
  });

  it('refuses work it cannot retain, and nothing at all once closed', async () => {
    const worker = newWorker();
    expect(await worker.snapshot(new Uint8Array(0), geometry)).toMatchObject({ kind: 'unavailable', reason: 'empty' });
    expect(await worker.snapshot(new Uint8Array(9 * 1024 * 1024), geometry)).toMatchObject({ kind: 'unavailable', reason: 'busy' });
    expect(worker.pendingBytes).toBe(0);

    const pending = worker.snapshot(encode('hello '.repeat(100)), geometry);
    await worker.close();
    expect(await pending).toMatchObject({ kind: 'unavailable' });
    expect(await worker.snapshot(encode('after close'), geometry)).toMatchObject({ kind: 'unavailable', reason: 'failed' });
    expect(worker.pendingBytes).toBe(0);
  });
});
