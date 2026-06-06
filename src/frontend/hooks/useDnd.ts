import { useSyncExternalStore } from 'react';
import {
  isWithinQuietHours,
  validateQuietHours,
  type QuietHoursWindow,
} from '../../shared/contracts/quiet-hours.js';

const ENABLED_KEY = 'kookr-dnd-enabled';
const STARTED_AT_KEY = 'kookr-dnd-started-at';
const EXPIRES_AT_KEY = 'kookr-dnd-expires-at';
const QUIET_HOURS_KEY = 'kookr-quiet-hours';

/** How DND became active. `quiet-hours` is the scheduled "auto" state. */
export type DndSource = 'off' | 'manual' | 'quiet-hours';

export interface DndState {
  enabled: boolean;
  startedAt: number | null;
  expiresAt: number | null;
  /** Why DND is (in)active. Manual toggle wins over a scheduled window. */
  source: DndSource;
}

interface ManualDndState {
  enabled: boolean;
  startedAt: number | null;
  expiresAt: number | null;
}

const DISABLED_MANUAL: ManualDndState = { enabled: false, startedAt: null, expiresAt: null };
const DISABLED_STATE: DndState = { enabled: false, startedAt: null, expiresAt: null, source: 'off' };

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readManualFromStorage(): ManualDndState {
  const storage = safeStorage();
  if (!storage) return DISABLED_MANUAL;
  if (storage.getItem(ENABLED_KEY) !== 'true') return DISABLED_MANUAL;

  const startedRaw = storage.getItem(STARTED_AT_KEY);
  const expiresRaw = storage.getItem(EXPIRES_AT_KEY);
  const startedAt = startedRaw ? Number(startedRaw) : null;
  const expiresAt = expiresRaw ? Number(expiresRaw) : null;

  if (expiresAt !== null && Date.now() >= expiresAt) {
    storage.removeItem(ENABLED_KEY);
    storage.removeItem(STARTED_AT_KEY);
    storage.removeItem(EXPIRES_AT_KEY);
    return DISABLED_MANUAL;
  }

  return {
    enabled: true,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
  };
}

function writeManualToStorage(next: ManualDndState): void {
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

function readQuietHoursFromStorage(): QuietHoursWindow[] {
  const storage = safeStorage();
  if (!storage) return [];
  const raw = storage.getItem(QUIET_HOURS_KEY);
  if (!raw) return [];
  try {
    return validateQuietHours(JSON.parse(raw)).windows;
  } catch {
    return [];
  }
}

function writeQuietHoursToStorage(windows: QuietHoursWindow[]): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    if (windows.length === 0) storage.removeItem(QUIET_HOURS_KEY);
    else storage.setItem(QUIET_HOURS_KEY, JSON.stringify(windows));
  } catch {
    /* persistence failed — in-memory windows already updated */
  }
}

/** setTimeout truncates delays > MAX_INT32 to int32, firing almost immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** How often to re-evaluate quiet-hours membership. Windows are minute-granular. */
const QUIET_HOURS_POLL_MS = 60_000;

let manualState: ManualDndState = readManualFromStorage();
let quietWindows: QuietHoursWindow[] = readQuietHoursFromStorage();
let state: DndState = computeEffective();
const listeners = new Set<() => void>();
let expirationTimer: ReturnType<typeof setTimeout> | null = null;
let quietHoursTimer: ReturnType<typeof setInterval> | null = null;

function computeEffective(): DndState {
  if (manualState.enabled) {
    return { enabled: true, startedAt: manualState.startedAt, expiresAt: manualState.expiresAt, source: 'manual' };
  }
  if (isWithinQuietHours(quietWindows, new Date())) {
    return { enabled: true, startedAt: null, expiresAt: null, source: 'quiet-hours' };
  }
  return DISABLED_STATE;
}

function sameState(a: DndState, b: DndState): boolean {
  return a.enabled === b.enabled && a.startedAt === b.startedAt && a.expiresAt === b.expiresAt && a.source === b.source;
}

