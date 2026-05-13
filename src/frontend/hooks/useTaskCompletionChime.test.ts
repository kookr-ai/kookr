// @vitest-environment jsdom

import React, { StrictMode } from 'react';
import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  evaluateCompletionChime,
  useTaskCompletionChime,
  type FocusedStatus,
} from './useTaskCompletionChime.js';
import { useKookrStore } from '../store/useStore.js';
import { __resetDndForTests, enableDnd, disableDnd } from '../hooks/useDnd.js';
import { __resetSoundPreferenceForTests, setSoundEnabled } from '../audio/sound.js';
import { __resetAudioAlertLogForTests, getAudioAlertSnapshot } from '../audio/audio-alert-log.js';
import type { TaskStatus } from '../../core/types.js';
import type { AgentState } from '../../shared/protocol.js';

function mkAgent(agentId: string, taskStatus?: TaskStatus): AgentState {
  return {
    agentId,
    events: [],
    anomaly: null,
    taskStatus,
  };
}

describe('evaluateCompletionChime — focus and selection guards', () => {
  test('no selection → no chime, ref cleared', () => {
    const result = evaluateCompletionChime({ agentId: 'a', status: 'inProgress' }, null, undefined);
    expect(result.shouldChime).toBe(false);
    expect(result.next).toBeNull();
    expect(result.reason).toBe('no_selection');
  });

  test('selection but agent not in list → no chime, ref cleared', () => {
    const result = evaluateCompletionChime({ agentId: 'a', status: 'inProgress' }, 'a', undefined);
    expect(result.shouldChime).toBe(false);
    expect(result.next).toBeNull();
    expect(result.reason).toBe('unknown_agent');
  });

  test('first observation of a focused agent → prime ref, no chime', () => {
    const result = evaluateCompletionChime(null, 'a', mkAgent('a', 'inProgress'));
    expect(result.shouldChime).toBe(false);
    expect(result.next).toEqual<FocusedStatus>({ agentId: 'a', status: 'inProgress' });
    expect(result.reason).toBe('focus_changed_prime');
  });

  test('hydration: focused agent already terminal at first observation → no chime', () => {
    const result = evaluateCompletionChime(null, 'a', mkAgent('a', 'completed'));
    expect(result.shouldChime).toBe(false);
    expect(result.next).toEqual<FocusedStatus>({ agentId: 'a', status: 'completed' });
  });
});

describe('evaluateCompletionChime — transitions while focused', () => {
  test('inProgress → completed → chime', () => {
    const prev: FocusedStatus = { agentId: 'a', status: 'inProgress' };
    const result = evaluateCompletionChime(prev, 'a', mkAgent('a', 'completed'));
    expect(result.shouldChime).toBe(true);
    expect(result.next).toEqual<FocusedStatus>({ agentId: 'a', status: 'completed' });
    expect(result.reason).toBe('terminal_transition');
    expect(result.context).toMatchObject({
      source: 'task_completion',
      reason: 'task completed',
      agentId: 'a',
      previousStatus: 'inProgress',
      nextStatus: 'completed',
      selectedAgentId: 'a',
      focused: true,
      primaryCause: 'task_completion',
    });
  });

  test('inProgress → terminated → chime', () => {
    const prev: FocusedStatus = { agentId: 'a', status: 'inProgress' };
    const result = evaluateCompletionChime(prev, 'a', mkAgent('a', 'terminated'));
    expect(result.shouldChime).toBe(true);
  });

  test('inProgress → cancelled → chime', () => {
    const prev: FocusedStatus = { agentId: 'a', status: 'inProgress' };
    const result = evaluateCompletionChime(prev, 'a', mkAgent('a', 'cancelled'));
    expect(result.shouldChime).toBe(true);
  });

  test('open → completed → chime', () => {
    const prev: FocusedStatus = { agentId: 'a', status: 'open' };
    const result = evaluateCompletionChime(prev, 'a', mkAgent('a', 'completed'));
    expect(result.shouldChime).toBe(true);
  });

  test('pending → completed → chime (rare but valid)', () => {
    const prev: FocusedStatus = { agentId: 'a', status: 'pending' };
    const result = evaluateCompletionChime(prev, 'a', mkAgent('a', 'completed'));
    expect(result.shouldChime).toBe(true);
  });
});

