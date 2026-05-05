import { useSyncExternalStore } from 'react';

const ENABLED_KEY = 'kookr-dnd-enabled';
const STARTED_AT_KEY = 'kookr-dnd-started-at';
const EXPIRES_AT_KEY = 'kookr-dnd-expires-at';

export interface DndState {
  enabled: boolean;
  startedAt: number | null;
  expiresAt: number | null;
}

const DISABLED_STATE: DndState = { enabled: false, startedAt: null, expiresAt: null };

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readFromStorage(): DndState {
  const storage = safeStorage();
  if (!storage) return DISABLED_STATE;
  if (storage.getItem(ENABLED_KEY) !== 'true') return DISABLED_STATE;

  const startedRaw = storage.getItem(STARTED_AT_KEY);
  const expiresRaw = storage.getItem(EXPIRES_AT_KEY);
  const startedAt = startedRaw ? Number(startedRaw) : null;
  const expiresAt = expiresRaw ? Number(expiresRaw) : null;

  if (expiresAt !== null && Date.now() >= expiresAt) {
    storage.removeItem(ENABLED_KEY);
    storage.removeItem(STARTED_AT_KEY);
    storage.removeItem(EXPIRES_AT_KEY);
    return DISABLED_STATE;
  }

  return {
    enabled: true,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
  };
}

function writeToStorage(next: DndState): void {
  const storage = safeStorage();
  if (!storage) return;
  // Storage writes can throw in private-browsing modes or when over quota.
  // The in-memory state still updates so DND remains correct in this tab; we
  // just lose persistence across reloads.
  try {
    if (!next.enabled) {
      storage.removeItem(ENABLED_KEY);
      storage.removeItem(STARTED_AT_KEY);
      storage.removeItem(EXPIRES_AT_KEY);
      return;
    }
    storage.setItem(ENABLED_KEY, 'true');
    if (next.startedAt !== null) storage.setItem(STARTED_AT_KEY, String(next.startedAt));
    else storage.removeItem(STARTED_AT_KEY);
    if (next.expiresAt !== null) storage.setItem(EXPIRES_AT_KEY, String(next.expiresAt));
    else storage.removeItem(EXPIRES_AT_KEY);
  } catch {
    /* persistence failed — in-memory state already updated */
  }
}

/** setTimeout truncates delays > MAX_INT32 to int32, firing almost immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

let state: DndState = readFromStorage();
const listeners = new Set<() => void>();
let expirationTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleExpiration(): void {
  if (expirationTimer) {
    clearTimeout(expirationTimer);
    expirationTimer = null;
  }
  if (!state.enabled || state.expiresAt === null) return;
  const remaining = state.expiresAt - Date.now();
  if (remaining <= 0) {
    apply(DISABLED_STATE);
    return;
  }
  // Clamp delays larger than int32 — setTimeout silently truncates them and
  // would fire almost immediately. We re-arm the timer when the chunk elapses.
  const delay = Math.min(remaining, MAX_TIMEOUT_MS);
  expirationTimer = setTimeout(() => {
    if (state.enabled && state.expiresAt !== null && Date.now() < state.expiresAt) {
      scheduleExpiration();
    } else {
      apply(DISABLED_STATE);
    }
  }, delay);
}

function apply(next: DndState): void {
  state = next;
  writeToStorage(next);
  scheduleExpiration();
  for (const listener of listeners) listener();
}

function syncFromStorage(): void {
  // Re-read storage and notify subscribers without writing back. Used by both
  // the cross-tab `storage` listener and `__resetDndForTests`.
  state = readFromStorage();
  scheduleExpiration();
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  scheduleExpiration();
  // Cross-tab sync: a toggle in another tab fires a `storage` event in this one.
  // Without this, tab A enables DND while tab B keeps chiming for the same agent.
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === null) {
      // localStorage.clear() — re-read everything.
      syncFromStorage();
      return;
    }
    if (event.key === ENABLED_KEY || event.key === STARTED_AT_KEY || event.key === EXPIRES_AT_KEY) {
      syncFromStorage();
    }
  });
}

export function getDndState(): DndState {
  return state;
}

/** Synchronous gate used by emit-site checks in the three notification surfaces. */
export function isDndEnabled(): boolean {
  return state.enabled;
}

/** Enable DND, optionally with a duration after which it auto-disables. Pass null/undefined for indefinite. */
export function enableDnd(durationMs?: number | null): void {
  const startedAt = Date.now();
  const expiresAt = typeof durationMs === 'number' && durationMs > 0 ? startedAt + durationMs : null;
  apply({ enabled: true, startedAt, expiresAt });
}

export function disableDnd(): void {
  apply(DISABLED_STATE);
}

/** Test-only reset hook. */
export function __resetDndForTests(): void {
  if (expirationTimer) {
    clearTimeout(expirationTimer);
    expirationTimer = null;
  }
  state = readFromStorage();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface UseDndResult extends DndState {
  enable: (durationMs?: number | null) => void;
  disable: () => void;
}

export function useDnd(): UseDndResult {
  const snap = useSyncExternalStore(subscribe, getDndState, getDndState);
  return {
    ...snap,
    enable: enableDnd,
    disable: disableDnd,
  };
}

/** Preset DND durations (ms). Indefinite is encoded as null in the API. */
export const DND_DURATIONS: Array<{ label: string; durationMs: number | null }> = [
  { label: '15 minutes', durationMs: 15 * 60_000 },
  { label: '30 minutes', durationMs: 30 * 60_000 },
  { label: '1 hour', durationMs: 60 * 60_000 },
  { label: '2 hours', durationMs: 2 * 60 * 60_000 },
  { label: 'Until I turn it off', durationMs: null },
];
