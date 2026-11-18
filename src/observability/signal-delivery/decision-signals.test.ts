import { describe, expect, test } from 'vitest';
import { DECISION_SIGNAL_SOURCES, isDecisionSignal, sendsToTelegram } from './decision-signals.js';

describe('isDecisionSignal', () => {
  test('an alert from a source an agent waits on is a decision', () => {
    for (const source of DECISION_SIGNAL_SOURCES) {
      expect(isDecisionSignal({ kind: 'alert', source })).toBe(true);
    }
  });

  test('the same source clearing or sending a notice is not a decision', () => {
    expect(isDecisionSignal({ kind: 'clear', source: 'permission_prompt_wait' })).toBe(false);
    expect(isDecisionSignal({ kind: 'info', source: 'agent_self_report' })).toBe(false);
  });

  test('a status alert is not a decision', () => {
    expect(isDecisionSignal({ kind: 'alert', source: 'integration-train' })).toBe(false);
    expect(isDecisionSignal({ kind: 'alert', source: 'auth_expired' })).toBe(false);
  });
});

describe('sendsToTelegram', () => {
  test('`decisions` lets only decisions through; `all` lets everything through', () => {
    const status = { kind: 'clear' as const, source: 'prod_smoke_tick' };
    const decision = { kind: 'alert' as const, source: 'permission_prompt_wait' };
    expect(sendsToTelegram(status, 'decisions')).toBe(false);
    expect(sendsToTelegram(decision, 'decisions')).toBe(true);
    expect(sendsToTelegram(status, 'all')).toBe(true);
  });
});
