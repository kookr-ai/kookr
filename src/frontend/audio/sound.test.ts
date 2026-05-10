// @vitest-environment jsdom

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { isSoundEnabled, setSoundEnabled, maybePlayChime } from './sound.js';
import { __resetDndForTests, enableDnd, disableDnd } from '../hooks/useDnd.js';

describe('sound preferences', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
  });

  test('sound is enabled by default', () => {
    expect(isSoundEnabled()).toBe(true);
  });

  test('setSoundEnabled(false) disables sound', () => {
    setSoundEnabled(false);
    expect(isSoundEnabled()).toBe(false);
  });

  test('setSoundEnabled(true) re-enables sound', () => {
    setSoundEnabled(false);
    setSoundEnabled(true);
    expect(isSoundEnabled()).toBe(true);
  });

  test('persists to localStorage key kookr-sound-enabled', () => {
    setSoundEnabled(false);
    expect(store.get('kookr-sound-enabled')).toBe('false');
    setSoundEnabled(true);
    expect(store.get('kookr-sound-enabled')).toBe('true');
  });
});

// Smoke test for the audio path itself. This is the canonical regression
// guard for the playChime extraction — calling maybePlayChime with cleared
// mute/DND preconditions must reach `new AudioContext()`.
describe('maybePlayChime — audio-path smoke', () => {
  let store: Map<string, string>;
  let audioContextCtor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
    __resetDndForTests();
    disableDnd();

    // Minimal AudioContext mock: tracks construction and provides the
    // surface playChime exercises (oscillators, gains, currentTime).
    audioContextCtor = vi.fn().mockImplementation(() => ({
      currentTime: 0,
      destination: {},
      close: vi.fn(),
      createOscillator: () => ({
        connect: vi.fn(),
        frequency: { value: 0 },
        type: '',
        start: vi.fn(),
        stop: vi.fn(),
      }),
      createGain: () => ({
        connect: vi.fn(),
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
      }),
    }));
    vi.stubGlobal('AudioContext', audioContextCtor);
  });

  afterEach(() => {
    __resetDndForTests();
    vi.unstubAllGlobals();
  });

  test('constructs AudioContext when sound enabled and DND off', () => {
    expect(isSoundEnabled()).toBe(true);
    maybePlayChime();
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
  });

  test('does not construct AudioContext when sound disabled', () => {
    setSoundEnabled(false);
    maybePlayChime();
    expect(audioContextCtor).not.toHaveBeenCalled();
  });

  test('does not construct AudioContext when DND enabled', () => {
    enableDnd();
    maybePlayChime();
    expect(audioContextCtor).not.toHaveBeenCalled();
  });
});
