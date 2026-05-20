import { describe, test, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseShadowLog,
  parseShadowLogFromFile,
  generateReport,
  generateReportFromFile,
  formatReport,
  type ShadowReport,
} from './shadow-report.js';
import type { ShadowLogEntry, ShadowHeartbeat, ShadowTransition } from './shadow-detector.js';

// --- Helpers ---

function hb(ts: string, agentId: string, shadowState: string | null, realState: string | null): ShadowHeartbeat {
  return {
    kind: 'heartbeat',
    timestamp: ts,
    agentId,
    source: 'pane_semantics',
    shadowState: shadowState as ShadowHeartbeat['shadowState'],
    realState: realState as ShadowHeartbeat['realState'],
  };
}

function transition(
  ts: string,
  agentId: string,
  type: 'entered_anomaly' | 'cleared_anomaly',
  anomalyType: string,
  realAnomaly: string | null = null,
): ShadowTransition {
  return {
    kind: 'transition',
    timestamp: ts,
    agentId,
    source: 'pane_semantics',
    transition: type,
    anomalyType: anomalyType as ShadowTransition['anomalyType'],
    realState: {
      anomaly: realAnomaly as ShadowTransition['realState']['anomaly'],
      since: realAnomaly ? '2026-03-28T10:00:00.000Z' : null,
    },
    signals: {},
  };
}

describe('parseShadowLog', () => {
  test('parses valid JSONL', () => {
    const line = JSON.stringify(hb('2026-03-28T12:00:00Z', 'a1', null, null));
    const { entries, errors } = parseShadowLog(line);
    expect(entries).toHaveLength(1);
    expect(errors).toBe(0);
  });

  test('skips empty lines', () => {
    const content = '\n\n' + JSON.stringify(hb('2026-03-28T12:00:00Z', 'a1', null, null)) + '\n\n';
    const { entries, errors } = parseShadowLog(content);
    expect(entries).toHaveLength(1);
    expect(errors).toBe(0);
  });

  test('counts parse errors for malformed lines', () => {
    const content = 'not json\n' + JSON.stringify(hb('2026-03-28T12:00:00Z', 'a1', null, null));
    const { entries, errors } = parseShadowLog(content);
    expect(entries).toHaveLength(1);
    expect(errors).toBe(1);
  });

  test('counts errors for unknown entry kinds', () => {
    const content = JSON.stringify({ kind: 'unknown', timestamp: 'x' });
    const { entries, errors } = parseShadowLog(content);
    expect(entries).toHaveLength(0);
    expect(errors).toBe(1);
  });
});

