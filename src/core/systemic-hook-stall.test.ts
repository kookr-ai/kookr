import { describe, expect, test } from 'vitest';
import {
  SYSTEMIC_HOOK_STALL_MIN_AGENTS,
  SYSTEMIC_HOOK_STALL_REASON,
  SYSTEMIC_HOOK_STALL_WINDOW_MS,
  SystemicHookStallTracker,
} from './systemic-hook-stall.js';

describe('SystemicHookStallTracker', () => {
  test('exports policy constants', () => {
    expect(SYSTEMIC_HOOK_STALL_MIN_AGENTS).toBe(2);
    expect(SYSTEMIC_HOOK_STALL_WINDOW_MS).toBe(60_000);
    expect(SYSTEMIC_HOOK_STALL_REASON).toBe('systemic_hook_stall');
  });

  test('a lone agent is not systemic', () => {
    const tracker = new SystemicHookStallTracker();
    const t0 = 1_000_000;
    tracker.recordVerdict('agent-a', t0);
    expect(tracker.countRecent(t0)).toBe(1);
    expect(tracker.shouldSuppress('hook_disconnected', t0)).toBe(false);
  });

  test('two agents within the window trip systemic suppression', () => {
    const tracker = new SystemicHookStallTracker();
    const t0 = 1_000_000;
    tracker.recordVerdict('agent-a', t0);
    tracker.recordVerdict('agent-b', t0 + 1_000);
    expect(tracker.countRecent(t0 + 1_000)).toBe(2);
    expect(tracker.shouldSuppress('hook_disconnected', t0 + 1_000)).toBe(true);
  });

  test('non-hook_disconnected types are never suppressed', () => {
    const tracker = new SystemicHookStallTracker();
    const t0 = 1_000_000;
    tracker.recordVerdict('agent-a', t0);
    tracker.recordVerdict('agent-b', t0);
    expect(tracker.shouldSuppress('stale_agent', t0)).toBe(false);
    expect(tracker.shouldSuppress('needs_input', t0)).toBe(false);
    expect(tracker.shouldSuppress('permission_blocked', t0)).toBe(false);
  });

  test('re-recording the same agent does not inflate the count', () => {
    const tracker = new SystemicHookStallTracker();
    const t0 = 1_000_000;
    tracker.recordVerdict('agent-a', t0);
    tracker.recordVerdict('agent-a', t0 + 5_000);
    expect(tracker.countRecent(t0 + 5_000)).toBe(1);
    expect(tracker.shouldSuppress('hook_disconnected', t0 + 5_000)).toBe(false);
  });

  test('entries older than the window are pruned and stop counting', () => {
    const tracker = new SystemicHookStallTracker();
    const t0 = 1_000_000;
    tracker.recordVerdict('agent-a', t0);
    tracker.recordVerdict('agent-b', t0 + 1_000);

    // Still inside the window for both.
    expect(tracker.shouldSuppress('hook_disconnected', t0 + SYSTEMIC_HOOK_STALL_WINDOW_MS)).toBe(true);

    // agent-a aged out; only agent-b remains under threshold.
    const pastA = t0 + SYSTEMIC_HOOK_STALL_WINDOW_MS + 1;
    expect(tracker.countRecent(pastA)).toBe(1);
    expect(tracker.shouldSuppress('hook_disconnected', pastA)).toBe(false);

    // Both aged out.
    const pastBoth = t0 + 1_000 + SYSTEMIC_HOOK_STALL_WINDOW_MS + 1;
    expect(tracker.countRecent(pastBoth)).toBe(0);
    expect(tracker.shouldSuppress('hook_disconnected', pastBoth)).toBe(false);
  });

  test('clear removes one agent without affecting siblings', () => {
    const tracker = new SystemicHookStallTracker();
    const t0 = 1_000_000;
    tracker.recordVerdict('agent-a', t0);
    tracker.recordVerdict('agent-b', t0);
    tracker.clear('agent-a');
    expect(tracker.countRecent(t0)).toBe(1);
    expect(tracker.shouldSuppress('hook_disconnected', t0)).toBe(false);
    // Idempotent.
    tracker.clear('agent-a');
    expect(tracker.countRecent(t0)).toBe(1);
  });

  test('suppression holds while ≥2 agents stay inside the rolling window', () => {
    // Regression for the admit→purge oscillation: the signal is verdict-based,
    // so continued verdicts from a rotating set of agents keep the count ≥2
    // even if the queue was purged.
    const tracker = new SystemicHookStallTracker();
    let t = 1_000_000;
    tracker.recordVerdict('agent-a', t);
    tracker.recordVerdict('agent-b', t);
    expect(tracker.shouldSuppress('hook_disconnected', t)).toBe(true);

    for (let round = 0; round < 3; round++) {
      t += 5_000;
      for (const id of ['agent-a', 'agent-b', 'agent-c']) {
        tracker.recordVerdict(id, t);
        expect(tracker.shouldSuppress('hook_disconnected', t)).toBe(true);
      }
    }
    expect(tracker.countRecent(t)).toBe(3);
  });
});
