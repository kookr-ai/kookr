import { describe, expect, test, vi } from 'vitest';
import {
  createMemoryLedger,
  DEFAULT_MEMORY_LEDGER_INTERVAL_MS,
  MemoryLedger,
  readMemoryLedgerConfigFromEnv,
} from './memory-ledger.js';

const MB = 1024 * 1024;

function fakeMemory(overrides: Partial<NodeJS.MemoryUsage> = {}): NodeJS.MemoryUsage {
  return {
    rss: 100 * MB,
    heapUsed: 40 * MB,
    heapTotal: 60 * MB,
    external: 5 * MB,
    arrayBuffers: 2 * MB,
    ...overrides,
  } as NodeJS.MemoryUsage;
}

describe('MemoryLedger.sample', () => {
  test('reports process memory in MB and merges subsystem counts', () => {
    const ledger = new MemoryLedger({
      readProcessMemory: () => fakeMemory({ rss: 2560 * MB }),
      collectSubsystems: () => ({ monitor: { agents: 3, retainedEvents: 120 } }),
      nowIso: () => '2026-07-28T00:00:00.000Z',
    });

    const sample = ledger.sample();
    expect(sample).toEqual({
      ts: '2026-07-28T00:00:00.000Z',
      rssMb: 2560,
      heapUsedMb: 40,
      heapTotalMb: 60,
      externalMb: 5,
      arrayBuffersMb: 2,
      subsystems: { monitor: { agents: 3, retainedEvents: 120 } },
    });
  });

  test('tolerates a missing arrayBuffers field', () => {
    const mem = fakeMemory();
    delete (mem as { arrayBuffers?: number }).arrayBuffers;
    const ledger = new MemoryLedger({ readProcessMemory: () => mem });
    expect(ledger.sample().arrayBuffersMb).toBe(0);
  });

  test('swallows a throwing subsystem collector and warns once', () => {
    const warn = vi.fn();
    const ledger = new MemoryLedger({
      readProcessMemory: () => fakeMemory(),
      collectSubsystems: () => {
        throw new Error('boom');
      },
      logger: { info: vi.fn(), warn },
    });

    expect(ledger.sample().subsystems).toEqual({});
    expect(ledger.sample().subsystems).toEqual({});
    // Warned only once despite two failing samples.
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('MemoryLedger.start/stop', () => {
  test('logs immediately, then on each interval, and stops cleanly', () => {
    const info = vi.fn();
    let fire: (() => void) | null = null;
    const setIntervalFn = vi.fn((fn: () => void) => {
      fire = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    const clearIntervalFn = vi.fn() as unknown as typeof clearInterval;

    const ledger = new MemoryLedger({
      readProcessMemory: () => fakeMemory(),
      collectSubsystems: () => ({}),
      logger: { info, warn: vi.fn() },
      intervalMs: 15_000,
      setIntervalFn,
      clearIntervalFn,
    });

    ledger.start();
    expect(info).toHaveBeenCalledTimes(1); // immediate line
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 15_000);
    fire?.();
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[0][0]).toBe('[mem-ledger]');
    // Each payload is a single JSON string.
    expect(() => JSON.parse(info.mock.calls[0][1])).not.toThrow();

    ledger.stop();
    // The handle returned by setInterval is the one cleared.
    expect(clearIntervalFn).toHaveBeenCalledWith(1);
  });

  test('start is idempotent', () => {
    const setIntervalFn = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval;
    const ledger = new MemoryLedger({
      readProcessMemory: () => fakeMemory(),
      logger: { info: vi.fn(), warn: vi.fn() },
      setIntervalFn,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
    });
    ledger.start();
    ledger.start();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
  });
});

describe('readMemoryLedgerConfigFromEnv', () => {
  test('disabled by default', () => {
    expect(readMemoryLedgerConfigFromEnv({})).toEqual({
      enabled: false,
      intervalMs: DEFAULT_MEMORY_LEDGER_INTERVAL_MS,
    });
  });

  test.each(['1', 'true', 'TRUE', 'yes', 'on'])('enables on truthy opt-in %s', (raw) => {
    expect(readMemoryLedgerConfigFromEnv({ KOOKR_MEMORY_LEDGER: raw }).enabled).toBe(true);
  });

  test.each(['0', 'false', '', 'off', 'nope'])('stays disabled for %s', (raw) => {
    expect(readMemoryLedgerConfigFromEnv({ KOOKR_MEMORY_LEDGER: raw }).enabled).toBe(false);
  });

  test('reads a custom interval', () => {
    expect(
      readMemoryLedgerConfigFromEnv({ KOOKR_MEMORY_LEDGER: '1', KOOKR_MEMORY_LEDGER_INTERVAL_MS: '15000' }).intervalMs,
    ).toBe(15_000);
  });

  test('falls back to the default interval for blank, non-finite, or sub-minimum values', () => {
    for (const raw of ['', 'abc', 'Infinity', '500']) {
      expect(
        readMemoryLedgerConfigFromEnv({ KOOKR_MEMORY_LEDGER_INTERVAL_MS: raw }).intervalMs,
      ).toBe(DEFAULT_MEMORY_LEDGER_INTERVAL_MS);
    }
  });
});

describe('createMemoryLedger', () => {
  test('returns a MemoryLedger instance', () => {
    expect(createMemoryLedger()).toBeInstanceOf(MemoryLedger);
  });
});
