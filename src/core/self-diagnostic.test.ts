import { describe, test, expect } from 'vitest';
import { runDiagnostic, type DiagnosticInput, type PreviousSnapshot } from './self-diagnostic.js';
import type { AnomalyType } from './types.js';
import type { DetectionStats } from './detection-stats.js';
import { getHelperLlmDiagnosticsSnapshot } from './llm-factory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ANOMALY_TYPES: AnomalyType[] = [
  'needs_input', 'permission_blocked', 'repeated_error', 'merge_conflict',
  'stale_agent', 'hook_disconnected', 'hook_missing', 'tmux_unresponsive',
  'hook_parse_degraded', 'api_error', 'budget_exceeded',
];

function zeroCounts(): Record<AnomalyType, number> {
  return Object.fromEntries(ANOMALY_TYPES.map((t) => [t, 0])) as Record<AnomalyType, number>;
}

function zeroStats(): DetectionStats {
  return { checks: zeroCounts(), fires: zeroCounts(), falsePositives: zeroCounts() };
}

function makeInput(overrides: Partial<DiagnosticInput> = {}): DiagnosticInput {
  return {
    uptimeMs: 60 * 60 * 1000, // 1 hour
    agentCount: 3,
    detectionStats: zeroStats(),
    wsBroadcastCount: 0,
    eventCounts: {},
    lastSnapshotSizeBytes: 10_000,
    helperLlm: getHelperLlmDiagnosticsSnapshot(),
    ...overrides,
  };
}

function makePrevious(overrides: Partial<PreviousSnapshot> = {}): PreviousSnapshot {
  return {
    timestamp: Date.now() - 30 * 60 * 1000, // 30 min ago
    detectionStats: zeroStats(),
    wsBroadcastCount: 0,
    eventCounts: {},
    ...overrides,
  };
}