describe('evaluateCompletionChime — no-chime cases while focused', () => {
  test('same status (e.g. delta updates an unrelated field) → no chime', () => {
    const prev: FocusedStatus = { agentId: 'a', status: 'inProgress' };
    const result = evaluateCompletionChime(prev, 'a', mkAgent('a', 'inProgress'));
    expect(result.shouldChime).toBe(false);
    expect(result.next).toEqual<FocusedStatus>({ agentId: 'a', status: 'inProgress' });
  });

  test('non-terminal → non-terminal (e.g. open → inProgress) → no chime', () => {
    const prev: FocusedStatus = { agentId: 'a', status: 'open' };
    const result = evaluateCompletionChime(prev, 'a', mkAgent('a', 'inProgress'));
    expect(result.shouldChime).toBe(false);
  });

  test('terminal → non-terminal (reopen completed → open) → no chime', () => {
    const prev: FocusedStatus = { agentId: 'a', status: 'completed' };
    const result = evaluateCompletionChime(prev, 'a', mkAgent('a', 'open'));
    expect(result.shouldChime).toBe(false);
  });

  test('terminal → terminal (ack flow terminated → completed) → no chime', () => {
    const prev: FocusedStatus = { agentId: 'a', status: 'terminated' };
    const result = evaluateCompletionChime(prev, 'a', mkAgent('a', 'completed'));
    expect(result.shouldChime).toBe(false);
  });

  test('next status undefined → no chime', () => {
    const prev: FocusedStatus = { agentId: 'a', status: 'inProgress' };
    const result = evaluateCompletionChime(prev, 'a', mkAgent('a', undefined));
    expect(result.shouldChime).toBe(false);
  });

  test('prev.status undefined → terminal next → chime (status arrives after agent first observed)', () => {
    // Edge case: an agent can be added to the dashboard with taskStatus
    // undefined (session-only agent before task metadata populates), then
    // later a delta supplies a terminal status. The user did observe the
    // agent while focused, so a chime is the right outcome.
    const prev: FocusedStatus = { agentId: 'a', status: undefined };
    const result = evaluateCompletionChime(prev, 'a', mkAgent('a', 'completed'));
    expect(result.shouldChime).toBe(true);
    expect(result.next).toEqual<FocusedStatus>({ agentId: 'a', status: 'completed' });
  });
});

