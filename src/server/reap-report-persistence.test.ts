import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_REAP_REPORT_PERSIST_TIMEOUT_MS,
  persistReapReport,
} from './reap-report-persistence.js';

describe('persistReapReport (issue #2852)', () => {
  let unhandled: unknown[];
  const onUnhandled = (err: unknown) => unhandled.push(err);

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  test('has a sane default bound', () => {
    expect(DEFAULT_REAP_REPORT_PERSIST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test('resolves ok with the written path when the write succeeds', async () => {
    const out = await persistReapReport(async () => '/reports/task.md', 1_000);
    expect(out).toEqual({ status: 'ok', reportPath: '/reports/task.md' });
  });

  test('resolves error when the write rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await persistReapReport(async () => {
      throw new Error('ENOSPC');
    }, 1_000);
    expect(out).toEqual({ status: 'error' });
    warn.mockRestore();
  });

  test('resolves timeout when the write never settles, with no unhandled rejection later', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let rejectLate: (reason: unknown) => void = () => {};
    const write = () =>
      new Promise<string>((_resolve, reject) => {
        rejectLate = reject;
      });

    const out = await persistReapReport(write, 15);
    expect(out).toEqual({ status: 'timeout' });

    // The abandoned write rejects AFTER the bound elapsed. Because the handlers
    // were attached up front, this must NOT surface as an unhandled rejection.
    rejectLate(new Error('late failure'));
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toEqual([]);

    err.mockRestore();
    warn.mockRestore();
  });

  test('timeoutMs <= 0 awaits the write unbounded', async () => {
    const out = await persistReapReport(async () => '/reports/x.md', 0);
    expect(out).toEqual({ status: 'ok', reportPath: '/reports/x.md' });
  });
});
