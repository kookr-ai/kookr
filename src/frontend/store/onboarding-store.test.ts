import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { STORAGE_KEY as KEY } from './onboarding-status.js';

function installFakeLocalStorage(): Map<string, string> {
  const data = new Map<string, string>();
  const fake: Storage = {
    get length() { return data.size; },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
  };
  vi.stubGlobal('localStorage', fake);
  return data;
}

describe('onboarding-store', () => {
  beforeEach(() => {
    vi.resetModules();
    installFakeLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('open() flips snapshot to true and notifies subscribers', async () => {
    const m = await import('./onboarding-store.js');
    let calls = 0;
    m.subscribe(() => { calls += 1; });

    expect(m.getSnapshot()).toBe(false);
    m.open();
    expect(m.getSnapshot()).toBe(true);
    expect(calls).toBe(1);
  });

  test('open() is idempotent — second call does not re-emit', async () => {
    const m = await import('./onboarding-store.js');
    let calls = 0;
    m.subscribe(() => { calls += 1; });

    m.open();
    m.open();
    expect(calls).toBe(1);
  });

  test('close() flips snapshot to false, marks persistence, notifies', async () => {
    const data = installFakeLocalStorage();
    const m = await import('./onboarding-store.js');
    let calls = 0;
    m.subscribe(() => { calls += 1; });

    m.open();
    m.close();

    expect(m.getSnapshot()).toBe(false);
    expect(data.get(KEY)).toBe('true');
    expect(calls).toBe(2); // open emit + close emit
  });

  test('close() while already closed is a no-op (no persistence write, no emit)', async () => {
    const data = installFakeLocalStorage();
    const m = await import('./onboarding-store.js');
    let calls = 0;
    m.subscribe(() => { calls += 1; });

    m.close();
    expect(m.getSnapshot()).toBe(false);
    expect(data.has(KEY)).toBe(false);
    expect(calls).toBe(0);
  });

  test('subscribe returns an unsubscribe function', async () => {
    const m = await import('./onboarding-store.js');
    let calls = 0;
    const unsub = m.subscribe(() => { calls += 1; });

    m.open();
    expect(calls).toBe(1);

    unsub();
    m.close();
    expect(calls).toBe(1); // not called again
    expect(m.__test.getListenerCount()).toBe(0);
  });

  test('multiple subscribers all fire', async () => {
    const m = await import('./onboarding-store.js');
    let a = 0, b = 0;
    m.subscribe(() => { a += 1; });
    m.subscribe(() => { b += 1; });

    m.open();
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  test('maybeOpenForFirstRun opens when persistence is empty', async () => {
    installFakeLocalStorage();
    const m = await import('./onboarding-store.js');
    m.maybeOpenForFirstRun();
    expect(m.getSnapshot()).toBe(true);
  });

  test('maybeOpenForFirstRun does not open when persistence says seen', async () => {
    const data = installFakeLocalStorage();
    data.set(KEY, 'true');
    const m = await import('./onboarding-store.js');
    m.maybeOpenForFirstRun();
    expect(m.getSnapshot()).toBe(false);
  });

  test('open() after close() reopens — replay path', async () => {
    const m = await import('./onboarding-store.js');
    m.open();
    m.close();
    expect(m.getSnapshot()).toBe(false);

    m.open();
    expect(m.getSnapshot()).toBe(true);
  });
});
