import { describe, expect, test } from 'vitest';

import type { AgentEvent } from './types.js';
import { detectAnomalies } from './anomaly-detector.js';
import { deriveTurnState } from './turn-state.js';
import { isBackgroundParked } from './background-parked.js';

function stop(extra: Partial<Extract<AgentEvent, { type: 'stop' }>> = {}): AgentEvent {
  return { type: 'stop', sessionId: 's1', lastMessage: 'done for now', ...extra };
}

describe('isBackgroundParked', () => {
  test('false when no counts / zero counts', () => {
    expect(isBackgroundParked({})).toBe(false);
    expect(isBackgroundParked({ activeBackgroundTaskCount: 0, activeSessionCronCount: 0 })).toBe(false);
  });
  test('true when a background task is active', () => {
    expect(isBackgroundParked({ activeBackgroundTaskCount: 1 })).toBe(true);
  });
  test('true when a session cron is active', () => {
    expect(isBackgroundParked({ activeSessionCronCount: 2 })).toBe(true);
  });
});

describe('needs_input is suppressed when the agent is parked on background work (RFC R3)', () => {
  test('a plain Stop still produces needs_input', () => {
    const anomaly = detectAnomalies([stop()], 's1');
    expect(anomaly?.type).toBe('needs_input');
  });

  test('a Stop with an active background task produces NO needs_input (no false positive)', () => {
    const anomaly = detectAnomalies([stop({ activeBackgroundTaskCount: 1 })], 's1');
    expect(anomaly).toBeNull();
  });

  test('a Stop with an active session cron (e.g. a 20-min wakeup) produces NO needs_input', () => {
    const anomaly = detectAnomalies([stop({ activeSessionCronCount: 1 })], 's1');
    expect(anomaly).toBeNull();
  });

  test('the detector and turn-state agree on the same Stop (no drift)', () => {
    const parked = stop({ activeBackgroundTaskCount: 1 });
    // turn-state calls it "running", the detector raises nothing — consistent.
    expect(deriveTurnState([parked])).toBe('running');
    expect(detectAnomalies([parked], 's1')).toBeNull();

    const clean = stop();
    expect(deriveTurnState([clean])).toBe('completed_turn');
    expect(detectAnomalies([clean], 's1')?.type).toBe('needs_input');
  });
});
