import { describe, expect, it } from 'vitest';
import { degradeLogPath, parseDegradeLog, summarizeDegrades } from './degrade-log.js';

describe('degradeLogPath', () => {
  it('resolves under ~/.kookr — the same dir the hook writes to', () => {
    expect(degradeLogPath({ HOME: '/test-home' } as NodeJS.ProcessEnv)).toBe('/test-home/.kookr/pr-checklist-degrade.log');
  });

  it('falls back to a relative path when HOME is unset', () => {
    expect(degradeLogPath({} as NodeJS.ProcessEnv)).toBe('.kookr/pr-checklist-degrade.log');
  });
});

describe('parseDegradeLog', () => {
  it('parses JSONL entries and counts malformed / non-conforming lines', () => {
    const text = [
      JSON.stringify({ at: '2026-07-01T00:00:00Z', event: 'fail-open', reason: 'x' }),
      '', // blank lines are skipped, not counted
      'not-json',
      JSON.stringify({ event: 'fail-open' }), // missing `at` → malformed
      JSON.stringify({ at: '2026-07-02T00:00:00Z', event: 'fail-open' }), // reason optional
    ].join('\n');
    const { entries, malformed } = parseDegradeLog(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ at: '2026-07-01T00:00:00Z', event: 'fail-open', reason: 'x' });
    expect(entries[1].reason).toBeUndefined();
    expect(malformed).toBe(2);
  });
});

describe('summarizeDegrades', () => {
  const nowMs = Date.parse('2026-07-02T00:00:00Z');

  it('warns when a fail-open falls inside the 7-day window and counts windows', () => {
    const entries = [
      { at: '2026-07-01T12:00:00Z', event: 'fail-open' }, // 12h ago
      { at: '2026-06-28T00:00:00Z', event: 'fail-open' }, // 4d ago
      { at: '2026-01-01T00:00:00Z', event: 'fail-open' }, // > 7d ago
    ];
    const s = summarizeDegrades(entries, 1, nowMs);
    expect(s.status).toBe('warn');
    expect(s.total).toBe(3);
    expect(s.last24h).toBe(1);
    expect(s.last7d).toBe(2);
    expect(s.malformedLines).toBe(1);
    expect(s.recent).toHaveLength(3);
  });

  it('is ok when the only events are older than 7 days', () => {
    const s = summarizeDegrades([{ at: '2026-01-01T00:00:00Z', event: 'fail-open' }], 0, nowMs);
    expect(s.status).toBe('ok');
    expect(s.last7d).toBe(0);
  });

  it('ignores unparseable timestamps in the windows (never inflates recent counts)', () => {
    const s = summarizeDegrades([{ at: 'unknown', event: 'fail-open' }], 0, nowMs);
    expect(s.total).toBe(1);
    expect(s.last24h).toBe(0);
    expect(s.last7d).toBe(0);
    expect(s.status).toBe('ok');
  });

  it('keeps only the last 5 entries in recent', () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({ at: `2026-01-0${i + 1}T00:00:00Z`, event: 'fail-open' }));
    const s = summarizeDegrades(entries, 0, nowMs);
    expect(s.recent).toHaveLength(5);
    expect(s.recent[0].at).toBe('2026-01-04T00:00:00Z');
  });
});
