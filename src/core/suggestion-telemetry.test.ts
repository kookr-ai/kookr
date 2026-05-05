import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  generateSuggestionId,
  getActiveSuggestionId,
  startLifecycle,
  resolveLifecycle,
  drainLifecycles,
  _resetLifecycles,
} from './suggestion-telemetry.js';
import type { DeferredTelemetryLogWriter, TelemetryEvent } from './telemetry.js';

function makeMockTelemetryLog() {
  const events: TelemetryEvent[] = [];
  return {
    events,
    log: {
      append: vi.fn(async (event: TelemetryEvent) => { events.push(event); }),
      appendBatch: vi.fn(async (batch: TelemetryEvent[]) => { events.push(...batch); }),
      getFilePath: vi.fn(() => '/mock/telemetry.jsonl'),
    } as unknown as DeferredTelemetryLogWriter,
  };
}

describe('suggestion-telemetry', () => {
  beforeEach(() => {
    _resetLifecycles();
  });

  test('generateSuggestionId returns 12-char string', () => {
    const id = generateSuggestionId();
    expect(id).toHaveLength(12);
    expect(typeof id).toBe('string');
  });

  test('generateSuggestionId returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSuggestionId()));
    expect(ids.size).toBe(100);
  });

  test('getActiveSuggestionId returns undefined when no lifecycle exists', () => {
    expect(getActiveSuggestionId('agent-1')).toBeUndefined();
  });

  test('startLifecycle creates a pending lifecycle', () => {
    startLifecycle('agent-1', 'sug-1');
    expect(getActiveSuggestionId('agent-1')).toBe('sug-1');
  });

  test('resolveLifecycle as used writes telemetry', () => {
    const { events, log } = makeMockTelemetryLog();
    startLifecycle('agent-1', 'sug-1', log);
    resolveLifecycle('agent-1', 'used', log);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'suggestion_lifecycle',
      suggestionId: 'sug-1',
      agentId: 'agent-1',
      outcome: 'used',
    });
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(getActiveSuggestionId('agent-1')).toBeUndefined();
  });

  test('resolveLifecycle as cleared writes telemetry', () => {
    const { events, log } = makeMockTelemetryLog();
    startLifecycle('agent-1', 'sug-2', log);
    resolveLifecycle('agent-1', 'cleared', log);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'suggestion_lifecycle',
      outcome: 'cleared',
      suggestionId: 'sug-2',
    });
  });

  test('double-resolve is idempotent', () => {
    const { events, log } = makeMockTelemetryLog();
    startLifecycle('agent-1', 'sug-1', log);
    resolveLifecycle('agent-1', 'used', log);
    resolveLifecycle('agent-1', 'cleared', log);

    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('used');
  });

  test('resolveLifecycle is no-op when no lifecycle exists', () => {
    const { events, log } = makeMockTelemetryLog();
    resolveLifecycle('nonexistent', 'cleared', log);
    expect(events).toHaveLength(0);
  });

  test('stale replacement: startLifecycle resolves existing pending as cleared', () => {
    const { events, log } = makeMockTelemetryLog();
    startLifecycle('agent-1', 'sug-old', log);
    startLifecycle('agent-1', 'sug-new', log);

    // Old lifecycle was auto-resolved as cleared
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      suggestionId: 'sug-old',
      outcome: 'cleared',
    });

    // New lifecycle is active
    expect(getActiveSuggestionId('agent-1')).toBe('sug-new');
  });

  test('drainLifecycles resolves all pending as cleared', () => {
    const { events, log } = makeMockTelemetryLog();
    startLifecycle('agent-1', 'sug-1', log);
    startLifecycle('agent-2', 'sug-2', log);

    drainLifecycles(log);

    expect(events).toHaveLength(2);
    expect(events.every(e => e.outcome === 'cleared')).toBe(true);
    expect(getActiveSuggestionId('agent-1')).toBeUndefined();
    expect(getActiveSuggestionId('agent-2')).toBeUndefined();
  });

  test('drainLifecycles is no-op when map is empty', () => {
    const { events, log } = makeMockTelemetryLog();
    drainLifecycles(log);
    expect(events).toHaveLength(0);
  });

  test('works without telemetryLog (no crash)', () => {
    startLifecycle('agent-1', 'sug-1');
    resolveLifecycle('agent-1', 'used');
    expect(getActiveSuggestionId('agent-1')).toBeUndefined();
  });

  test('telemetry write failure is caught and logged', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failingLog = {
      append: vi.fn(() => Promise.reject(new Error('disk full'))),
      appendBatch: vi.fn(),
      getFilePath: vi.fn(() => null),
    } as unknown as DeferredTelemetryLogWriter;

    startLifecycle('agent-1', 'sug-1', failingLog);
    resolveLifecycle('agent-1', 'cleared', failingLog);

    // Wait for fire-and-forget promise to settle
    await new Promise(r => setTimeout(r, 10));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[suggestion-telemetry] Write failed'),
    );
    warnSpy.mockRestore();
  });

  test('durationMs is clamped to zero minimum', () => {
    const { events, log } = makeMockTelemetryLog();
    // Start lifecycle then immediately resolve — durationMs should be >= 0
    startLifecycle('agent-1', 'sug-1', log);
    resolveLifecycle('agent-1', 'used', log);

    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});
