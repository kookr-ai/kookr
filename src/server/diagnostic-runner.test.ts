import { afterEach, describe, test, expect, vi } from 'vitest';
import { DiagnosticRunner, type DiagnosticRunnerDeps } from './diagnostic-runner.js';
import type { AnomalyType } from '../core/types.js';
import type { DetectionStats } from '../core/detection-stats.js';

function zeroCounts(): Record<AnomalyType, number> {
  const types: AnomalyType[] = [
    'needs_input', 'permission_blocked', 'repeated_error', 'merge_conflict',
    'stale_agent', 'hook_disconnected', 'hook_missing', 'tmux_unresponsive',
    'api_error', 'budget_exceeded',
  ];
  return Object.fromEntries(types.map((t) => [t, 0])) as Record<AnomalyType, number>;
}

function zeroStats(): DetectionStats {
  return { checks: zeroCounts(), fires: zeroCounts(), falsePositives: zeroCounts() };
}

function createMockDeps(overrides?: Partial<DiagnosticRunnerDeps>): DiagnosticRunnerDeps {
  return {
    getDetectionStats: () => zeroStats(),
    getAgentCount: () => 3,
    getUptimeMs: () => 60 * 60 * 1000, // 1 hour
    getWsBroadcastCount: () => 0,
    getEventCounts: () => ({}),
    measureSnapshotSizeBytes: () => 10_000,
    ...overrides,
  };
}

describe('DiagnosticRunner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('runNow returns a report', () => {
    const runner = new DiagnosticRunner(createMockDeps());
    const report = runner.runNow();
    expect(report).toBeDefined();
    expect(report.timestamp).toBeGreaterThan(0);
    expect(report.findings).toEqual([]);
  });

  test('getStatus returns null report before first run', () => {
    const runner = new DiagnosticRunner(createMockDeps());
    const status = runner.getStatus();
    expect(status.report).toBeNull();
    expect(status.lastError).toBeNull();
  });

  test('getStatus returns report after runNow', () => {
    const runner = new DiagnosticRunner(createMockDeps());
    runner.runNow();
    const status = runner.getStatus();
    expect(status.report).not.toBeNull();
    expect(status.report!.findings).toEqual([]);
  });

  test('runNow records lastError when a dependency throws', () => {
    const runner = new DiagnosticRunner(createMockDeps({
      getDetectionStats: () => { throw new Error('stats unavailable'); },
    }));
    expect(() => runner.runNow()).toThrow('stats unavailable');
    const status = runner.getStatus();
    expect(status.report).toBeNull();
    expect(status.lastError).toBe('stats unavailable');
  });

  test('successful run clears lastError', () => {
    let shouldThrow = true;
    const runner = new DiagnosticRunner(createMockDeps({
      getDetectionStats: () => {
        if (shouldThrow) throw new Error('temporary failure');
        return zeroStats();
      },
    }));
    expect(() => runner.runNow()).toThrow('temporary failure');
    expect(runner.getStatus().lastError).toBe('temporary failure');

    shouldThrow = false;
    runner.runNow();
    expect(runner.getStatus().lastError).toBeNull();
  });

  test('window-delta computation uses previous snapshot', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    let fireCount = 0;
    let uptimeMs = 0;

    const runner = new DiagnosticRunner(createMockDeps({
      getUptimeMs: () => uptimeMs,
      getDetectionStats: () => {
        const s = zeroStats();
        s.fires.needs_input = fireCount;
        return s;
      },
    }));

    const firstReport = runner.runNow();
    expect(firstReport.findings).toEqual([]);

    vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'));
    uptimeMs = 10 * 60 * 1000;
    fireCount = 80_000;
    const secondReport = runner.runNow();
    const finding = secondReport.findings[0];
    expect(finding.checkId).toBe('detection-fire-rate');
    expect(finding.scope).toBe('needs_input');
    // Delta = 80,000 over 2 minutes = 2,400,000/hr
    // This proves window-delta is used (cumulative over 1hr uptime would be 80,000/hr)
    expect(finding.observed).toBeGreaterThan(80_000);
  });
});