function expectSingleFinding(
  report: ReturnType<typeof runDiagnostic>,
  checkId: string,
) {
  const findings = report.findings.filter((f) => f.checkId === checkId);
  expect(findings).toHaveLength(1);
  return findings[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Self-Diagnostic', () => {
  test('returns empty findings for normal rates', () => {
    const input = makeInput({
      wsBroadcastCount: 2000,
      eventCounts: { 'agent-1': 100, 'agent-2': 150 },
    });
    const report = runDiagnostic(input);
    expect(report.findings).toEqual([]);
    expect(report.helperLlm.schemaVersion).toBe('helper-llm-diagnostics.v1');
    expect(report.helperLlm.totals.requestCount).toBe(0);
    expect(report.timestamp).toBeGreaterThan(0);
  });

  test('exposes active persistence failures with last error details', () => {
    const input = makeInput({
      persistenceHealth: {
        schemaVersion: 'persistence-health.v1',
        targets: {
          task_state: {
            target: 'task_state',
            totalAttempts: 3,
            totalFailures: 3,
            consecutiveFailures: 3,
            lastAttemptAt: '2026-06-12T10:00:00.000Z',
            lastSuccessAt: null,
            lastFailureAt: '2026-06-12T10:00:00.000Z',
            lastError: { message: 'no space left', code: 'ENOSPC', hard: true },
          },
          detection_stats: {
            target: 'detection_stats',
            totalAttempts: 0,
            totalFailures: 0,
            consecutiveFailures: 0,
            lastAttemptAt: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastError: null,
          },
        },
      },
    });

    const report = runDiagnostic(input);

    expect(report.persistenceHealth?.targets.task_state.lastError?.code).toBe('ENOSPC');
    expect(expectSingleFinding(report, 'persistence-health')).toMatchObject({
      scope: 'task_state',
      severity: 'critical',
      observed: 3,
    });
  });

  // --- Minimum uptime gate ---

  test('skips rate checks when uptime < 5 minutes', () => {
    const stats = zeroStats();
    stats.fires.needs_input = 999_999;
    const input = makeInput({
      uptimeMs: 4 * 60 * 1000, // 4 min
      detectionStats: stats,
      wsBroadcastCount: 999_999,
    });
    const report = runDiagnostic(input);
    // No rate-based findings despite absurd values
    expect(report.findings.filter((f) => f.checkId !== 'snapshot-size')).toEqual([]);
  });

  test('snapshot-size check still runs with low uptime', () => {
    const input = makeInput({
      uptimeMs: 60_000, // 1 min
      lastSnapshotSizeBytes: 3_000_000,
    });
    const report = runDiagnostic(input);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].checkId).toBe('snapshot-size');
  });

  // --- Zero agents guard ---

  test('skips per-agent event-pipeline checks when agentCount is 0', () => {
    const input = makeInput({
      agentCount: 0,
      eventCounts: { 'agent-1': 999_999 },
    });
    const previous = makePrevious({ eventCounts: { 'agent-1': 0 } });
    const report = runDiagnostic(input, previous);
    const agentFindings = report.findings.filter((f) => f.checkId === 'event-pipeline-rate');
    // event-pipeline-rate is guarded by agentCount === 0
    expect(agentFindings).toEqual([]);
  });

  test('system-wide checks still run when agentCount is 0', () => {
    const input = makeInput({
      agentCount: 0,
      wsBroadcastCount: 100_000,
      lastSnapshotSizeBytes: 3_000_000,
    });
    const previous = makePrevious({ wsBroadcastCount: 0 });
    const report = runDiagnostic(input, previous);
    const checkIds = report.findings.map((f) => f.checkId);
    expect(checkIds).toContain('ws-broadcast-rate');
    expect(checkIds).toContain('snapshot-size');
  });

  // --- detection-fire-rate ---

  test('detection-fire-rate: triggers per type with window-delta', () => {
    const currentStats = zeroStats();
    currentStats.fires.needs_input = 80_000;

    const previousStats = zeroStats();
    previousStats.fires.needs_input = 0;

    const input = makeInput({ detectionStats: currentStats });
    const previous = makePrevious({ detectionStats: previousStats });
    // 30 min interval, delta = 80,000 → rate = 160,000/hr → critical

    const report = runDiagnostic(input, previous);
    expect(expectSingleFinding(report, 'detection-fire-rate')).toMatchObject({
      checkId: 'detection-fire-rate',
      scope: 'needs_input',
      severity: 'critical',
      observed: 160_000,
      threshold: 10_000,
    });
  });

  test('detection-fire-rate: isolated per type', () => {
    const currentStats = zeroStats();
    currentStats.fires.needs_input = 80_000;
    currentStats.fires.permission_blocked = 10; // normal

    const input = makeInput({ detectionStats: currentStats });
    const previous = makePrevious({ detectionStats: zeroStats() });

    const report = runDiagnostic(input, previous);
    const fireRateFindings = report.findings.filter((f) => f.checkId === 'detection-fire-rate');
    expect(fireRateFindings).toHaveLength(1);
    expect(fireRateFindings[0].scope).toBe('needs_input');
  });

  test('detection-fire-rate: warning tier', () => {
    const currentStats = zeroStats();
    currentStats.fires.stale_agent = 1_500; // delta in 30 min = 3,000/hr → warning (>1K, <10K)

    const input = makeInput({ detectionStats: currentStats });
    const previous = makePrevious({ detectionStats: zeroStats() });

    const report = runDiagnostic(input, previous);
    expect(expectSingleFinding(report, 'detection-fire-rate')).toMatchObject({
      scope: 'stale_agent',
      severity: 'warning',
      observed: 3_000,
      threshold: 1_000,
    });
  });

  test('detection-fire-rate: below threshold → no finding', () => {
    const currentStats = zeroStats();
    currentStats.fires.needs_input = 100; // delta in 30 min = 200/hr → below 1K

    const input = makeInput({ detectionStats: currentStats });
    const previous = makePrevious({ detectionStats: zeroStats() });

    const report = runDiagnostic(input, previous);
    expect(report.findings.filter((f) => f.checkId === 'detection-fire-rate')).toEqual([]);
  });

  // --- event-pipeline-rate ---

  test('event-pipeline-rate: triggers per agent', () => {
    const input = makeInput({
      eventCounts: { 'agent-1': 50_000, 'agent-2': 100 },
    });
    const previous = makePrevious({
      eventCounts: { 'agent-1': 0, 'agent-2': 0 },
    });
    // agent-1: 50K delta in 30 min = 100K/hr → critical

    const report = runDiagnostic(input, previous);
    const findings = report.findings.filter((f) => f.checkId === 'event-pipeline-rate');
    expect(findings).toHaveLength(1);
    expect(findings[0].scope).toBe('agent-1');
    expect(findings[0].severity).toBe('critical');
  });

  test('event-pipeline-rate: below threshold → no finding', () => {
    const input = makeInput({
      eventCounts: { 'agent-1': 500 },
    });
    const previous = makePrevious({
      eventCounts: { 'agent-1': 0 },
    });
    // 500 delta in 30 min = 1000/hr → below 5K

    const report = runDiagnostic(input, previous);
    expect(report.findings.filter((f) => f.checkId === 'event-pipeline-rate')).toEqual([]);
  });

  // --- ws-broadcast-rate ---

  test('ws-broadcast-rate: triggers on pathological broadcast rate', () => {
    const input = makeInput({ wsBroadcastCount: 10_000 });
    const previous = makePrevious({ wsBroadcastCount: 0 });
    // 10K delta in 30 min = 20K/hr → warning

    const report = runDiagnostic(input, previous);
    expect(expectSingleFinding(report, 'ws-broadcast-rate')).toMatchObject({
      scope: 'websocket (system-wide)',
      severity: 'warning',
      observed: 20_000,
      threshold: 10_000,
    });
  });

  test('ws-broadcast-rate: critical tier', () => {
    const input = makeInput({ wsBroadcastCount: 100_000 });
    const previous = makePrevious({ wsBroadcastCount: 0 });
    // 100K in 30 min = 200K/hr → critical

    const report = runDiagnostic(input, previous);
    expect(expectSingleFinding(report, 'ws-broadcast-rate')).toMatchObject({
      scope: 'websocket (system-wide)',
      severity: 'critical',
      observed: 200_000,
      threshold: 100_000,
    });
  });

  test('ws-broadcast-rate: normal rate → no finding', () => {
    const input = makeInput({ wsBroadcastCount: 2000 });
    const previous = makePrevious({ wsBroadcastCount: 0 });
    // 2K in 30 min = 4K/hr → below 10K

    const report = runDiagnostic(input, previous);
    expect(report.findings.filter((f) => f.checkId === 'ws-broadcast-rate')).toEqual([]);
  });

  // --- snapshot-size ---

  test('snapshot-size: triggers on large payload (critical)', () => {
    const input = makeInput({ lastSnapshotSizeBytes: 3_000_000 }); // well above 2MB
    const report = runDiagnostic(input);
    expect(expectSingleFinding(report, 'snapshot-size')).toMatchObject({
      scope: 'snapshot (system-wide)',
      severity: 'critical',
      observed: 3_000_000,
      threshold: 2 * 1024 * 1024,
    });
  });

  test('snapshot-size: warning tier', () => {
    const input = makeInput({ lastSnapshotSizeBytes: 600_000 });
    const report = runDiagnostic(input);
    expect(expectSingleFinding(report, 'snapshot-size')).toMatchObject({
      scope: 'snapshot (system-wide)',
      severity: 'warning',
      observed: 600_000,
      threshold: 500 * 1024,
    });
  });

  test('snapshot-size: normal size → no finding', () => {
    const input = makeInput({ lastSnapshotSizeBytes: 10_000 });
    const report = runDiagnostic(input);
    expect(report.findings.filter((f) => f.checkId === 'snapshot-size')).toEqual([]);
  });

  // --- Window-delta vs cumulative ---

  test('window-delta rate computation uses interval, not cumulative uptime', () => {
    // Scenario: server up for 10 hours, but the pathology started recently.
    // Counter jumped from 0 to 10,000 in the last 30-minute window.
    const currentStats = zeroStats();
    currentStats.fires.needs_input = 10_000;

    const previousStats = zeroStats();
    previousStats.fires.needs_input = 0;

    const input = makeInput({
      uptimeMs: 10 * 60 * 60 * 1000, // 10 hours
      detectionStats: currentStats,
    });
    const previous = makePrevious({ detectionStats: previousStats });

    const report = runDiagnostic(input, previous);
    const finding = expectSingleFinding(report, 'detection-fire-rate');
    // Window-delta: 10,000 / 30 min = 20,000/hr → critical
    // Cumulative would be: 10,000 / 10 hr = 1,000/hr → barely at warning
    expect(finding).toMatchObject({
      scope: 'needs_input',
      observed: 20_000,
      severity: 'critical',
      threshold: 10_000,
    });
  });

  test('first run (no previous) uses cumulative rate', () => {
    const stats = zeroStats();
    stats.fires.needs_input = 80_000;

    const input = makeInput({
      uptimeMs: 60 * 60 * 1000, // 1 hour
      detectionStats: stats,
    });
    // No previous snapshot — uses cumulative
    const report = runDiagnostic(input, null);
    expect(expectSingleFinding(report, 'detection-fire-rate')).toMatchObject({
      scope: 'needs_input',
      observed: 80_000,
      severity: 'critical',
    }); // 80K / 1hr = 80K/hr
  });

  // --- Boundary values ---

  test('detection-fire-rate: exactly at threshold → no finding', () => {
    // 500 delta in 30 min = 1,000/hr. Threshold is >1,000 so exactly 1,000 should NOT fire.
    const currentStats = zeroStats();
    currentStats.fires.needs_input = 500;
    const input = makeInput({ detectionStats: currentStats });
    const previous = makePrevious({ detectionStats: zeroStats() });
    const report = runDiagnostic(input, previous);
    expect(report.findings.filter((f) => f.checkId === 'detection-fire-rate')).toEqual([]);
  });

  test('detection-fire-rate: just above threshold → finding', () => {
    // 501 delta in 30 min = 1,002/hr. Should trigger warning.
    const currentStats = zeroStats();
    currentStats.fires.needs_input = 501;
    const input = makeInput({ detectionStats: currentStats });
    const previous = makePrevious({ detectionStats: zeroStats() });
    const report = runDiagnostic(input, previous);
    expect(expectSingleFinding(report, 'detection-fire-rate')).toMatchObject({
      scope: 'needs_input',
      observed: 1_002,
      severity: 'warning',
    });
  });

  test('snapshot-size: exactly at threshold → no finding', () => {
    // 500 KB = 512,000 bytes. Threshold is >500*1024 = 512,000.
    const input = makeInput({ lastSnapshotSizeBytes: 500 * 1024 });
    const report = runDiagnostic(input);
    expect(report.findings.filter((f) => f.checkId === 'snapshot-size')).toEqual([]);
  });

  test('snapshot-size: just above threshold → finding', () => {
    const input = makeInput({ lastSnapshotSizeBytes: 500 * 1024 + 1 });
    const report = runDiagnostic(input);
    expect(expectSingleFinding(report, 'snapshot-size')).toMatchObject({
      observed: 500 * 1024 + 1,
      severity: 'warning',
    });
  });

  // --- Multiple findings ---

  test('produces multiple findings from different checks', () => {
    const stats = zeroStats();
    stats.fires.needs_input = 80_000;

    const input = makeInput({
      detectionStats: stats,
      wsBroadcastCount: 100_000,
      lastSnapshotSizeBytes: 3_000_000,
    });
    const previous = makePrevious({ detectionStats: zeroStats(), wsBroadcastCount: 0 });

    const report = runDiagnostic(input, previous);
    expect(report.findings.map((f) => [f.checkId, f.scope, f.severity])).toEqual([
      ['snapshot-size', 'snapshot (system-wide)', 'critical'],
      ['detection-fire-rate', 'needs_input', 'critical'],
      ['ws-broadcast-rate', 'websocket (system-wide)', 'critical'],
    ]);
  });
});