describe('evaluateCompletionChime — focus changes invalidate stale state', () => {
  test('focus switches from A to B → prime ref for B, no chime', () => {
    const prev: FocusedStatus = { agentId: 'a', status: 'inProgress' };
    const result = evaluateCompletionChime(prev, 'b', mkAgent('b', 'inProgress'));
    expect(result.shouldChime).toBe(false);
    expect(result.next).toEqual<FocusedStatus>({ agentId: 'b', status: 'inProgress' });
  });

  test('stale-completion guard: focus A (inProgress) → focus away → A completes → focus back → no chime', () => {
    // Step 1: focus A, prev=null → prime
    let prev: FocusedStatus | null = null;
    let r = evaluateCompletionChime(prev, 'a', mkAgent('a', 'inProgress'));
    prev = r.next;
    expect(r.shouldChime).toBe(false);

    // Step 2: focus shifts to B; A may complete behind the scenes but the
    // hook only sees the focused agent. evaluateCompletionChime would be
    // invoked with selectedAgentId='b' for any agents-array update.
    r = evaluateCompletionChime(prev, 'b', mkAgent('b', 'inProgress'));
    prev = r.next;
    expect(r.shouldChime).toBe(false);
    expect(prev).toEqual<FocusedStatus>({ agentId: 'b', status: 'inProgress' });

    // Step 3: focus returns to A, which is now completed off-screen. Focus
    // changed (prev.agentId='b' !== selected='a') → prime, no chime.
    r = evaluateCompletionChime(prev, 'a', mkAgent('a', 'completed'));
    expect(r.shouldChime).toBe(false);
    expect(r.next).toEqual<FocusedStatus>({ agentId: 'a', status: 'completed' });
  });

  test('rapid focus-switch in same tick: A inProgress, focus shifts to B as A=completed delta arrives → no chime for A', () => {
    // The hook is invoked with selectedAgentId='b' (the new focus). The agents
    // list contains A=completed, but we only inspect the focused one. So the
    // call is evaluateCompletionChime(prev_for_A, 'b', agent_for_B).
    const prev: FocusedStatus = { agentId: 'a', status: 'inProgress' };
    const result = evaluateCompletionChime(prev, 'b', mkAgent('b', 'inProgress'));
    expect(result.shouldChime).toBe(false);
  });

  test('reopen → re-complete cycle: chime fires on the second completion', () => {
    // Step 1: focus A=inProgress, prev=null → prime
    let prev: FocusedStatus | null = null;
    let r = evaluateCompletionChime(prev, 'a', mkAgent('a', 'inProgress'));
    prev = r.next;

    // Step 2: A completes → chime
    r = evaluateCompletionChime(prev, 'a', mkAgent('a', 'completed'));
    expect(r.shouldChime).toBe(true);
    prev = r.next;

    // Step 3: user reopens (completed → open) — no chime
    r = evaluateCompletionChime(prev, 'a', mkAgent('a', 'open'));
    expect(r.shouldChime).toBe(false);
    prev = r.next;

    // Step 4: A goes inProgress — no chime
    r = evaluateCompletionChime(prev, 'a', mkAgent('a', 'inProgress'));
    expect(r.shouldChime).toBe(false);
    prev = r.next;

    // Step 5: A completes again — chime fires (this is a real new completion,
    // not a stale double-chime)
    r = evaluateCompletionChime(prev, 'a', mkAgent('a', 'completed'));
    expect(r.shouldChime).toBe(true);
  });

  test('switch focus to a never-before-seen agent already terminal → no chime', () => {
    const prev: FocusedStatus = { agentId: 'a', status: 'inProgress' };
    const result = evaluateCompletionChime(prev, 'b', mkAgent('b', 'completed'));
    expect(result.shouldChime).toBe(false);
    expect(result.next).toEqual<FocusedStatus>({ agentId: 'b', status: 'completed' });
  });

  test('focus cleared (selectedAgentId=null) clears the ref so a later return to A does not chime', () => {
    const prev: FocusedStatus = { agentId: 'a', status: 'inProgress' };
    const r1 = evaluateCompletionChime(prev, null, undefined);
    expect(r1.shouldChime).toBe(false);
    expect(r1.next).toBeNull();

    // User selects A again; A has completed off-screen
    const r2 = evaluateCompletionChime(r1.next, 'a', mkAgent('a', 'completed'));
    expect(r2.shouldChime).toBe(false);
    expect(r2.next).toEqual<FocusedStatus>({ agentId: 'a', status: 'completed' });
  });
});

