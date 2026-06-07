// @vitest-environment jsdom

import React, { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  __resetTaskCompletionChimeForTests,
  evaluateCompletionSignalChime,
  useTaskCompletionChime,
} from './useTaskCompletionChime.js';
import { useKookrStore } from '../store/useStore.js';
import { __resetDndForTests, disableDnd, enableDnd } from '../hooks/useDnd.js';
import { __resetSoundPreferenceForTests, setSoundEnabled } from '../audio/sound.js';
import { __resetAudioAlertLogForTests, getAudioAlertSnapshot } from '../audio/audio-alert-log.js';
import type { AgentState } from '../../shared/protocol.js';

function mkAgent(agentId: string, signalId?: string): AgentState {
  return {
    agentId,
    taskId: `task-${agentId}`,
    taskName: `Task ${agentId}`,
    events: [],
    anomaly: null,
    taskStatus: 'inProgress',
    ...(signalId
      ? {
          latestCompletionSignal: {
            id: signalId,
          },
        }
      : {}),
  };
}

describe('evaluateCompletionSignalChime', () => {
  beforeEach(() => {
    __resetTaskCompletionChimeForTests();
  });

  test('initial hydration seeds existing signal ids without chiming', () => {
    const result = evaluateCompletionSignalChime([mkAgent('a', 'sig-a')], 1000);

    expect(result).toEqual({ contexts: [] });
    expect(evaluateCompletionSignalChime([mkAgent('a', 'sig-a')], 2000).contexts).toEqual([]);
  });

  test('new signal after hydration chimes even when the task is not focused', () => {
    evaluateCompletionSignalChime([], 1000);

    const result = evaluateCompletionSignalChime([mkAgent('a', 'sig-a')], 3000);

    expect(result.contexts).toHaveLength(1);
    expect(result.audibleContext).toBe(result.contexts[0]);
    expect(result.audibleContext).toMatchObject({
      source: 'completion_signal',
      reason: 'agent signaled task complete',
      agentId: 'a',
      taskId: 'task-a',
      taskName: 'Task a',
      completionSignalId: 'sig-a',
      candidateCount: 1,
      primaryCause: 'completion_signal',
    });
  });

  test('manual status completion without a completion signal does not chime', () => {
    evaluateCompletionSignalChime([], 1000);

    expect(evaluateCompletionSignalChime([{ ...mkAgent('a'), taskStatus: 'completed' }], 3000))
      .toEqual({ contexts: [] });
  });

  test('multiple new signals in one evaluation produce one audible context and one decision per signal', () => {
    evaluateCompletionSignalChime([], 1000);

    const result = evaluateCompletionSignalChime([mkAgent('a', 'sig-a'), mkAgent('b', 'sig-b')], 3000);

    expect(result.contexts.map((context) => context.completionSignalId)).toEqual(['sig-a', 'sig-b']);
    expect(result.audibleContext).toBe(result.contexts[0]);
    expect(result.audibleContext).toMatchObject({
      completionSignalId: 'sig-a',
      candidateCount: 2,
    });
    expect(result.contexts[1]).toMatchObject({
      completionSignalId: 'sig-b',
      candidateCount: 1,
    });
  });

  test('debounce suppresses another audible cue inside the debounce window while remembering the signal', () => {
    evaluateCompletionSignalChime([], 1000);
    expect(evaluateCompletionSignalChime([mkAgent('a', 'sig-a')], 3000).audibleContext).toBeDefined();

    const debounced = evaluateCompletionSignalChime([mkAgent('a', 'sig-a'), mkAgent('b', 'sig-b')], 3200);
    expect(debounced.contexts.map((context) => context.completionSignalId)).toEqual(['sig-b']);
    expect(debounced.audibleContext).toBeUndefined();

    expect(evaluateCompletionSignalChime([mkAgent('b', 'sig-b')], 5000).contexts).toEqual([]);
  });
});

