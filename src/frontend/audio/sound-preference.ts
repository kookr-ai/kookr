import { useSyncExternalStore } from 'react';
import type { SoundStateSource } from './audio-alert-log.js';

const STORAGE_KEY = 'kookr-sound-enabled';

export interface SoundPreferenceState {
  enabled: boolean;
  storageAvailable: boolean;
  source: SoundStateSource;
}

export interface UseSoundPreferenceResult extends SoundPreferenceState {
  setEnabled: (enabled: boolean) => void;
}

let memoryEnabled = true;
const listeners = new Set<() => void>();

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readFromStorage(): SoundPreferenceState {
  const storage = safeStorage();
  if (!storage) {
    return {
      enabled: memoryEnabled,
      storageAvailable: false,
      source: 'memory_fallback',
    };
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) {
      memoryEnabled = true;
      return { enabled: true, storageAvailable: true, source: 'default' };
    }
    const enabled = raw !== 'false';
    memoryEnabled = enabled;
    return { enabled, storageAvailable: true, source: 'localStorage' };
  } catch {
    return {
      enabled: memoryEnabled,
      storageAvailable: false,
      source: 'memory_fallback',
    };
  }
}

let state: SoundPreferenceState = readFromStorage();

function notify(): void {
  for (const listener of listeners) listener();
}

function syncFromStorage(): void {
  state = readFromStorage();
  notify();
}

function writeToStorage(enabled: boolean): SoundPreferenceState {
  const storage = safeStorage();
  memoryEnabled = enabled;
  if (!storage) {
    return { enabled, storageAvailable: false, source: 'memory_fallback' };
  }

  try {
    storage.setItem(STORAGE_KEY, String(enabled));
    return { enabled, storageAvailable: true, source: 'localStorage' };
  } catch {
    return { enabled, storageAvailable: false, source: 'memory_fallback' };
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) {
      syncFromStorage();
    }
  });
}

export function getSoundPreferenceState(): SoundPreferenceState {
  return state;
}

export function isSoundEnabled(): boolean {
  return state.enabled;
}

export function setSoundEnabled(enabled: boolean): void {
  state = writeToStorage(enabled);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSoundPreference(): UseSoundPreferenceResult {
  const snap = useSyncExternalStore(subscribe, getSoundPreferenceState, getSoundPreferenceState);
  return {
    ...snap,
    setEnabled: setSoundEnabled,
  };
}

export function __resetSoundPreferenceForTests(): void {
  state = readFromStorage();
  notify();
}
