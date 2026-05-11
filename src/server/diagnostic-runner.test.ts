import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
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
    onReport: vi.fn(),
    ...overrides,
  };
}

describe('DiagnosticRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

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

  test('runNow does NOT call onReport', () => {
    const onReport = vi.fn();
    const runner = new DiagnosticRunner(createMockDeps({ onReport }));
    runner.runNow();
    expect(onReport).not.toHaveBeenCalled();
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

  test('periodic timer calls onReport when findings exist', () => {
    const onReport = vi.fn();
    const stats = zeroStats();
    stats.fires.needs_input = 80_000;

    const runner = new DiagnosticRunner(createMockDeps({
      onReport,
      getDetectionStats: () => stats,
    }));
    runner.start(1000); // 1s interval for test

    // First tick
    vi.advanceTimersByTime(1000);
    expect(onReport).toHaveBeenCalledTimes(1);
    const report = onReport.mock.calls[0][0];
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings[0].checkId).toBe('detection-fire-rate');

    runner.dispose();
  });

  test('periodic timer does NOT call onReport when no findings', () => {
    const onReport = vi.fn();
    const runner = new DiagnosticRunner(createMockDeps({ onReport }));
    runner.start(1000);
    vi.advanceTimersByTime(1000);
    expect(onReport).not.toHaveBeenCalled();
    runner.dispose();
  });

  test('dispose stops the timer', () => {
    const onReport = vi.fn();
    const stats = zeroStats();
    stats.fires.needs_input = 80_000;

    const runner = new DiagnosticRunner(createMockDeps({
      onReport,
      getDetectionStats: () => stats,
    }));
    runner.start(1000);
    runner.dispose();
    vi.advanceTimersByTime(5000);
    expect(onReport).not.toHaveBeenCalled();
  });

  test('sets lastError when dep getter throws', () => {
    const runner = new DiagnosticRunner(createMockDeps({
      getDetectionStats: () => { throw new Error('stats unavailable'); },
    }));
    runner.start(1000);

    // Suppress console.error for this test
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.advanceTimersByTime(1000);
    consoleSpy.mockRestore();

    const status = runner.getStatus();
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
    runner.start(1000);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.advanceTimersByTime(1000);
    consoleSpy.mockRestore();
    expect(runner.getStatus().lastError).toBe('temporary failure');

    // Fix the dep and let next tick succeed
    shouldThrow = false;
    vi.advanceTimersByTime(1000);
    expect(runner.getStatus().lastError).toBeNull();
  });

  test('window-delta computation uses previous snapshot', () => {
    const onReport = vi.fn();
    let fireCount = 0;
    // Use 2-minute interval to exceed the 60s minimum in runDiagnostic
    const intervalMs = 2 * 60 * 1000;

    const runner = new DiagnosticRunner(createMockDeps({
      onReport,
      getDetectionStats: () => {
        const s = zeroStats();
        s.fires.needs_input = fireCount;
        return s;
      },
    }));
    runner.start(intervalMs);

    // First tick: fireCount=0, delta=0, no findings
    vi.advanceTimersByTime(intervalMs);
    expect(onReport).not.toHaveBeenCalled();

    // Set high fire count for the second tick
    fireCount = 80_000;
    vi.advanceTimersByTime(intervalMs);
    expect(onReport).toHaveBeenCalledTimes(1);
    const finding = onReport.mock.calls[0][0].findings[0];
    expect(finding.checkId).toBe('detection-fire-rate');
    expect(finding.scope).toBe('needs_input');
    // Delta = 80,000 over 2-minute interval = 2,400,000/hr
    // This proves window-delta is used (cumulative over 1hr uptime would be 80,000/hr)
    expect(finding.observed).toBeGreaterThan(80_000);

    runner.dispose();
  });

  test('start is idempotent', () => {
    const onReport = vi.fn();
    const stats = zeroStats();
    stats.fires.needs_input = 80_000;

    const runner = new DiagnosticRunner(createMockDeps({
      onReport,
      getDetectionStats: () => stats,
    }));
    runner.start(1000);
    runner.start(1000); // second call should be no-op
    vi.advanceTimersByTime(1000);
    expect(onReport).toHaveBeenCalledTimes(1); // not 2
    runner.dispose();
  });
});
