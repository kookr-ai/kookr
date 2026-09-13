import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendDispositionEntry, readDispositionEntries, type DispositionEntry } from '../core/disposition-ledger.js';
import { BoundedReaperEvidence, writeReaperAuditRow } from './bounded-reaper-evidence.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('bounded reaper evidence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); });

  test('retains at most one unresolved write per kind after timeout, without queuing retries', async () => {
    const bounded = new BoundedReaperEvidence(20);
    const disposition = deferred();
    const audit = deferred();
    const writeDisposition = vi.fn(() => disposition.promise);
    const writeAudit = vi.fn(() => audit.promise);
    const first = bounded.write('disposition', writeDisposition, 'task A:');
    const second = bounded.write('audit', writeAudit, 'task A:');
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toBe('timeout');
    expect(await second).toBe('timeout');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('durability unknown'));
    for (let i = 0; i < 100; i += 1) {
      expect(await bounded.write('disposition', writeDisposition, 'task B:')).toBe('busy');
      expect(await bounded.write('audit', writeAudit, 'task B:')).toBe('busy');
    }
    expect(writeDisposition).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    disposition.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toBe('timeout'); // Late success does not rewrite the caller's outcome.
    expect(await bounded.write('disposition', async () => {}, 'task C:')).toBe('ok');
    expect(await bounded.write('audit', writeAudit, 'task C:')).toBe('busy');
    audit.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(['disposition', 'audit'] as const)('observes a late %s rejection and admits a later write', async (kind) => {
    const bounded = new BoundedReaperEvidence(20);
    const write = deferred();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const result = bounded.write(kind, () => write.promise, 'task A:');
      await vi.advanceTimersByTimeAsync(20);
      expect(await result).toBe('timeout');
      write.reject(new Error('late fsync failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`${kind} evidence late failure`));
      expect(await bounded.write(kind, async () => {}, 'task B:')).toBe('ok');
      expect(await result).toBe('timeout');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('reports synchronous throws and rejected writes as errors, then frees the slot', async () => {
    const bounded = new BoundedReaperEvidence();
    expect(await bounded.write('disposition', () => { throw new Error('sync throw'); }, 'task:')).toBe('error');
    expect(await bounded.write('disposition', async () => { throw new Error('rejected'); }, 'task:')).toBe('error');
    expect(await bounded.write('disposition', async () => {}, 'task:')).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([0, -1, NaN, Infinity])('rejects an unbounded timeout configuration: %s', (timeout) => {
    expect(() => new BoundedReaperEvidence(timeout)).toThrow(RangeError);
  });
});

describe('real evidence writers', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bounded-reaper-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('does not report disposition success before the real ledger fsync completes', async () => {
    const probe = await open(join(dir, 'probe'), 'a');
    const proto = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const originalSync = proto.sync;
    const syncing = deferred();
    const allowSync = deferred();
    const sync = vi.spyOn(proto, 'sync').mockImplementation(async function (this: FileHandle) {
      syncing.resolve();
      await allowSync.promise;
      await originalSync.call(this);
    });
    const entry: DispositionEntry = {
      schemaVersion: 'disposition-ledger.v1', taskId: 'reaped-task', disposition: 'needs-human',
      detail: 'needs-human: reaped without confirmed delivery', incidentId: 'test-reap',
      source: 'hung-task-reaper', at: '2026-09-13T00:00:00.000Z',
    };
    const ledgerPath = join(dir, 'dispositions.jsonl');
    let completed = false;
    const result = new BoundedReaperEvidence().write('disposition',
      () => appendDispositionEntry(ledgerPath, entry), 'task:').then((status) => {
      completed = true;
      return status;
    });
    try {
      await syncing.promise;
      expect(completed).toBe(false);
      allowSync.resolve();
      expect(await result).toBe('ok');
      expect(await readDispositionEntries(ledgerPath)).toEqual([entry]);
    } finally {
      allowSync.resolve();
      await result;
      sync.mockRestore();
    }
  });

  test('reports the real audit helper\'s swallowed filesystem failure as error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Appending to a directory fails on both Linux and macOS.
    const status = await new BoundedReaperEvidence().write('audit',
      () => writeReaperAuditRow(dir, { taskId: 'reaped-task' }), 'task:');
    expect(status).toBe('error');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('audit evidence write failed'));
  });
});