describe('useTaskCompletionChime', () => {
  let root: Root | null;
  let container: HTMLDivElement;
  let audioContextCtor: ReturnType<typeof vi.fn>;
  let store: Map<string, string>;

  function Wrapper() {
    useTaskCompletionChime();
    return null;
  }

  function mount(strict = false): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(strict
        ? React.createElement(StrictMode, null, React.createElement(Wrapper))
        : React.createElement(Wrapper));
    });
  }

  beforeEach(() => {
    root = null;
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
    __resetTaskCompletionChimeForTests();
    __resetDndForTests();
    __resetSoundPreferenceForTests();
    __resetAudioAlertLogForTests();
    disableDnd();

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
    useKookrStore.setState({ agents: [], selectedAgentId: null, agentsHydrated: false });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    __resetTaskCompletionChimeForTests();
    __resetDndForTests();
    __resetSoundPreferenceForTests();
    __resetAudioAlertLogForTests();
    vi.unstubAllGlobals();
    useKookrStore.setState({ agents: [], selectedAgentId: null, agentsHydrated: false });
  });

  test('hydration with an existing signal does not chime', () => {
    useKookrStore.setState({ agents: [mkAgent('a', 'sig-a')], selectedAgentId: 'a', agentsHydrated: true });
    mount();

    expect(audioContextCtor).not.toHaveBeenCalled();
  });

  test('first hydrated snapshot after an empty pre-hydration store seeds without chiming', () => {
    useKookrStore.setState({ agents: [], selectedAgentId: null, agentsHydrated: false });
    mount();

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('a', 'sig-a')], agentsHydrated: true });
    });
    expect(audioContextCtor).not.toHaveBeenCalled();

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('a', 'sig-a'), mkAgent('b', 'sig-b')], agentsHydrated: true });
    });
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
  });

  test('new signal on a non-focused task chimes once', () => {
    useKookrStore.setState({ agents: [mkAgent('a')], selectedAgentId: 'a', agentsHydrated: true });
    mount();

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('a'), mkAgent('b', 'sig-b')] });
    });

    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(getAudioAlertSnapshot().lastDecision).toMatchObject({
      source: 'completion_signal',
      outcome: 'scheduled',
      agentId: 'b',
      taskId: 'task-b',
      completionSignalId: 'sig-b',
      candidateCount: 1,
    });

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('a'), mkAgent('b', 'sig-b')] });
    });
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
  });

  test('multiple new signals record every signal while scheduling one audible cue', () => {
    useKookrStore.setState({ agents: [], selectedAgentId: null, agentsHydrated: true });
    mount();

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('a', 'sig-a'), mkAgent('b', 'sig-b')] });
    });

    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(getAudioAlertSnapshot().entries.map((entry) => ({
      signalId: entry.completionSignalId,
      outcome: entry.outcome,
      candidateCount: entry.candidateCount,
    }))).toEqual([
      { signalId: 'sig-b', outcome: 'suppressed_debounced', candidateCount: 1 },
      { signalId: 'sig-a', outcome: 'scheduled', candidateCount: 2 },
    ]);
  });

  test('StrictMode remount does not replay a hydrated signal', () => {
    useKookrStore.setState({ agents: [mkAgent('a', 'sig-a')], selectedAgentId: 'a', agentsHydrated: true });
    mount(true);

    expect(audioContextCtor).not.toHaveBeenCalled();
  });

  test('mute disabled records a suppressed completion-signal decision', () => {
    useKookrStore.setState({ agents: [], agentsHydrated: true });
    setSoundEnabled(false);
    mount();

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('a', 'sig-a')] });
    });

    expect(audioContextCtor).not.toHaveBeenCalled();
    expect(getAudioAlertSnapshot().lastDecision).toMatchObject({
      source: 'completion_signal',
      outcome: 'suppressed_muted',
      completionSignalId: 'sig-a',
    });
  });

  test('DND suppresses completion-signal audio', () => {
    useKookrStore.setState({ agents: [], agentsHydrated: true });
    enableDnd();
    mount();

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('a', 'sig-a')] });
    });

    expect(audioContextCtor).not.toHaveBeenCalled();
    expect(getAudioAlertSnapshot().lastDecision).toMatchObject({
      source: 'completion_signal',
      outcome: 'suppressed_dnd',
      completionSignalId: 'sig-a',
    });
  });

  test('DND records distinct decisions for simultaneous completion signals', () => {
    useKookrStore.setState({ agents: [], agentsHydrated: true });
    enableDnd();
    mount();

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('a', 'sig-a'), mkAgent('b', 'sig-b')] });
    });

    expect(audioContextCtor).not.toHaveBeenCalled();
    expect(getAudioAlertSnapshot().entries.map((entry) => ({
      signalId: entry.completionSignalId,
      outcome: entry.outcome,
    }))).toEqual([
      { signalId: 'sig-b', outcome: 'suppressed_dnd' },
      { signalId: 'sig-a', outcome: 'suppressed_dnd' },
    ]);
  });
});
