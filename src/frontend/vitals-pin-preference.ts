/**
 * Whether the operator pinned the vitals strip to the top bar.
 *
 * Off by default: at rest the dashboard keeps readouts behind the System
 * indicator ("quiet chrome"), and the strip is something an operator switches
 * on. The choice is per browser, kept in localStorage like the sound setting.
 */
import { useSyncExternalStore } from 'react';

export const VITALS_PINNED_STORAGE_KEY = 'kookr:vitalsPinned';

const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Reading `localStorage` throws when site data is blocked.
    return null;
  }
}

export function readVitalsPinned(): boolean {
  try {
    return storage()?.getItem(VITALS_PINNED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setVitalsPinned(pinned: boolean): void {
  try {
    const store = storage();
    if (pinned) store?.setItem(VITALS_PINNED_STORAGE_KEY, 'true');
    else store?.removeItem(VITALS_PINNED_STORAGE_KEY);
  } catch {
    // Storage unavailable: the choice lasts until the page reloads.
  }
  memoryValue = pinned;
  for (const listener of listeners) listener();
}

/** Last value set in this page, so the switch still works when storage is unavailable. */
let memoryValue: boolean | null = null;

function snapshot(): boolean {
  return memoryValue ?? readVitalsPinned();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changed the setting.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === VITALS_PINNED_STORAGE_KEY) {
      memoryValue = null;
      listener();
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export function useVitalsPinned(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/** Test helper: forget the in-page value and every subscriber. */
export function __resetVitalsPinnedForTests(): void {
  memoryValue = null;
  listeners.clear();
}
