// @vitest-environment jsdom

import React, { act, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  installPreloadErrorReload,
  isChunkLoadError,
  LAZY_RELOAD_MARKER,
  LAZY_RELOAD_REARM_MS,
  lazyWithReload,
  retryDynamicImport,
} from './lazy-with-reload.js';

function makeStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe('isChunkLoadError', () => {
  test('matches the reported stale-chunk fetch failure', () => {
    expect(
      isChunkLoadError(
        new Error(
          'Failed to fetch dynamically imported module: http://localhost:4800/assets/SettingsDialog-abc123.js',
        ),
      ),
    ).toBe(true);
  });

  test('matches the index.html-instead-of-module (404 fallback) shape', () => {
    expect(
      isChunkLoadError(
        new Error("Expected a JavaScript module script but the server responded with a MIME type of 'text/html'."),
      ),
    ).toBe(true);
  });

  test('matches a ChunkLoadError by error name', () => {
    const err = new Error('loading chunk failed');
    err.name = 'ChunkLoadError';
    expect(isChunkLoadError(err)).toBe(true);
  });

  test("matches Safari's 'Importing a module script failed' shape", () => {
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
  });

  test('does NOT match a genuine evaluation/build break', () => {
    expect(isChunkLoadError(new Error('SettingsDialog is not a function'))).toBe(false);
    expect(isChunkLoadError(new TypeError('Cannot read properties of undefined'))).toBe(false);
  });
});

describe('retryDynamicImport', () => {
  let reload: ReturnType<typeof vi.fn>;
  let storage: Pick<Storage, 'getItem' | 'setItem'>;

  beforeEach(() => {
    reload = vi.fn();
    storage = makeStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('resolves without retrying or reloading when the import succeeds', async () => {
    const importFn = vi.fn().mockResolvedValue({ default: 'Panel' });

    const mod = await retryDynamicImport(importFn, { reload, storage, retryDelayMs: 0 });

    expect(mod).toEqual({ default: 'Panel' });
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(LAZY_RELOAD_MARKER)).toBeNull();
  });

  test('retries once and succeeds on a transient failure without reloading', async () => {
    const importFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module: /assets/X-1.js'))
      .mockResolvedValueOnce({ default: 'Panel' });

    const mod = await retryDynamicImport(importFn, { reload, storage, retryDelayMs: 0 });

    expect(mod).toEqual({ default: 'Panel' });
    expect(importFn).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  test('retries once, then reloads on a persistent chunk-fetch failure', async () => {
    const importFn = vi
      .fn()
      .mockRejectedValue(
        new Error('Failed to fetch dynamically imported module: /assets/SettingsDialog-old.js'),
      );

    // The reload branch never settles (keeps Suspense pending during
    // navigation), so assert on observable effects rather than awaiting it.
    void retryDynamicImport(importFn, { reload, storage, retryDelayMs: 0 });

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(importFn).toHaveBeenCalledTimes(2); // initial + one retry
    expect(storage.getItem(LAZY_RELOAD_MARKER)).not.toBeNull();
  });

  test('does NOT reload again within the re-arm window (loop guard)', async () => {
    const now = () => 1_000_000;
    // A reload happened "just now".
    storage.setItem(LAZY_RELOAD_MARKER, String(now()));
    const importFn = vi
      .fn()
      .mockRejectedValue(new Error('Failed to fetch dynamically imported module: /assets/X.js'));

    await expect(
      retryDynamicImport(importFn, { reload, storage, retryDelayMs: 0, now }),
    ).rejects.toThrow(/Failed to fetch/);
    expect(reload).not.toHaveBeenCalled();
  });

  test('re-arms the reload after the window elapses', async () => {
    const base = 1_000_000;
    storage.setItem(LAZY_RELOAD_MARKER, String(base));
    const now = () => base + LAZY_RELOAD_REARM_MS + 1;
    const importFn = vi
      .fn()
      .mockRejectedValue(new Error('Failed to fetch dynamically imported module: /assets/X.js'));

    void retryDynamicImport(importFn, { reload, storage, retryDelayMs: 0, now });

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  test('fails closed: does NOT reload when storage is unavailable (null)', async () => {
    // Without a place to persist the one-reload marker, the reloaded page could
    // not tell it already reloaded and would loop — so we must not reload.
    const importFn = vi
      .fn()
      .mockRejectedValue(new Error('Failed to fetch dynamically imported module: /assets/X.js'));

    await expect(
      retryDynamicImport(importFn, { reload, storage: null, retryDelayMs: 0 }),
    ).rejects.toThrow(/Failed to fetch/);
    expect(reload).not.toHaveBeenCalled();
  });

  test('fails closed: does NOT reload when the marker write throws (quota/blocked)', async () => {
    const throwingStorage: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const importFn = vi
      .fn()
      .mockRejectedValue(new Error('Failed to fetch dynamically imported module: /assets/X.js'));

    await expect(
      retryDynamicImport(importFn, { reload, storage: throwingStorage, retryDelayMs: 0 }),
    ).rejects.toThrow(/Failed to fetch/);
    expect(reload).not.toHaveBeenCalled();
  });

  test('does NOT reload on a persistent non-chunk (genuine build break) error', async () => {
    const importFn = vi.fn().mockRejectedValue(new Error('SettingsDialog is not a function'));

    await expect(
      retryDynamicImport(importFn, { reload, storage, retryDelayMs: 0 }),
    ).rejects.toThrow(/is not a function/);
    expect(reload).toHaveBeenCalledTimes(0);
    expect(storage.getItem(LAZY_RELOAD_MARKER)).toBeNull();
  });
});

describe('lazyWithReload (wiring to React.lazy)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('renders the resolved component on a successful import', async () => {
    const Panel = (): React.ReactElement => <div>panel loaded</div>;
    const Lazy = lazyWithReload(() => Promise.resolve({ default: Panel }));

    await act(async () => {
      root.render(
        <Suspense fallback={<div>loading</div>}>
          <Lazy />
        </Suspense>,
      );
    });

    expect(container.textContent).toContain('panel loaded');
  });
});

describe('installPreloadErrorReload', () => {
  let reload: ReturnType<typeof vi.fn>;
  let storage: Pick<Storage, 'getItem' | 'setItem'>;

  beforeEach(() => {
    reload = vi.fn();
    storage = makeStorage();
  });

  test('reloads once on vite:preloadError and guards against a second within the window', () => {
    const now = () => 5_000;
    const dispose = installPreloadErrorReload({ reload, storage, now });
    try {
      const first = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(first);
      const second = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(second);
      expect(reload).toHaveBeenCalledTimes(1);
      // Only the reloading dispatch suppresses Vite's default rethrow; the
      // declined one lets the real error surface to the boundary.
      expect(first.defaultPrevented).toBe(true);
      expect(second.defaultPrevented).toBe(false);
    } finally {
      dispose();
    }
  });

  test('does not preventDefault when it fails closed (storage unavailable)', () => {
    const dispose = installPreloadErrorReload({ reload, storage: null });
    try {
      const event = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(event);
      expect(reload).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally {
      dispose();
    }
  });

  test('disposer removes the listener', () => {
    const dispose = installPreloadErrorReload({ reload, storage });
    dispose();
    window.dispatchEvent(new Event('vite:preloadError'));
    expect(reload).not.toHaveBeenCalled();
  });
});
