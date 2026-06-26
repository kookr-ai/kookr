import { useSyncExternalStore } from 'react';
import type { ChimeSound, SoundStateSource } from './audio-alert-log.js';
export type { ChimeSound } from './audio-alert-log.js';

const ENABLED_STORAGE_KEY = 'kookr-sound-enabled';
const VOLUME_STORAGE_KEY = 'kookr-sound-volume';
const CHIME_SOUND_STORAGE_KEY = 'kookr-chime-sound';

export const CHIME_SOUND_LABELS: Record<ChimeSound, string> = {
  classic: 'Classic',
  soft: 'Soft',
  urgent: 'Urgent',
};

const CHIME_SOUNDS = Object.keys(CHIME_SOUND_LABELS) as ChimeSound[];
const DEFAULT_VOLUME = 1;
const DEFAULT_CHIME_SOUND: ChimeSound = 'classic';

export interface SoundPreferenceState {
  enabled: boolean;
  volume: number;
  chimeSound: ChimeSound;
  storageAvailable: boolean;
  source: SoundStateSource;
}

export interface UseSoundPreferenceResult extends SoundPreferenceState {
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
  setChimeSound: (sound: ChimeSound) => void;
}

let memoryEnabled = true;
let memoryVolume = DEFAULT_VOLUME;
let memoryChimeSound = DEFAULT_CHIME_SOUND;
const listeners = new Set<() => void>();

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.max(0, Math.min(1, value));
}

function isChimeSound(value: unknown): value is ChimeSound {
  return typeof value === 'string' && (CHIME_SOUNDS as readonly string[]).includes(value);
}

function readFromStorage(): SoundPreferenceState {
  const storage = safeStorage();
  if (!storage) {
    return {
      enabled: memoryEnabled,
      volume: memoryVolume,
      chimeSound: memoryChimeSound,
      storageAvailable: false,
      source: 'memory_fallback',
    };
  }

  try {
    const rawEnabled = storage.getItem(ENABLED_STORAGE_KEY);
    const rawVolume = storage.getItem(VOLUME_STORAGE_KEY);
    const rawChimeSound = storage.getItem(CHIME_SOUND_STORAGE_KEY);
    const enabled = rawEnabled === null ? true : rawEnabled !== 'false';
    const volume = rawVolume === null ? DEFAULT_VOLUME : clampVolume(Number(rawVolume));
    const chimeSound = isChimeSound(rawChimeSound) ? rawChimeSound : DEFAULT_CHIME_SOUND;
    memoryEnabled = enabled;
    memoryVolume = volume;
    memoryChimeSound = chimeSound;
    return {
      enabled,
      volume,
      chimeSound,
      storageAvailable: true,
      source: rawEnabled === null && rawVolume === null && rawChimeSound === null ? 'default' : 'localStorage',
    };
  } catch {
    return {
      enabled: memoryEnabled,
      volume: memoryVolume,
      chimeSound: memoryChimeSound,
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

function writeToStorage(next: Pick<SoundPreferenceState, 'enabled' | 'volume' | 'chimeSound'>): SoundPreferenceState {
  const storage = safeStorage();
  const volume = clampVolume(next.volume);
  const chimeSound = isChimeSound(next.chimeSound) ? next.chimeSound : DEFAULT_CHIME_SOUND;
  memoryEnabled = next.enabled;
  memoryVolume = volume;
  memoryChimeSound = chimeSound;
  if (!storage) {
    return { enabled: next.enabled, volume, chimeSound, storageAvailable: false, source: 'memory_fallback' };
  }

  try {
    storage.setItem(ENABLED_STORAGE_KEY, String(next.enabled));
    storage.setItem(VOLUME_STORAGE_KEY, String(volume));
    storage.setItem(CHIME_SOUND_STORAGE_KEY, chimeSound);
    return { enabled: next.enabled, volume, chimeSound, storageAvailable: true, source: 'localStorage' };
  } catch {
    return { enabled: next.enabled, volume, chimeSound, storageAvailable: false, source: 'memory_fallback' };
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === ENABLED_STORAGE_KEY ||
      event.key === VOLUME_STORAGE_KEY ||
      event.key === CHIME_SOUND_STORAGE_KEY
    ) {
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

export function isAudibleAlertEnabled(preference: SoundPreferenceState = state): boolean {
  return preference.enabled && preference.volume > 0;
}

export function formatSoundVolume(volume: number): string {
  return `${Math.round(volume * 100)}%`;
}

export function setSoundEnabled(enabled: boolean): void {
  state = writeToStorage({ ...state, enabled });
  notify();
}

export function setSoundVolume(volume: number): void {
  state = writeToStorage({ ...state, volume });
  notify();
}

export function setChimeSound(sound: ChimeSound): void {
  state = writeToStorage({ ...state, chimeSound: sound });
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
    setVolume: setSoundVolume,
    setChimeSound,
  };
}

export function __resetSoundPreferenceForTests(): void {
  state = readFromStorage();
  notify();
}
