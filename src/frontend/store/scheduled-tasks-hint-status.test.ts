import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { STORAGE_KEY as KEY } from './scheduled-tasks-hint-status.js';

// Each test imports the module fresh via `vi.resetModules()` so the module-level
// IIFE-once storage selection and `inMemoryDismissed` singleton are isolated.

interface FakeStorageOptions {
  throwOnSet?: boolean | { afterCalls: number };
  throwOnRemove?: boolean;
}

function installFakeLocalStorage(options: FakeStorageOptions = {}): Map<string, string> {
  const data = new Map<string, string>();
  let setCalls = 0;
  const fake: Storage = {
    get length() { return data.size; },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      setCalls += 1;
      const cfg = options.throwOnSet;
      if (cfg === true) throw new DOMException('quota', 'QuotaExceededError');
      if (cfg && typeof cfg === 'object' && setCalls > cfg.afterCalls) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      data.set(k, v);
    },
    removeItem: (k: string) => {
      if (options.throwOnRemove) throw new DOMException('boom', 'SecurityError');
      data.delete(k);
    },
    clear: () => data.clear(),
  };
  vi.stubGlobal('localStorage', fake);
  return data;
}

function disableLocalStorage(): void {
  vi.stubGlobal('localStorage', new Proxy({}, {
    get() { throw new DOMException('disabled', 'SecurityError'); },
  }));
}

describe('scheduled-tasks-hint-status', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test('shouldShow returns true when storage has no key', async () => {
    installFakeLocalStorage();
    const m = await import('./scheduled-tasks-hint-status.js');
    expect(m.shouldShow()).toBe(true);
  });

  test('shouldShow returns false when storage has the dismissed flag', async () => {
    const data = installFakeLocalStorage();
    data.set(KEY, 'true');
    const m = await import('./scheduled-tasks-hint-status.js');
    expect(m.shouldShow()).toBe(false);
  });

  test('markPermanentlyDismissed writes to localStorage', async () => {
    const data = installFakeLocalStorage();
    const m = await import('./scheduled-tasks-hint-status.js');
    m.markPermanentlyDismissed();
    expect(data.get(KEY)).toBe('true');
    expect(m.shouldShow()).toBe(false);
  });

  test('reset removes the key', async () => {
    const data = installFakeLocalStorage();
    const m = await import('./scheduled-tasks-hint-status.js');
    m.markPermanentlyDismissed();
    m.reset();
    expect(data.has(KEY)).toBe(false);
    expect(m.shouldShow()).toBe(true);
  });

  test('falls through to in-memory when localStorage is unavailable', async () => {
    disableLocalStorage();
    const m = await import('./scheduled-tasks-hint-status.js');
    expect(m.shouldShow()).toBe(true);
    m.markPermanentlyDismissed();
    expect(m.shouldShow()).toBe(false);
    m.reset();
    expect(m.shouldShow()).toBe(true);
  });

  test('markPermanentlyDismissed falls back to in-memory when late storage write throws', async () => {
    // Probe at module load succeeds (1 successful set + 1 remove). Set the
    // throw threshold so the *next* setItem fails.
    installFakeLocalStorage({ throwOnSet: { afterCalls: 1 } });
    const m = await import('./scheduled-tasks-hint-status.js');

    m.markPermanentlyDismissed();

    expect(m.shouldShow()).toBe(false);
    expect(m.__test.getInMemoryDismissed()).toBe(true);
  });

  test('reset swallows removeItem failures', async () => {
    installFakeLocalStorage({ throwOnRemove: true });
    const m = await import('./scheduled-tasks-hint-status.js');
    m.markPermanentlyDismissed();
    expect(() => m.reset()).not.toThrow();
  });
});
