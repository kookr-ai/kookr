import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { STORAGE_KEY as KEY } from './onboarding-status.js';

// Each test imports the module fresh via `vi.resetModules()` so the module-level
// IIFE-once storage selection and `inMemorySeen` singleton are isolated.

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

describe('onboarding-status', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test('shouldShow returns true when storage has no key', async () => {
    installFakeLocalStorage();
    const m = await import('./onboarding-status.js');
    expect(m.shouldShow()).toBe(true);
  });

  test('shouldShow returns false when storage has seen=true', async () => {
    const data = installFakeLocalStorage();
    data.set(KEY, 'true');
    const m = await import('./onboarding-status.js');
    expect(m.shouldShow()).toBe(false);
  });

  test('shouldShow returns false when onboarding=0 is present in the URL', async () => {
    installFakeLocalStorage();
    vi.stubGlobal('window', { location: { search: '?onboarding=0' } });
    const m = await import('./onboarding-status.js');
    expect(m.shouldShow()).toBe(false);
  });

  test('shouldShow returns false when KOOKR_DISABLE_ONBOARDING=1 is set at build time', async () => {
    installFakeLocalStorage();
    vi.stubGlobal('__KOOKR_DISABLE_ONBOARDING__', '1');
    const m = await import('./onboarding-status.js');
    expect(m.shouldShow()).toBe(false);
  });

  test('markSeen writes to localStorage', async () => {
    const data = installFakeLocalStorage();
    const m = await import('./onboarding-status.js');
    m.markSeen();
    expect(data.get(KEY)).toBe('true');
    expect(m.shouldShow()).toBe(false);
  });

  test('reset removes the key', async () => {
    const data = installFakeLocalStorage();
    const m = await import('./onboarding-status.js');
    m.markSeen();
    m.reset();
    expect(data.has(KEY)).toBe(false);
    expect(m.shouldShow()).toBe(true);
  });

  test('falls through to in-memory when localStorage is unavailable', async () => {
    disableLocalStorage();
    const m = await import('./onboarding-status.js');
    expect(m.shouldShow()).toBe(true);
    m.markSeen();
    expect(m.shouldShow()).toBe(false);
    m.reset();
    expect(m.shouldShow()).toBe(true);
  });

  test('markSeen falls back to in-memory when late storage write throws', async () => {
    // Probe at module load succeeds (1 successful set + 1 remove). Set the
    // throw threshold so the *next* setItem fails.
    installFakeLocalStorage({ throwOnSet: { afterCalls: 1 } });
    const m = await import('./onboarding-status.js');

    // markSeen is the second setItem (probe was the first). It must throw
    // internally and fall back to in-memory.
    m.markSeen();

    expect(m.shouldShow()).toBe(false);
    expect(m.__test.getInMemorySeen()).toBe(true);
  });

  test('reset swallows removeItem failures', async () => {
    installFakeLocalStorage({ throwOnRemove: true });
    const m = await import('./onboarding-status.js');
    m.markSeen();
    expect(() => m.reset()).not.toThrow();
  });
});
