import { describe, expect, test } from 'vitest';

import type { AgentEvent } from './types.js';
import { detectAnomalies } from './anomaly-detector.js';
import { deriveTurnState } from './turn-state.js';
import { endsWithOperatorQuestion, isBackgroundParked, isSilentBackgroundPark } from './background-parked.js';

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

describe('endsWithOperatorQuestion (issue #3569)', () => {
  test.each([
    ['Shall I start the runs?'],
    ['Shall I go ahead?\n'],
    ['Shall I go ahead?  \n\n'],
    ['**Shall I merge it?**'],
    ['Want me to proceed with option A or B?)'],
    ['Did you mean "foo?"'],
    ['_Proceed?_'],
    ["'ok?'"],
    ['\u201Cgo?\u201D'],
    ['\u2018go?\u2019'],
    ['[A or B?]'],
    ['続けますか？'],
  ])('true for a question tail: %j', (message) => {
    expect(endsWithOperatorQuestion(message)).toBe(true);
  });

  test.each([
    [''],
    ['   '],
    ['waiting on background verify'],
    ['Is it flaky? I re-ran it and it passed. Waiting on the next heartbeat.'],
    ['Done.'],
  ])('false without a question tail: %j', (message) => {
    expect(endsWithOperatorQuestion(message)).toBe(false);
  });

  test('false for an absent message', () => {
    expect(endsWithOperatorQuestion(undefined)).toBe(false);
  });

  test('linear on a long trailing closer run (uncapped lastMessage)', () => {
    const start = performance.now();
    expect(endsWithOperatorQuestion(`a${' '.repeat(200_000)}b${' '.repeat(200_000)}`)).toBe(false);
    expect(endsWithOperatorQuestion(`Go?${' '.repeat(200_000)}`)).toBe(true);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('isSilentBackgroundPark (issue #3569)', () => {
  test('a park that does not ask anything is silent', () => {
    expect(isSilentBackgroundPark({ activeBackgroundTaskCount: 1, lastMessage: 'waiting on CI' })).toBe(true);
  });
  test('a park ending in a question to the operator is not silent', () => {
    expect(isSilentBackgroundPark({ activeBackgroundTaskCount: 1, lastMessage: 'Shall I go ahead?' })).toBe(false);
    expect(isSilentBackgroundPark({ activeSessionCronCount: 1, lastMessage: 'Shall I go ahead?' })).toBe(false);
  });
  test('an unparked stop is never a silent park, question or not', () => {
    expect(isSilentBackgroundPark({ lastMessage: 'done' })).toBe(false);
    expect(isSilentBackgroundPark({ lastMessage: 'Shall I go ahead?' })).toBe(false);
  });
});

describe('a parked turn that ends with a question still flags needs_input (issue #3569)', () => {
  test('question-park on a watch shell → needs_input on the event path', () => {
    const anomaly = detectAnomalies([stop({ activeBackgroundTaskCount: 3, lastMessage: 'Shall I start the runs?' })], 's1');
    expect(anomaly?.type).toBe('needs_input');
    expect(anomaly?.subType).toBe('stop');
  });

  test('the explanation shows the message tail, where the question is', () => {
    const lastMessage = `${'Long status report. '.repeat(20)}Shall I start the runs?`;
    const anomaly = detectAnomalies([stop({ activeBackgroundTaskCount: 1, lastMessage })], 's1');
    expect(anomaly?.explanation).toContain('Shall I start the runs?');
  });

  test('question-park on a session cron → needs_input', () => {
    const anomaly = detectAnomalies([stop({ activeSessionCronCount: 1, lastMessage: 'Shall I go ahead?' })], 's1');
    expect(anomaly?.type).toBe('needs_input');
  });

  test('a mid-message question with a non-question tail stays suppressed', () => {
    const anomaly = detectAnomalies(
      [stop({ activeBackgroundTaskCount: 1, lastMessage: 'Flaky? Re-running in the background.' })],
      's1',
    );
    expect(anomaly).toBeNull();
  });

  test('turn-state semantics are unchanged: a question-park is still running, not a clean turn end', () => {
    const questionPark = stop({ activeBackgroundTaskCount: 1, lastMessage: 'Shall I go ahead?' });
    expect(deriveTurnState([questionPark])).toBe('running');
  });
});
