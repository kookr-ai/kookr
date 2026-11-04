import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

// Resilience for the dashboard's code-split dialogs.
//
// The dashboard is a long-lived single-page app served from a hashed Vite build
// (`vite.config.mts` → `build.emptyOutDir: true`, content-hashed chunk names). A
// client that loaded hours ago still holds a module graph that points at
// `SettingsDialog-<oldhash>.js`. When the server is rebuilt the hash changes and
// the previous chunk is deleted, so the already-loaded client's dynamic
// `import()` 404s. React surfaces that rejection through the nearest lazy /
// Suspense boundary, which `AppErrorBoundary` catches and renders as the
// "Kookr hit a panel error" fallback — the intermittent Settings-panel failure
// reported during UX dogfooding.
//
// `lazyWithReload` wraps a `lazy(importFn)` factory so that a failed dynamic
// import is retried once (covering a transient network blip), and — when the
// failure looks like a missing/stale chunk — triggers a single controlled full
// reload to pull the fresh `index.html` and its new hashes. A short re-arm
// window guards against reload loops: a genuine build break (which reloading
// cannot fix) reloads at most once and then falls through to the error
// boundary. `installPreloadErrorReload` handles Vite's own `vite:preloadError`
// window event the same way, for preloads that fail outside a lazy boundary.

/** sessionStorage key holding the epoch-ms of the last chunk-triggered reload. */
export const LAZY_RELOAD_MARKER = 'kookr:lazy-chunk-reload-at';

/**
 * How long after an auto-reload we refuse to auto-reload again. One stale build
 * is fixed by a single reload; if a chunk is still unfetchable this soon after,
 * the cause is not a stale hash (reloading would loop), so we stop and let the
 * error boundary show. After the window a genuinely newer stale build can
 * re-arm the one reload.
 */
export const LAZY_RELOAD_REARM_MS = 10_000;

type MinimalStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface RetryDynamicImportOptions {
  /** Retries after the first attempt. Default 1 ("retry once"). */
  retries?: number;
  /** Delay before each retry, in ms. Default 300. Tests pass 0. */
  retryDelayMs?: number;
  /** Full-page reload trigger. Default `window.location.reload()`. */
  reload?: () => void;
  /**
   * Store for the one-reload guard. Default `window.sessionStorage`, or `null`
   * when it is unavailable (private mode / disabled / quota). The guard is
   * fail-closed: if the one-reload marker cannot be persisted we do NOT reload
   * (and let the error boundary show), because an unpersisted marker cannot
   * stop the reloaded page from hitting the same failure and reloading again.
   */
  storage?: MinimalStorage | null;
  /** Clock, for the re-arm window. Default `Date.now`. */
  now?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when `error` looks like a failed *fetch* of a dynamically imported
 * module — the stale-hash / missing-chunk case a reload can fix. A module that
 * fetches but throws while evaluating (a genuine build/export break) does NOT
 * match, so we never reload-loop on code that is actually broken.
 */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const name = error instanceof Error ? error.name : '';
  if (name === 'ChunkLoadError') return true;
  return /failed to fetch dynamically imported module|error loading dynamically imported module|unable to preload|importing a module script failed|module script failed|not a valid javascript mime type|expected a javascript(?:-or-wasm)? module script/i.test(
    message,
  );
}

function resolveStorage(opts: RetryDynamicImportOptions): MinimalStorage | null {
  if (opts.storage !== undefined) return opts.storage;
  try {
    return window.sessionStorage;
  } catch {
    // sessionStorage can throw when access is blocked (private mode, sandbox).
    return null;
  }
}

/** True when we auto-reloaded within the re-arm window and should not again. */
function recentlyReloaded(storage: MinimalStorage | null, now: () => number): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(LAZY_RELOAD_MARKER);
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    return now() - at < LAZY_RELOAD_REARM_MS;
  } catch {
    return false;
  }
}

/** Persist the one-reload marker. Returns true only if it was actually stored. */
function recordReload(storage: MinimalStorage | null, now: () => number): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LAZY_RELOAD_MARKER, String(now()));
    return true;
  } catch {
    // Storage blocked / over quota — the guard is NOT persisted.
    return false;
  }
}

function triggerReload(reload?: () => void): void {
  if (reload) {
    reload();
    return;
  }
  window.location.reload();
}

/**
 * Run a dynamic-import factory with one retry, and on a persistent
 * chunk-fetch failure trigger a single guarded full reload. On the reload path
 * the returned promise stays pending forever so the Suspense fallback (null)
 * holds while the browser navigates, instead of flashing the error boundary.
 */
export async function retryDynamicImport<T>(
  importFn: () => Promise<T>,
  opts: RetryDynamicImportOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 1;
  const retryDelayMs = opts.retryDelayMs ?? 300;
  const now = opts.now ?? Date.now;
  const storage = resolveStorage(opts);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0 && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
    try {
      return await importFn();
    } catch (error) {
      lastError = error;
    }
  }

  if (isChunkLoadError(lastError) && !recentlyReloaded(storage, now) && recordReload(storage, now)) {
    // recordReload returned true → the one-reload guard is persisted, so the
    // reloaded page will not loop. (If it could not be persisted we fall
    // through and let the error boundary show instead — fail-closed.)
    triggerReload(opts.reload);
    // Never settles: keeps Suspense pending (null fallback) during navigation.
    return new Promise<T>(() => {});
  }

  throw lastError;
}

/**
 * Drop-in replacement for `React.lazy(importFn)` that is resilient to stale
 * code-split chunks after a server rebuild. Apply it to every lazily loaded
 * dialog/panel, not just the one that was reported failing.
 */
export function lazyWithReload<T extends ComponentType<unknown>>(
  importFn: () => Promise<{ default: T }>,
  opts?: RetryDynamicImportOptions,
): LazyExoticComponent<T> {
  return lazy(() => retryDynamicImport(importFn, opts));
}

/**
 * Handle Vite's `vite:preloadError` event (fired when a modulepreload fetch
 * fails, e.g. a stale `<link rel="modulepreload">` after a rebuild) with the
 * same one-reload-per-window guard. Returns a disposer. Safe to call once at
 * startup.
 */
export function installPreloadErrorReload(
  opts: Pick<RetryDynamicImportOptions, 'reload' | 'storage' | 'now'> = {},
): () => void {
  const now = opts.now ?? Date.now;
  const handler = (event: Event): void => {
    const storage = resolveStorage(opts);
    // When we are NOT going to reload (already reloaded this window, or the
    // guard can't be persisted → fail-closed), do not preventDefault: let Vite
    // rethrow the real "failed to fetch" error so the specific message reaches
    // the error boundary instead of a later undefined-module access.
    if (recentlyReloaded(storage, now)) return;
    if (!recordReload(storage, now)) return;
    // We will reload: suppress Vite's default rethrow and navigate.
    event.preventDefault();
    triggerReload(opts.reload);
  };
  window.addEventListener('vite:preloadError', handler);
  return () => window.removeEventListener('vite:preloadError', handler);
}