describe('generateReport', () => {
  test('returns empty report for no entries', () => {
    const report = generateReport([]);
    expect(report.observationWindow).toBeNull();
    expect(report.strategies).toHaveLength(0);
    expect(report.totalEntries).toBe(0);
  });

  test('computes observation window', () => {
    const entries: ShadowLogEntry[] = [
      hb('2026-03-28T12:00:00Z', 'a1', null, null),
      hb('2026-03-28T12:01:00Z', 'a1', null, null),
    ];
    const report = generateReport(entries);
    expect(report.observationWindow).not.toBeNull();
    expect(report.observationWindow!.endMs - report.observationWindow!.startMs).toBe(60_000);
  });

  describe('interval reconstruction', () => {
    test('both healthy — no intervals, full agreement', () => {
      const entries: ShadowLogEntry[] = [
        hb('2026-03-28T12:00:00Z', 'a1', null, null),
        hb('2026-03-28T12:00:05Z', 'a1', null, null),
        hb('2026-03-28T12:00:10Z', 'a1', null, null),
      ];
      const report = generateReport(entries);
      const s = report.strategies[0];
      expect(s.realIntervals).toBe(0);
      expect(s.matchedIntervals).toBe(0);
      expect(s.unmatchedShadowIntervals).toBe(0);
      expect(s.coverage).toBeNull(); // no real anomaly time
    });

    test('both detect same anomaly — full coverage and precision', () => {
      const entries: ShadowLogEntry[] = [
        hb('2026-03-28T12:00:00Z', 'a1', null, null),
        // Both enter anomaly at T=5
        hb('2026-03-28T12:00:05Z', 'a1', 'needs_input', 'needs_input'),
        hb('2026-03-28T12:00:10Z', 'a1', 'needs_input', 'needs_input'),
        hb('2026-03-28T12:00:15Z', 'a1', 'needs_input', 'needs_input'),
        // Both clear at T=20
        hb('2026-03-28T12:00:20Z', 'a1', null, null),
      ];
      const report = generateReport(entries);
      const s = report.strategies[0];
      expect(s.realIntervals).toBe(1);
      expect(s.matchedIntervals).toBe(1);
      expect(s.coverage).toBeCloseTo(1.0);
      expect(s.precision).toBeCloseTo(1.0);
    });

    test('shadow lags real — partial coverage', () => {
      const entries: ShadowLogEntry[] = [
        // T=0: both healthy
        hb('2026-03-28T12:00:00Z', 'a1', null, null),
        // T=5: real detects, shadow doesn't yet
        hb('2026-03-28T12:00:05Z', 'a1', null, 'needs_input'),
        // T=10: shadow catches up
        hb('2026-03-28T12:00:10Z', 'a1', 'needs_input', 'needs_input'),
        // T=15: both active
        hb('2026-03-28T12:00:15Z', 'a1', 'needs_input', 'needs_input'),
        // T=20: real clears
        hb('2026-03-28T12:00:20Z', 'a1', 'needs_input', null),
        // T=25: shadow clears
        hb('2026-03-28T12:00:25Z', 'a1', null, null),
      ];
      const report = generateReport(entries);
      const s = report.strategies[0];

      // Real interval: T=5 to T=20 (15s)
      // Shadow interval: T=10 to T=25 (15s)
      // Overlap: T=10 to T=20 (10s)
      expect(s.realIntervals).toBe(1);
      expect(s.matchedIntervals).toBe(1);
      expect(s.realAnomalyMs).toBe(15_000);
      expect(s.shadowAnomalyMs).toBe(15_000);
      expect(s.overlapMs).toBe(10_000);
      expect(s.coverage).toBeCloseTo(10_000 / 15_000); // ~66.7%
      expect(s.precision).toBeCloseTo(10_000 / 15_000); // ~66.7%
    });

    test('shadow detects anomaly real missed — shadow_only interval', () => {
      const entries: ShadowLogEntry[] = [
        hb('2026-03-28T12:00:00Z', 'a1', null, null),
        hb('2026-03-28T12:00:05Z', 'a1', 'needs_input', null),
        hb('2026-03-28T12:00:10Z', 'a1', 'needs_input', null),
        hb('2026-03-28T12:00:15Z', 'a1', null, null),
      ];
      const report = generateReport(entries);
      const s = report.strategies[0];

      expect(s.realIntervals).toBe(0);
      expect(s.unmatchedShadowIntervals).toBe(1);
      expect(s.shadowAnomalyMs).toBe(10_000);
      expect(s.overlapMs).toBe(0);
      expect(s.precision).toBeCloseTo(0);
    });

    test('real detects anomaly shadow missed — zero coverage', () => {
      const entries: ShadowLogEntry[] = [
        hb('2026-03-28T12:00:00Z', 'a1', null, null),
        hb('2026-03-28T12:00:05Z', 'a1', null, 'needs_input'),
        hb('2026-03-28T12:00:10Z', 'a1', null, 'needs_input'),
        hb('2026-03-28T12:00:15Z', 'a1', null, null),
      ];
      const report = generateReport(entries);
      const s = report.strategies[0];

      expect(s.realIntervals).toBe(1);
      expect(s.matchedIntervals).toBe(0);
      expect(s.coverage).toBeCloseTo(0);
    });
  });

  describe('transition latency', () => {
    test('computes detection delay from matched intervals', () => {
      const entries: ShadowLogEntry[] = [
        hb('2026-03-28T12:00:00Z', 'a1', null, null),
        // Real starts at T=5
        hb('2026-03-28T12:00:05Z', 'a1', null, 'needs_input'),
        // Shadow starts at T=10 (5s lag)
        hb('2026-03-28T12:00:10Z', 'a1', 'needs_input', 'needs_input'),
        // Both clear at T=20
        hb('2026-03-28T12:00:20Z', 'a1', null, null),
      ];
      const report = generateReport(entries);
      const s = report.strategies[0];

      expect(s.detectionDelays).toHaveLength(1);
      expect(s.detectionDelays[0]).toBe(5_000); // shadow was 5s late
    });

    test('negative detection delay means shadow detected earlier', () => {
      const entries: ShadowLogEntry[] = [
        hb('2026-03-28T12:00:00Z', 'a1', null, null),
        // Shadow starts at T=5
        hb('2026-03-28T12:00:05Z', 'a1', 'needs_input', null),
        // Real starts at T=10
        hb('2026-03-28T12:00:10Z', 'a1', 'needs_input', 'needs_input'),
        hb('2026-03-28T12:00:20Z', 'a1', null, null),
      ];
      const report = generateReport(entries);
      const s = report.strategies[0];

      expect(s.detectionDelays).toHaveLength(1);
      expect(s.detectionDelays[0]).toBe(-5_000); // shadow was 5s earlier
    });
  });

  describe('multiple agents', () => {
    test('tracks intervals independently per agent', () => {
      const entries: ShadowLogEntry[] = [
        hb('2026-03-28T12:00:00Z', 'a1', null, null),
        hb('2026-03-28T12:00:00Z', 'a2', null, null),
        // Only a1 has anomaly
        hb('2026-03-28T12:00:05Z', 'a1', 'needs_input', 'needs_input'),
        hb('2026-03-28T12:00:05Z', 'a2', null, null),
        hb('2026-03-28T12:00:10Z', 'a1', null, null),
        hb('2026-03-28T12:00:10Z', 'a2', null, null),
      ];
      const report = generateReport(entries);
      const s = report.strategies[0];

      expect(s.realIntervals).toBe(1);
      expect(s.matchedIntervals).toBe(1);
    });
  });

  describe('multiple strategies', () => {
    test('reports separately per strategy', () => {
      const paneHb = (ts: string, shadow: string | null, real: string | null): ShadowHeartbeat => ({
        ...hb(ts, 'a1', shadow, real),
        source: 'pane_semantics',
      });
      const pidHb = (ts: string, shadow: string | null, real: string | null): ShadowHeartbeat => ({
        ...hb(ts, 'a1', shadow, real),
        source: 'process_liveness',
      });

      const entries: ShadowLogEntry[] = [
        paneHb('2026-03-28T12:00:00Z', null, null),
        pidHb('2026-03-28T12:00:00Z', null, null),
        paneHb('2026-03-28T12:00:05Z', 'needs_input', 'needs_input'),
        pidHb('2026-03-28T12:00:05Z', null, 'needs_input'),
        paneHb('2026-03-28T12:00:10Z', null, null),
        pidHb('2026-03-28T12:00:10Z', null, null),
      ];
      const report = generateReport(entries);

      expect(report.strategies).toHaveLength(2);
      const pane = report.strategies.find((s) => s.source === 'pane_semantics')!;
      const pid = report.strategies.find((s) => s.source === 'process_liveness')!;

      expect(pane.matchedIntervals).toBe(1);
      expect(pid.matchedIntervals).toBe(0); // pid didn't detect the anomaly
    });
  });
});

