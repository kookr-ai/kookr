import { describe, expect, test } from 'vitest';
import { createHookParseDegradationEvaluator } from './hook-parse-degradation-rules.js';
import type { HookParseDegradationEvent } from './hook-ingestion.js';

describe('HookParseDegradationEvaluator', () => {
  function parseEvent(overrides: Partial<HookParseDegradationEvent> = {}): HookParseDegradationEvent {
    return {
      kookrSessionId: 'kookr-session-1',
      source: 'file',
      eventId: 'evt_abc123def456_9',
      sequence: 9,
      error: 'Unexpected token b',
      excerpt: '{"bad":',
      observedAt: '2026-06-11T10:00:00.000Z',
      ...overrides,
    };
  }

  test('emits one alert and per-session finding with malformed excerpt', () => {
    const evaluator = createHookParseDegradationEvaluator();
    const result = evaluator.evaluate(parseEvent());

    expect(result).toBeTruthy();
    expect(result?.alert).toMatchObject({
      type: 'alert',
      agentId: 'kookr-session-1',
      severity: 'warning',
    });
    expect(result?.alert.details).toContain('{"bad":');
    expect(result?.alert.details).toContain('evt_abc123def456_9');
    expect(result?.anomaly).toMatchObject({
      agentId: 'kookr-session-1',
      type: 'hook_parse_degraded',
      severity: 'warning',
      eventId: 'evt_abc123def456_9',
    });
    expect(result?.anomaly.explanation).toContain('{"bad":');
  });

  test('debounces repeated malformed records for the same session', () => {
    const evaluator = createHookParseDegradationEvaluator();

    expect(evaluator.evaluate(parseEvent())).not.toBeNull();
    expect(evaluator.evaluate(parseEvent({ eventId: 'evt_abc123def456_10', sequence: 10 }))).toBeNull();
    expect(evaluator.evaluate(parseEvent({ eventId: 'evt_abc123def456_11', sequence: 11 }))).toBeNull();
  });

  test('debounces independently per session', () => {
    const evaluator = createHookParseDegradationEvaluator();

    expect(evaluator.evaluate(parseEvent({ kookrSessionId: 'session-a' }))).not.toBeNull();
    expect(evaluator.evaluate(parseEvent({ kookrSessionId: 'session-a', eventId: 'evt_a_2' }))).toBeNull();
    expect(evaluator.evaluate(parseEvent({ kookrSessionId: 'session-b', eventId: 'evt_b_1' }))).not.toBeNull();
  });
});
