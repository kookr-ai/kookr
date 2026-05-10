// @vitest-environment jsdom

import { describe, test, expect } from 'vitest';
import {
  evaluateCompletionChime,
  type FocusedStatus,
} from './useTaskCompletionChime.js';
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
  });

  test('selection but agent not in list → no chime, ref cleared', () => {
    const result = evaluateCompletionChime({ agentId: 'a', status: 'inProgress' }, 'a', undefined);
    expect(result.shouldChime).toBe(false);
    expect(result.next).toBeNull();
  });

  test('first observation of a focused agent → prime ref, no chime', () => {
    const result = evaluateCompletionChime(null, 'a', mkAgent('a', 'inProgress'));
    expect(result.shouldChime).toBe(false);
    expect(result.next).toEqual<FocusedStatus>({ agentId: 'a', status: 'inProgress' });
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

describe('evaluateCompletionChime — StrictMode invariants', () => {
  // StrictMode dev double-invokes effects. Under either useRef interpretation,
  // a single transition produces exactly one chime. These tests model both
  // cases by replaying evaluateCompletionChime as the hook would.

  test('ref persists across remount: second effect run sees prev=next, no second chime', () => {
    let prev: FocusedStatus | null = null;
    // Mount 1, effect 1: prime
    let r = evaluateCompletionChime(prev, 'a', mkAgent('a', 'inProgress'));
    prev = r.next;
    // Effect 2 on same render (delta arrives): transition → chime
    r = evaluateCompletionChime(prev, 'a', mkAgent('a', 'completed'));
    expect(r.shouldChime).toBe(true);
    prev = r.next;
    // Effect 3 (StrictMode synthetic remount, ref persists): no transition
    r = evaluateCompletionChime(prev, 'a', mkAgent('a', 'completed'));
    expect(r.shouldChime).toBe(false);
  });

  test('ref resets on remount: focus-change branch primes without chiming', () => {
    let prev: FocusedStatus | null = null;
    // Mount 1, effect 1: prime
    let r = evaluateCompletionChime(prev, 'a', mkAgent('a', 'inProgress'));
    prev = r.next;
    // Effect 2: transition → chime
    r = evaluateCompletionChime(prev, 'a', mkAgent('a', 'completed'));
    expect(r.shouldChime).toBe(true);
    // StrictMode synthetic remount with ref reset
    prev = null;
    // Effect 3 on remount: focus-change branch primes, no chime
    r = evaluateCompletionChime(prev, 'a', mkAgent('a', 'completed'));
    expect(r.shouldChime).toBe(false);
    expect(r.next).toEqual<FocusedStatus>({ agentId: 'a', status: 'completed' });
  });
});
