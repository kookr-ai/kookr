// @vitest-environment jsdom

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __resetSoundPreferenceForTests,
  getSoundPreferenceState,
  isSoundEnabled,
  setSoundEnabled,
  maybePlayChime,
} from './sound.js';
import { __resetAudioAlertLogForTests, getAudioAlertSnapshot } from './audio-alert-log.js';
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
    __resetSoundPreferenceForTests();
  });

  test('sound is enabled by default', () => {
    expect(isSoundEnabled()).toBe(true);
    expect(getSoundPreferenceState()).toMatchObject({
      enabled: true,
      storageAvailable: true,
      source: 'default',
    });
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

  test('falls back to memory when localStorage writes throw', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('quota');
      },
      clear: () => undefined,
    });
    __resetSoundPreferenceForTests();

    setSoundEnabled(false);

    expect(isSoundEnabled()).toBe(false);
    expect(getSoundPreferenceState()).toMatchObject({
      enabled: false,
      storageAvailable: false,
      source: 'memory_fallback',
    });
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
    __resetSoundPreferenceForTests();
    __resetAudioAlertLogForTests();
    __resetDndForTests();
    disableDnd();

    // Minimal AudioContext mock: tracks construction and provides the
    // surface playChime exercises (oscillators, gains, currentTime).
    audioContextCtor = vi.fn().mockImplementation(function () {
      return {
      currentTime: 0,
      state: 'running',
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
      };
    });
    vi.stubGlobal('AudioContext', audioContextCtor);
  });

  afterEach(() => {
    __resetAudioAlertLogForTests();
    __resetSoundPreferenceForTests();
    __resetDndForTests();
    vi.unstubAllGlobals();
  });

  test('constructs AudioContext when sound enabled and DND off and records scheduled decision', () => {
    expect(isSoundEnabled()).toBe(true);
    const decision = maybePlayChime({ source: 'manual_test', reason: 'operator_test' });
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      source: 'manual_test',
      outcome: 'scheduled',
      reason: 'operator_test',
      soundEnabled: true,
      dndEnabled: false,
    });
    expect(getAudioAlertSnapshot().lastDecision?.outcome).toBe('scheduled');
  });

  test('does not construct AudioContext when sound disabled and records muted suppression', () => {
    setSoundEnabled(false);
    const decision = maybePlayChime({ source: 'manual_test', reason: 'operator_test' });
    expect(audioContextCtor).not.toHaveBeenCalled();
    expect(decision.outcome).toBe('suppressed_muted');
    expect(getAudioAlertSnapshot().lastDecision?.outcome).toBe('suppressed_muted');
  });

  test('does not construct AudioContext when DND enabled and records DND suppression', () => {
    enableDnd();
    const decision = maybePlayChime({ source: 'manual_test', reason: 'operator_test' });
    expect(audioContextCtor).not.toHaveBeenCalled();
    expect(decision.outcome).toBe('suppressed_dnd');
    expect(decision.dndEnabled).toBe(true);
  });

  test('records AudioContext unavailable', () => {
    vi.stubGlobal('AudioContext', undefined);

    const decision = maybePlayChime({ source: 'manual_test', reason: 'operator_test' });

    expect(decision.outcome).toBe('audio_context_unavailable');
    expect(getAudioAlertSnapshot().lastDecision?.outcome).toBe('audio_context_unavailable');
  });

  test('records AudioContext construction errors', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    audioContextCtor.mockImplementation(function () {
      throw new Error('autoplay');
    });

    const decision = maybePlayChime({ source: 'manual_test', reason: 'operator_test' });

    expect(decision.outcome).toBe('audio_context_error');
    expect(decision.reason).toBe('audio_context_error');
    warnSpy.mockRestore();
  });

  test('updates the recorded decision when suspended AudioContext resume rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let state: AudioContextState = 'suspended';
    audioContextCtor.mockImplementation(function () {
      return {
        currentTime: 0,
        get state() {
          return state;
        },
        destination: {},
        close: vi.fn(),
        resume: vi.fn().mockRejectedValue(new Error('autoplay')),
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
      };
    });

    const decision = maybePlayChime({ source: 'manual_test', reason: 'operator_test' });
    expect(decision).toMatchObject({
      outcome: 'scheduled',
      resumeAttempted: true,
      resumeFailed: false,
    });

    state = 'suspended';
    await Promise.resolve();
    await Promise.resolve();

    expect(getAudioAlertSnapshot().lastDecision).toMatchObject({
      id: decision.id,
      outcome: 'audio_context_error',
      reason: 'audio_context_resume_error',
      resumeAttempted: true,
      resumeFailed: true,
    });
    warnSpy.mockRestore();
  });

  test('console breadcrumb redacts task name and task id', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    maybePlayChime({
      source: 'finding',
      reason: 'permission_blocked warning on Secret Customer Task',
      taskName: 'Secret Customer Task',
      taskId: 'task-secret-123',
      agentId: 'agent-a',
      anomalyType: 'permission_blocked',
      severity: 'warning',
    });

    const payload = JSON.stringify(debugSpy.mock.calls[0]?.[1]);
    expect(payload).not.toContain('Secret Customer Task');
    expect(payload).not.toContain('task-secret-123');
    expect(payload).toContain('permission_blocked');
    debugSpy.mockRestore();
  });
});