/**
 * Recompute the effective DND state from the manual toggle + quiet-hours
 * windows. Only swaps the exposed `state` reference (and notifies) when a field
 * actually changes, so it is safe as a `useSyncExternalStore` snapshot source.
 */
function recomputeEffective(): void {
  const next = computeEffective();
  if (sameState(next, state)) return;
  state = next;
  for (const listener of listeners) listener();
}

function ensureQuietHoursTimer(): void {
  if (quietWindows.length > 0) {
    if (quietHoursTimer === null) {
      quietHoursTimer = setInterval(recomputeEffective, QUIET_HOURS_POLL_MS);
    }
  } else if (quietHoursTimer !== null) {
    clearInterval(quietHoursTimer);
    quietHoursTimer = null;
  }
}

function scheduleExpiration(): void {
  if (expirationTimer) {
    clearTimeout(expirationTimer);
    expirationTimer = null;
  }
  if (!manualState.enabled || manualState.expiresAt === null) return;
  const remaining = manualState.expiresAt - Date.now();
  if (remaining <= 0) {
    applyManual(DISABLED_MANUAL);
    return;
  }
  // Clamp delays larger than int32 — setTimeout silently truncates them and
  // would fire almost immediately. We re-arm the timer when the chunk elapses.
  const delay = Math.min(remaining, MAX_TIMEOUT_MS);
  expirationTimer = setTimeout(() => {
    if (manualState.enabled && manualState.expiresAt !== null && Date.now() < manualState.expiresAt) {
      scheduleExpiration();
    } else {
      applyManual(DISABLED_MANUAL);
    }
  }, delay);
}

function applyManual(next: ManualDndState): void {
  manualState = next;
  writeManualToStorage(next);
  scheduleExpiration();
  recomputeEffective();
}

function syncFromStorage(): void {
  // Re-read storage and notify subscribers without writing back. Used by both
  // the cross-tab `storage` listener and `__resetDndForTests`.
  manualState = readManualFromStorage();
  quietWindows = readQuietHoursFromStorage();
  scheduleExpiration();
  ensureQuietHoursTimer();
  recomputeEffective();
}

if (typeof window !== 'undefined') {
  scheduleExpiration();
  ensureQuietHoursTimer();
  // Cross-tab sync: a toggle in another tab fires a `storage` event in this one.
  // Without this, tab A enables DND while tab B keeps chiming for the same agent.
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === null) {
      // localStorage.clear() — re-read everything.
      syncFromStorage();
      return;
    }
    if (
      event.key === ENABLED_KEY ||
      event.key === STARTED_AT_KEY ||
      event.key === EXPIRES_AT_KEY ||
      event.key === QUIET_HOURS_KEY
    ) {
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
  applyManual({ enabled: true, startedAt, expiresAt });
}

export function disableDnd(): void {
  applyManual(DISABLED_MANUAL);
}

/** Whether a scheduled quiet-hours window is currently active (independent of manual DND). */
export function isQuietHoursActive(now: Date = new Date()): boolean {
  return isWithinQuietHours(quietWindows, now);
}

/**
 * Replace the quiet-hours windows. Persists to localStorage so the schedule
 * survives reloads, then re-evaluates the effective DND state immediately.
 * Called by the settings dialog when windows load or change. Invalid windows
 * are dropped before they take effect.
 */
export function setQuietHoursWindows(windows: QuietHoursWindow[]): void {
  quietWindows = validateQuietHours(windows).windows;
  writeQuietHoursToStorage(quietWindows);
  ensureQuietHoursTimer();
  recomputeEffective();
}

/** Test-only reset hook. */
export function __resetDndForTests(): void {
  if (expirationTimer) {
    clearTimeout(expirationTimer);
    expirationTimer = null;
  }
  if (quietHoursTimer) {
    clearInterval(quietHoursTimer);
    quietHoursTimer = null;
  }
  manualState = readManualFromStorage();
  quietWindows = readQuietHoursFromStorage();
  ensureQuietHoursTimer();
  state = computeEffective();
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