describe('large input (regression: Math.min/max spread overflow)', () => {
  test('handles >100k entries without RangeError', () => {
    // Math.min(...arr) overflows the spread-args limit around 65-120k entries
    // depending on V8 build. Multi-day logs hit this immediately.
    const N = 150_000;
    const entries: ShadowLogEntry[] = new Array(N);
    const base = Date.parse('2026-03-28T12:00:00Z');
    for (let i = 0; i < N; i++) {
      entries[i] = {
        kind: 'heartbeat',
        timestamp: new Date(base + i * 1000).toISOString(),
        agentId: 'a1',
        source: 'pane_semantics',
        shadowState: null,
        realState: null,
      };
    }
    const report = generateReport(entries);
    expect(report.observationWindow).not.toBeNull();
    expect(report.observationWindow!.startMs).toBe(base);
    expect(report.observationWindow!.endMs).toBe(base + (N - 1) * 1000);
  });
});

describe('parseShadowLogFromFile / generateReportFromFile', () => {
  test('streams a JSONL file without loading it as one string', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shadow-report-'));
    try {
      const path = join(dir, 'log.jsonl');
      const lines: string[] = [];
      lines.push(JSON.stringify(hb('2026-03-28T12:00:00Z', 'a1', null, null)));
      lines.push(JSON.stringify(hb('2026-03-28T12:00:05Z', 'a1', 'needs_input', 'needs_input')));
      lines.push('this is not json');
      lines.push(JSON.stringify(hb('2026-03-28T12:00:10Z', 'a1', null, null)));
      await writeFile(path, lines.join('\n') + '\n', 'utf-8');

      const { entries, errors } = await parseShadowLogFromFile(path);
      expect(entries).toHaveLength(3);
      expect(errors).toBe(1);

      const report = await generateReportFromFile(path);
      expect(report.totalEntries).toBe(3);
      expect(report.parseErrors).toBe(1);
      const pane = report.strategies.find((s) => s.source === 'pane_semantics')!;
      expect(pane.realIntervals).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns empty report when file does not exist', async () => {
    const report = await generateReportFromFile('/tmp/definitely-not-a-real-shadow-log.jsonl');
    expect(report.totalEntries).toBe(0);
    expect(report.strategies).toHaveLength(0);
  });
});

describe('formatReport', () => {
  test('formats empty report', () => {
    const report: ShadowReport = {
      generatedAt: '2026-03-28T12:00:00Z',
      observationWindow: null,
      strategies: [],
      totalEntries: 0,
      parseErrors: 0,
    };
    const text = formatReport(report);
    expect(text).toContain('No data available');
  });

  test('formats report with data', () => {
    const entries: ShadowLogEntry[] = [
      hb('2026-03-28T12:00:00Z', 'a1', null, null),
      hb('2026-03-28T12:00:05Z', 'a1', 'needs_input', 'needs_input'),
      hb('2026-03-28T12:00:10Z', 'a1', null, null),
    ];
    const report = generateReport(entries);
    const text = formatReport(report);

    expect(text).toContain('Strategy: pane_semantics');
    expect(text).toContain('Coverage');
    expect(text).toContain('Precision');
    expect(text).toContain('Heartbeats: 3');
  });
});