// Runtime tests: actually mount the React hook with createRoot + act and
// drive transitions through the store. These are the canonical guards for
// the hook body itself — the dependency array, the `agents.find()` lookup,
// the useRef lifecycle, and the StrictMode contract. Pattern follows
// useEscapeToClose.test.ts.
describe('useTaskCompletionChime — runtime hook behavior', () => {
  let root: Root;
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
      const tree = strict
        ? React.createElement(StrictMode, null, React.createElement(Wrapper))
        : React.createElement(Wrapper);
      root.render(tree);
    });
  }

  beforeEach(() => {
    // Per-test localStorage stub for sound preferences.
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
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

    // Reset the store to a known empty state. Direct setState matches
    // useStore's interface and avoids running the side effects of
    // selectAgent (which would also touch leftPane/narrowTab).
    useKookrStore.setState({ agents: [], selectedAgentId: null });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    __resetDndForTests();
    __resetSoundPreferenceForTests();
    __resetAudioAlertLogForTests();
    vi.unstubAllGlobals();
    useKookrStore.setState({ agents: [], selectedAgentId: null });
  });

  test('focused agent inProgress → completed produces exactly one chime', () => {
    useKookrStore.setState({
      agents: [mkAgent('a', 'inProgress')],
      selectedAgentId: 'a',
    });
    mount();

    expect(audioContextCtor).not.toHaveBeenCalled();

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('a', 'completed')] });
    });
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(getAudioAlertSnapshot().lastDecision).toMatchObject({
      source: 'task_completion',
      outcome: 'scheduled',
      agentId: 'a',
      previousStatus: 'inProgress',
      nextStatus: 'completed',
      selectedAgentId: 'a',
      focused: true,
    });

    // Repeated delta carrying the same status must not re-fire.
    act(() => {
      useKookrStore.setState({ agents: [mkAgent('a', 'completed')] });
    });
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
  });

  test('StrictMode: a single transition still produces exactly one chime', () => {
    useKookrStore.setState({
      agents: [mkAgent('a', 'inProgress')],
      selectedAgentId: 'a',
    });
    mount(true);

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('a', 'completed')] });
    });
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
  });

  test('hydration with focused agent already terminal does not chime', () => {
    useKookrStore.setState({
      agents: [mkAgent('a', 'completed')],
      selectedAgentId: 'a',
    });
    mount();

    expect(audioContextCtor).not.toHaveBeenCalled();
  });

  test('transition on a non-focused agent does not chime', () => {
    useKookrStore.setState({
      agents: [mkAgent('a', 'inProgress'), mkAgent('b', 'inProgress')],
      selectedAgentId: 'a',
    });
    mount();

    act(() => {
      useKookrStore.setState({
        agents: [mkAgent('a', 'inProgress'), mkAgent('b', 'completed')],
      });
    });
    expect(audioContextCtor).not.toHaveBeenCalled();
  });

  test('stale-completion guard: focus A → focus B → A completes → return to A → no chime', () => {
    useKookrStore.setState({
      agents: [mkAgent('a', 'inProgress'), mkAgent('b', 'inProgress')],
      selectedAgentId: 'a',
    });
    mount();

    // Focus shifts to B
    act(() => {
      useKookrStore.setState({ selectedAgentId: 'b' });
    });
    // A completes off-screen
    act(() => {
      useKookrStore.setState({
        agents: [mkAgent('a', 'completed'), mkAgent('b', 'inProgress')],
      });
    });
    // User returns to A — focus-change branch primes the ref to (a, completed)
    // without firing the chime, matching the "while focused" semantics.
    act(() => {
      useKookrStore.setState({ selectedAgentId: 'a' });
    });

    expect(audioContextCtor).not.toHaveBeenCalled();
  });

  test('user-initiated completion chimes (current spec; suppression deferred per RFC future enhancements)', () => {
    // The chime hook does not distinguish autonomous vs user-initiated
    // transitions. Pinned as a test so a future suppress-self-completion
    // change is forced to update this assertion intentionally.
    useKookrStore.setState({
      agents: [mkAgent('a', 'inProgress')],
      selectedAgentId: 'a',
    });
    mount();

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('a', 'completed')] });
    });
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
  });

  test('mute disabled: no chime on transition (gate is in maybePlayChime)', () => {
    useKookrStore.setState({
      agents: [mkAgent('a', 'inProgress')],
      selectedAgentId: 'a',
    });
    setSoundEnabled(false);
    mount();

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('a', 'completed')] });
    });
    expect(audioContextCtor).not.toHaveBeenCalled();
    expect(getAudioAlertSnapshot().lastDecision?.outcome).toBe('suppressed_muted');
  });

  test('DND on: no chime on transition', () => {
    useKookrStore.setState({
      agents: [mkAgent('a', 'inProgress')],
      selectedAgentId: 'a',
    });
    enableDnd();
    mount();

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('a', 'completed')] });
    });
    expect(audioContextCtor).not.toHaveBeenCalled();
    expect(getAudioAlertSnapshot().lastDecision?.outcome).toBe('suppressed_dnd');
  });
});
