import { describe, it, expect, vi, afterEach } from 'vitest';
// The CLI ships as a plain ESM .js file in bin/ (same pattern as bin/kookr.js)
// so it runs without a build step. Types come from bin/kookr-status.d.ts.
import {
  formatUptime,
  formatCost,
  formatRss,
  isActiveFinding,
  summarize,
  hasFindingsAtOrAbove,
  highestKnownSeverity,
  summarizePipelineStarvation,
  summarizeStaleProcesses,
  summarizeHostStaleDtachReaper,
  summarizePayloadDiet,
  summarizeHookReplayCheckpoints,
  summarizeFirstHookMiss,
  summarizeCapacity,
  formatUtilPct,
  summarizeProviderPausedOccupancy,
  summarizeNonCriticalTimerPause,
  summarizeSnapshotShed,
  summarizeHookIngestion,
  summarizeLaunchDependencies,
  summarizeSchedulesPausedByFailure,
  summarizeHungSuspectTtlReclaim,
  summarizeLessonYield,
  summarizeOssAttempts,
  summarizeMaintenancePrune,
  summarizeStartupRecovery,
  renderReport,
  parsePortEnv,
  parseStatusArgs,
  resolvePort,
  apiAuthHeaders,
  main,
} from '../../bin/kookr-status.js';

function parseSingleJsonLog(logs: string[]): any {
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0]);
}

describe('kookr-status apiAuthHeaders (issue #708)', () => {
  it('returns a Bearer header when KOOKR_API_TOKEN is set', () => {
    expect(apiAuthHeaders({ KOOKR_API_TOKEN: '  lan-secret  ' })).toEqual({
      Authorization: 'Bearer lan-secret',
    });
  });

  it('returns no header when KOOKR_API_TOKEN is unset or blank', () => {
    expect(apiAuthHeaders({})).toEqual({});
    expect(apiAuthHeaders({ KOOKR_API_TOKEN: '   ' })).toEqual({});
  });
});

describe('kookr-status formatUptime', () => {
  it('renders seconds-only durations', () => {
    expect(formatUptime(5_000)).toBe('5s');
  });

  it('renders minute + seconds durations', () => {
    expect(formatUptime(65_000)).toBe('1m 5s');
  });

  it('renders hour + minute durations', () => {
    expect(formatUptime(3_660_000)).toBe('1h 1m');
  });

  it('renders day + hour + minute durations', () => {
    expect(formatUptime(90_061_000)).toBe('1d 1h 1m');
  });

  it('returns unknown for negative or non-finite input', () => {
    expect(formatUptime(-1)).toBe('unknown');
    expect(formatUptime(Number.NaN)).toBe('unknown');
  });
});

describe('kookr-status formatCost', () => {
  it('shows $0.00 for zero cost', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('shows $0.00 for negative cost (defensive)', () => {
    expect(formatCost(-5)).toBe('$0.00');
  });

  it('uses 4 decimals for sub-cent costs', () => {
    expect(formatCost(0.0042)).toBe('$0.0042');
  });

  it('uses 4 decimals just below the cent boundary', () => {
    expect(formatCost(0.0099)).toBe('$0.0099');
  });

  it('switches to 2 decimals at the cent boundary', () => {
    expect(formatCost(0.01)).toBe('$0.01');
  });

  it('uses 2 decimals for regular costs', () => {
    expect(formatCost(1.23456)).toBe('$1.23');
  });

  it('handles non-finite cost safely', () => {
    expect(formatCost(Number.NaN)).toBe('$0.00');
    expect(formatCost(Number.POSITIVE_INFINITY)).toBe('$0.00');
  });
});

describe('kookr-status summarize', () => {
  it('counts task statuses, sums cost, and extracts findings', () => {
    const agents = [
      {
        agentId: 'a1',
        taskName: 'task 1',
        taskStatus: 'inProgress',
        tokenUsage: { costUsd: 0.5 },
        anomaly: null,
      },
      {
        agentId: 'a2',
        taskName: 'task 2',
        taskStatus: 'inProgress',
        tokenUsage: { costUsd: 0.25 },
        anomaly: {
          type: 'needs_input',
          severity: 'warning',
          explanation: 'Waiting on user',
        },
      },
      {
        agentId: 'a3',
        taskName: 'task 3',
        taskStatus: 'completed',
        tokenUsage: { costUsd: 1 },
        anomaly: null,
      },
    ];
    const { statusCounts, severityCounts, findings, totalCost } = summarize(agents);
    expect(statusCounts).toEqual({ inProgress: 2, completed: 1 });
    expect(severityCounts).toEqual({ critical: 0, warning: 1, info: 0 });
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('needs_input');
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].taskName).toBe('task 2');
    expect(totalCost).toBeCloseTo(1.75, 5);
  });

  it('handles empty agents list', () => {
    const { statusCounts, severityCounts, findings, totalCost } = summarize([]);
    expect(statusCounts).toEqual({});
    expect(severityCounts).toEqual({ critical: 0, warning: 0, info: 0 });
    expect(findings).toEqual([]);
    expect(totalCost).toBe(0);
  });

  it('ignores missing tokenUsage and counts unknown status', () => {
    const agents = [{ agentId: 'a1', anomaly: null }];
    const { statusCounts, totalCost } = summarize(agents);
    expect(statusCounts).toEqual({ unknown: 1 });
    expect(totalCost).toBe(0);
  });

  it('keeps unknown-severity findings but does not tally them', () => {
    const agents = [
      {
        agentId: 'a1',
        taskName: 'task 1',
        anomaly: { type: 'crash', severity: 'fatal', explanation: 'boom' },
      },
    ];
    const { severityCounts, findings } = summarize(agents);
    expect(severityCounts).toEqual({ critical: 0, warning: 0, info: 0 });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('fatal');
  });

  it('is immune to prototype-chain severity keys', () => {
    const agents = [
      {
        agentId: 'a1',
        taskName: 'task 1',
        anomaly: { type: 'weird', severity: 'toString', explanation: 'x' },
      },
    ];
    const { severityCounts } = summarize(agents);
    // Prototype lookup would have let this through in an earlier implementation.
    expect(severityCounts).toEqual({ critical: 0, warning: 0, info: 0 });
  });

  it('does not count snoozed or suppressed anomalies as active findings', () => {
    const agents = [
      {
        agentId: 'active',
        taskName: 'active task',
        taskStatus: 'inProgress',
        anomaly: { type: 'needs_input', severity: 'info', explanation: 'ready' },
      },
      {
        agentId: 'snoozed',
        taskName: 'snoozed task',
        taskStatus: 'inProgress',
        snoozedUntil: Date.now() + 60_000,
        anomaly: { type: 'needs_input', severity: 'info', explanation: 'hidden' },
      },
      {
        agentId: 'suppressed',
        taskName: 'suppressed task',
        taskStatus: 'inProgress',
        suppressed: true,
        anomaly: { type: 'stale_agent', severity: 'warning', explanation: 'hidden' },
      },
    ];

    const { severityCounts, findings } = summarize(agents);
    expect(findings.map((finding) => finding.agentId)).toEqual(['active']);
    expect(severityCounts).toEqual({ critical: 0, warning: 0, info: 1 });
  });

  it('does not count pending or terminal anomalies as active findings', () => {
    const agents = [
      {
        agentId: 'pending',
        taskStatus: 'pending',
        anomaly: { type: 'needs_input', severity: 'info', explanation: 'not launched' },
      },
      {
        agentId: 'completed',
        taskStatus: 'completed',
        anomaly: { type: 'needs_input', severity: 'info', explanation: 'stale' },
      },
      {
        agentId: 'cancelled',
        taskStatus: 'cancelled',
        anomaly: { type: 'needs_input', severity: 'info', explanation: 'stale' },
      },
      {
        agentId: 'terminated',
        taskStatus: 'terminated',
        anomaly: { type: 'needs_input', severity: 'info', explanation: 'stale' },
      },
    ];

    const { findings } = summarize(agents);
    expect(findings).toEqual([]);
  });
});

describe('kookr-status fail-on severity gate', () => {
  const summary = summarize([
    {
      agentId: 'critical',
      taskName: 'critical task',
      taskStatus: 'inProgress',
      anomaly: { type: 'permission_blocked', severity: 'critical', explanation: 'blocked' },
    },
    {
      agentId: 'warning',
      taskName: 'warning task',
      taskStatus: 'inProgress',
      anomaly: { type: 'stale_agent', severity: 'warning', explanation: 'idle' },
    },
  ]);

  it('parses --fail-on in split and equals forms', () => {
    expect(parseStatusArgs(['--fail-on', 'warning'])).toMatchObject({
      help: false,
      json: false,
      failOn: 'warning',
    });
    expect(parseStatusArgs(['--fail-on=critical', '--json'])).toMatchObject({
      json: true,
      failOn: 'critical',
    });
  });

  it('rejects invalid or missing --fail-on values', () => {
    expect(parseStatusArgs(['--fail-on', 'fatal']).error).toContain('Invalid --fail-on value');
    expect(parseStatusArgs(['--fail-on']).error).toContain('--fail-on requires');
  });

  it('matches findings at or above the requested severity', () => {
    expect(hasFindingsAtOrAbove(summary, 'critical')).toBe(true);
    expect(hasFindingsAtOrAbove(summary, 'warning')).toBe(true);
    expect(hasFindingsAtOrAbove(summary, 'info')).toBe(true);
    expect(hasFindingsAtOrAbove(summary, 'none')).toBe(false);
    expect(highestKnownSeverity(summary)).toBe('critical');
  });

  it('does not fail a stricter threshold than the active findings', () => {
    const warningOnly = summarize([
      {
        agentId: 'warning',
        taskName: 'warning task',
        taskStatus: 'inProgress',
        anomaly: { type: 'stale_agent', severity: 'warning', explanation: 'idle' },
      },
    ]);
    expect(hasFindingsAtOrAbove(warningOnly, 'critical')).toBe(false);
    expect(hasFindingsAtOrAbove(warningOnly, 'warning')).toBe(true);
    expect(highestKnownSeverity(warningOnly)).toBe('warning');
  });

  it('fails only the info threshold for info-only findings', () => {
    const infoOnly = summarize([
      {
        agentId: 'info',
        taskName: 'info task',
        taskStatus: 'inProgress',
        anomaly: { type: 'needs_input', severity: 'info', explanation: 'ready' },
      },
    ]);
    expect(hasFindingsAtOrAbove(infoOnly, 'critical')).toBe(false);
    expect(hasFindingsAtOrAbove(infoOnly, 'warning')).toBe(false);
    expect(hasFindingsAtOrAbove(infoOnly, 'info')).toBe(true);
    expect(highestKnownSeverity(infoOnly)).toBe('info');
  });
});

describe('kookr-status isActiveFinding', () => {
  it('matches dashboard semantics for snoozed findings', () => {
    expect(isActiveFinding({
      agentId: 'snoozed',
      taskStatus: 'inProgress',
      snoozedUntil: Date.now() + 60_000,
      anomaly: { type: 'needs_input', severity: 'info', explanation: 'hidden' },
    })).toBe(false);
  });
});

describe('kookr-status parsePortEnv', () => {
  it('returns unset for undefined and empty string', () => {
    expect(parsePortEnv(undefined)).toEqual({ kind: 'unset' });
    expect(parsePortEnv('')).toEqual({ kind: 'unset' });
  });

  it('parses a valid numeric port', () => {
    expect(parsePortEnv('4800')).toEqual({ kind: 'valid', port: 4800 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parsePortEnv(' 4800 ')).toEqual({ kind: 'valid', port: 4800 });
  });

  it('rejects non-numeric values', () => {
    expect(parsePortEnv('abc')).toEqual({ kind: 'invalid', raw: 'abc' });
  });

  it('rejects out-of-range values', () => {
    expect(parsePortEnv('0')).toEqual({ kind: 'invalid', raw: '0' });
    expect(parsePortEnv('70000')).toEqual({ kind: 'invalid', raw: '70000' });
  });

  it('rejects non-integer values', () => {
    expect(parsePortEnv('4800.5')).toEqual({ kind: 'invalid', raw: '4800.5' });
  });
});

describe('kookr-status renderReport', () => {
  const baseHealth = {
    status: 'ok',
    serverStartedAt: new Date(Date.now() - 65_000).toISOString(),
    build: { version: 'dev' },
  };

  it('reports "no active findings" when all agents are healthy', () => {
    const agents = [
      {
        agentId: 'a1',
        taskName: 'task 1',
        taskStatus: 'inProgress',
        tokenUsage: { costUsd: 0.1 },
        anomaly: null,
      },
    ];
    const out = renderReport({ port: 4800, health: baseHealth, agents });
    expect(out).toContain('Kookr on port 4800');
    expect(out).toContain('Agents:  1');
    expect(out).toContain('Status:  inProgress=1');
    expect(out).toContain('Cost:    $0.10');
    expect(out).toContain('No active findings.');
    expect(out).not.toContain('Findings (');
  });

  it('produces the expected line-by-line shape for a simple snapshot', () => {
    const fixedHealth = {
      status: 'ok',
      // 2m 5s ago
      serverStartedAt: new Date(Date.now() - 125_000).toISOString(),
      build: { version: 'dev' },
    };
    const out = renderReport({
      port: 4800,
      health: fixedHealth,
      agents: [
        { agentId: 'a1', taskName: 't1', taskStatus: 'inProgress', tokenUsage: { costUsd: 0 }, anomaly: null },
      ],
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('Kookr on port 4800');
    expect(lines[1]).toMatch(/^Uptime:  \dm \d+s$/);
    expect(lines[2]).toBe('Agents:  1');
    expect(lines[3]).toBe('Status:  inProgress=1');
    expect(lines[4]).toBe('Cost:    $0.00');
    expect(lines[5]).toBe('');
    expect(lines[6]).toBe('No active findings.');
    expect(lines).toHaveLength(7);
  });

  it('surfaces ci_blind_debt from /api/health (issue #1703)', () => {
    const health = {
      ...baseHealth,
      ci_blind_debt: {
        blindMergeCount: 3,
        queueDepth: 3,
        verifyFailedCount: 1,
        oldestAgeMs: 90_000,
      },
    };
    const out = renderReport({
      port: 4800,
      health,
      agents: [],
    });
    expect(out).toContain('CI-blind debt: blind=3  queue=3  verifyFailed=1  oldest=1m 30s');
  });

  it('surfaces SAFE MODE digest line from /api/health (issue #1710)', () => {
    const health = {
      ...baseHealth,
      safeMode: {
        engaged: true,
        since: '2026-08-01T12:00:00.000Z',
        digest: 'SAFE MODE since 2026-08-01T12:00:00.000Z',
      },
    };
    const out = renderReport({
      port: 4800,
      health,
      agents: [],
    });
    expect(out).toContain('SAFE MODE since 2026-08-01T12:00:00.000Z');
  });

  it('surfaces elevated pipelineStarvation repos from /api/health (issue #2183)', () => {
    const health = {
      ...baseHealth,
      pipelineStarvation: {
        schemaVersion: 'pipeline-starvation.v1',
        repos: {
          'kookr-ai/kookr': {
            repo: 'kookr-ai/kookr',
            consecutiveBlockedEmpty: 3,
            effectiveScoutCooldownMs: 3_600_000,
          },
          // Idle repo — must not appear.
          'jeanibarz/lucy': {
            repo: 'jeanibarz/lucy',
            consecutiveBlockedEmpty: 0,
            effectiveScoutCooldownMs: 0,
          },
        },
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain('Pipeline starvation: kookr-ai/kookr blockedEmpty=3  cooldown=1h 0m');
    expect(out).not.toContain('jeanibarz/lucy');
  });

  it('renders one line per elevated repo in sorted order (issue #2183)', () => {
    const health = {
      ...baseHealth,
      pipelineStarvation: {
        schemaVersion: 'pipeline-starvation.v1',
        repos: {
          'z/repo': { repo: 'z/repo', consecutiveBlockedEmpty: 1, effectiveScoutCooldownMs: 0 },
          'a/repo': { repo: 'a/repo', consecutiveBlockedEmpty: 2, effectiveScoutCooldownMs: 1_800_000 },
        },
      },
    };
    const lines = renderReport({ port: 4800, health, agents: [] }).split('\n');
    const starvationLines = lines.filter((l) => l.startsWith('Pipeline starvation:'));
    expect(starvationLines).toEqual([
      'Pipeline starvation: a/repo blockedEmpty=2  cooldown=30m 0s',
      'Pipeline starvation: z/repo blockedEmpty=1',
    ]);
  });

  it('omits the cooldown segment when effectiveScoutCooldownMs is zero (issue #2183)', () => {
    const health = {
      ...baseHealth,
      pipelineStarvation: {
        schemaVersion: 'pipeline-starvation.v1',
        repos: {
          'kookr-ai/kookr': {
            repo: 'kookr-ai/kookr',
            consecutiveBlockedEmpty: 1,
            effectiveScoutCooldownMs: 0,
          },
        },
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain('Pipeline starvation: kookr-ai/kookr blockedEmpty=1');
    expect(out).not.toContain('cooldown=');
  });

  it('is a no-op when pipelineStarvation is absent (issue #2183)', () => {
    const out = renderReport({ port: 4800, health: baseHealth, agents: [] });
    expect(out).not.toContain('Pipeline starvation:');
  });

  it('surfaces elevated staleProcesses.dtach with humanized RSS (issue #2209)', () => {
    const health = {
      ...baseHealth,
      staleProcesses: {
        dtach: { count: 27, rssBytes: 1_288_490_188 },
        relayServer: { count: 0, rssBytes: 0 },
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain('Stale processes: dtach=27 rss=1.2 GB');
    expect(out).not.toContain('relayServer=');
  });

  it('includes both elevated classes on one line (issue #2209)', () => {
    const health = {
      ...baseHealth,
      staleProcesses: {
        dtach: { count: 3, rssBytes: 10 * 1024 * 1024 },
        relayServer: { count: 2, rssBytes: 512 * 1024 },
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Stale processes: dtach=3 rss=10.0 MB  relayServer=2 rss=512.0 KB',
    );
  });

  it('is a no-op when staleProcesses counts are zero or absent (issue #2209)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('Stale processes:');
    const zeroed = {
      ...baseHealth,
      staleProcesses: {
        dtach: { count: 0, rssBytes: 0 },
        relayServer: { count: 0, rssBytes: 0 },
      },
    };
    expect(renderReport({ port: 4800, health: zeroed, agents: [] }))
      .not.toContain('Stale processes:');
  });

  it('surfaces hostStaleDtachReaper when under pressure (issue #2386)', () => {
    const health = {
      ...baseHealth,
      hostStaleDtachReaper: {
        enabled: true,
        dryRun: false,
        softBound: 20,
        maxReapsPerSweep: 5,
        lastSweepAt: '2026-08-12T00:00:00.000Z',
        lastDtachCount: 24,
        lastUnderPressure: true,
        lastHostStaleDtachReaped: 0,
        totalHostStaleDtachReaped: 1,
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Host-stale dtach reaper: underPressure=true  dtach=24  lastReaped=0  totalReaped=1',
    );
  });

  it('surfaces hostStaleDtachReaper when reaped totals are elevated without pressure (issue #2386)', () => {
    const health = {
      ...baseHealth,
      hostStaleDtachReaper: {
        lastDtachCount: 3,
        lastUnderPressure: false,
        lastHostStaleDtachReaped: 2,
        totalHostStaleDtachReaped: 5,
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Host-stale dtach reaper: underPressure=false  dtach=3  lastReaped=2  totalReaped=5',
    );
  });

  it('is a no-op for quiet hostStaleDtachReaper fleet (issue #2386)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('Host-stale dtach reaper:');
    const quiet = {
      ...baseHealth,
      hostStaleDtachReaper: {
        lastDtachCount: 4,
        lastUnderPressure: false,
        lastHostStaleDtachReaped: 0,
        totalHostStaleDtachReaped: 0,
      },
    };
    expect(renderReport({ port: 4800, health: quiet, agents: [] }))
      .not.toContain('Host-stale dtach reaper:');
  });

  it('always surfaces payloadDiet as a compact gauge when present (issue #2220)', () => {
    const health = {
      ...baseHealth,
      payloadDiet: {
        trackedTasks: 40,
        terminalTasks: 30,
        lastSnapshotBytes: 123_456,
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain('Payload diet: tracked=40  terminal=30  snapshot=120.6 KB');
  });

  it('renders snapshot=none when lastSnapshotBytes is null (issue #2220)', () => {
    const health = {
      ...baseHealth,
      payloadDiet: {
        trackedTasks: 12,
        terminalTasks: 3,
        lastSnapshotBytes: null,
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain('Payload diet: tracked=12  terminal=3  snapshot=none');
  });

  it('keeps the always-on zero gauge (unlike elevated-only staleProcesses) (issue #2220)', () => {
    const health = {
      ...baseHealth,
      payloadDiet: {
        trackedTasks: 0,
        terminalTasks: 0,
        lastSnapshotBytes: null,
      },
    };
    expect(renderReport({ port: 4800, health, agents: [] }))
      .toContain('Payload diet: tracked=0  terminal=0  snapshot=none');
  });

  it('is a no-op when payloadDiet is absent (issue #2220)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('Payload diet:');
  });

  it('surfaces elevated hookReplayCheckpoints with humanized file size (issue #2281)', () => {
    const health = {
      ...baseHealth,
      hookReplayCheckpoints: {
        sessionCount: 5364,
        fileBytes: 19_900_000,
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain('Hook replay checkpoints: sessions=5364  file=19.0 MB');
  });

  it('is a no-op when hookReplayCheckpoints is zero or absent (issue #2281)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('Hook replay checkpoints:');
    const zeroed = {
      ...baseHealth,
      hookReplayCheckpoints: { sessionCount: 0, fileBytes: 0 },
    };
    expect(renderReport({ port: 4800, health: zeroed, agents: [] }))
      .not.toContain('Hook replay checkpoints:');
  });

  it('is a no-op when hookReplayCheckpoints is null (disabled) (issue #2281)', () => {
    const health = { ...baseHealth, hookReplayCheckpoints: null };
    expect(renderReport({ port: 4800, health, agents: [] }))
      .not.toContain('Hook replay checkpoints:');
  });

  it('surfaces capacity when phantomActive > 0 (issue #2234)', () => {
    // Live residual shape: util=93.75 while effective=56.25 with phantomActive=6.
    const health = {
      ...baseHealth,
      capacity: {
        maxActiveTasks: 16,
        active: 15,
        free: 1,
        byClass: {
          working: 9,
          finishedAwaitingAck: 2,
          hungSuspect: 4,
          launching: 0,
        },
        effectiveWorking: 9,
        phantomActive: 6,
        utilizationPct: 93.75,
        effectiveUtilizationPct: 56.25,
        freeForGeneralSources: 5,
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Capacity: active=15/16 free=1 freeGeneral=5  util=93.75% effective=56.25%'
        + '  effectiveWorking=9 phantom=6'
        + '  working=9 finishedAwaitingAck=2 hungSuspect=4 launching=0',
    );
  });

  it('surfaces capacity on high nominal util even without phantoms (issue #2234)', () => {
    const health = {
      ...baseHealth,
      capacity: {
        maxActiveTasks: 16,
        active: 14,
        free: 2,
        byClass: {
          working: 13,
          finishedAwaitingAck: 0,
          hungSuspect: 0,
          launching: 1,
        },
        effectiveWorking: 14,
        phantomActive: 0,
        utilizationPct: 87.5,
        effectiveUtilizationPct: 87.5,
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Capacity: active=14/16 free=2  util=87.5% effective=87.5%'
        + '  effectiveWorking=14 phantom=0'
        + '  working=13 finishedAwaitingAck=0 hungSuspect=0 launching=1',
    );
    expect(out).not.toContain('freeGeneral=');
  });

  it('is a no-op when capacity is healthy and quiet (issue #2234)', () => {
    const health = {
      ...baseHealth,
      capacity: {
        maxActiveTasks: 16,
        active: 4,
        free: 12,
        byClass: {
          working: 4,
          finishedAwaitingAck: 0,
          hungSuspect: 0,
          launching: 0,
        },
        effectiveWorking: 4,
        phantomActive: 0,
        utilizationPct: 25,
        effectiveUtilizationPct: 25,
      },
    };
    expect(renderReport({ port: 4800, health, agents: [] }))
      .not.toContain('Capacity:');
  });

  it('is a no-op when capacity is absent (issue #2234)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('Capacity:');
  });

  it('surfaces firstHookMissTotal when elevated (issue #2235)', () => {
    const health = {
      ...baseHealth,
      firstHookMissTotal: 4,
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain('First-hook miss: total=4');
  });

  it('is a no-op when firstHookMissTotal is zero or absent (issue #2235)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('First-hook miss:');
    const zeroed = { ...baseHealth, firstHookMissTotal: 0 };
    expect(renderReport({ port: 4800, health: zeroed, agents: [] }))
      .not.toContain('First-hook miss:');
  });

  it('surfaces elevated providerPausedOccupancy with age and reclaim counters (issue #2236)', () => {
    const health = {
      ...baseHealth,
      providerPausedOccupancy: {
        count: 8,
        oldestPauseAgeMs: 3_600_000,
        reclaimAttempted: 2,
        reclaimedTotal: 1,
        // Extra health fields must not appear in the human line.
        taskIds: ['a', 'b'],
        hardTtlMs: 7_200_000,
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Provider-paused occupancy: count=8  oldest=1h 0m  reclaimAttempted=2  reclaimedTotal=1',
    );
  });

  it('renders oldest=unknown when pause start age is null (issue #2236)', () => {
    const health = {
      ...baseHealth,
      providerPausedOccupancy: {
        count: 3,
        oldestPauseAgeMs: null,
        reclaimAttempted: 0,
        reclaimedTotal: 0,
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Provider-paused occupancy: count=3  oldest=unknown  reclaimAttempted=0  reclaimedTotal=0',
    );
  });

  it('is a no-op when providerPausedOccupancy count is zero or absent (issue #2236)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('Provider-paused occupancy:');
    const zeroed = {
      ...baseHealth,
      providerPausedOccupancy: {
        count: 0,
        oldestPauseAgeMs: null,
        reclaimAttempted: 0,
        reclaimedTotal: 0,
      },
    };
    expect(renderReport({ port: 4800, health: zeroed, agents: [] }))
      .not.toContain('Provider-paused occupancy:');
  });

  it('surfaces elevated nonCriticalTimerPause with p95 and residual ticks (issue #2230)', () => {
    const health = {
      ...baseHealth,
      nonCriticalTimerPause: {
        schemaVersion: 'non-critical-timer-pause.v1',
        paused: true,
        thresholdMs: 1500,
        lastEventLoopDelayP95Ms: 2400.7,
        pausedTicksTotal: 16,
        // Extra health fields must not appear in the human line.
        unused: true,
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Non-critical timer pause: paused=true  p95=2400ms  threshold=1500ms  pausedTicks=16',
    );
  });

  it('surfaces residual pausedTicksTotal even when currently not paused (issue #2230)', () => {
    const health = {
      ...baseHealth,
      nonCriticalTimerPause: {
        paused: false,
        thresholdMs: 1500,
        lastEventLoopDelayP95Ms: 54.5,
        pausedTicksTotal: 19,
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Non-critical timer pause: paused=false  p95=54ms  threshold=1500ms  pausedTicks=19',
    );
  });

  it('is a no-op when nonCriticalTimerPause is healthy or absent (issue #2230)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('Non-critical timer pause:');
    const healthy = {
      ...baseHealth,
      nonCriticalTimerPause: {
        paused: false,
        thresholdMs: 1500,
        lastEventLoopDelayP95Ms: 54,
        pausedTicksTotal: 0,
      },
    };
    expect(renderReport({ port: 4800, health: healthy, agents: [] }))
      .not.toContain('Non-critical timer pause:');
  });

  it('surfaces elevated snapshotShed with p95 and threshold (issue #2299)', () => {
    const health = {
      ...baseHealth,
      snapshotShed: {
        schemaVersion: 'snapshot-shed.v1',
        thresholdMs: 1500,
        lastEventLoopDelayP95Ms: 400.7,
        shedTotal: 1600,
        // Extra health fields must not appear in the human line.
        unused: true,
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Snapshot shed: shedTotal=1600  p95=400ms  threshold=1500ms',
    );
  });

  it('renders p95=unknown when lastEventLoopDelayP95Ms is null (issue #2299)', () => {
    const health = {
      ...baseHealth,
      snapshotShed: {
        thresholdMs: 1500,
        lastEventLoopDelayP95Ms: null,
        shedTotal: 3,
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Snapshot shed: shedTotal=3  p95=unknown  threshold=1500ms',
    );
  });

  it('is a no-op when snapshotShed is zero or absent (issue #2299)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('Snapshot shed:');
    const zeroed = {
      ...baseHealth,
      snapshotShed: {
        thresholdMs: 1500,
        lastEventLoopDelayP95Ms: 54,
        shedTotal: 0,
      },
    };
    expect(renderReport({ port: 4800, health: zeroed, agents: [] }))
      .not.toContain('Snapshot shed:');
  });

  it('surfaces elevated hookIngestion lag when notableLagCount > 0 (issue #2319)', () => {
    const health = {
      ...baseHealth,
      hookIngestion: {
        sessionCount: 24,
        notableLagCount: 192,
        lagWarningThresholdMs: 2000,
        maxLagMs: 9000,
        p95LagMs: 8500,
        generatedAt: '2026-08-01T12:00:00.000Z',
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Hook ingestion lag: notable=192  sessions=24  max=9000ms  p95=8500ms  threshold=2000ms',
    );
  });

  it('is a no-op when hookIngestion notableLagCount is zero or absent (issue #2319)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('Hook ingestion lag:');
    const zeroed = {
      ...baseHealth,
      hookIngestion: {
        sessionCount: 3,
        notableLagCount: 0,
        lagWarningThresholdMs: 2000,
        maxLagMs: 100,
        p95LagMs: 80,
      },
    };
    expect(renderReport({ port: 4800, health: zeroed, agents: [] }))
      .not.toContain('Hook ingestion lag:');
  });

  it('surfaces elevated launchDependencies with per-dependency categories (issue #2363)', () => {
    const health = {
      ...baseHealth,
      launchDependencies: {
        schemaVersion: 'launch-dependency-diagnostics.v1',
        totalDegradedTasks: 8,
        totalFindings: 9,
        dependencies: [
          {
            dependency: 'kb',
            degradedTaskCount: 8,
            findingCount: 8,
            affectedTaskIds: ['a', 'b', 'c'],
            categories: ['provider_api'],
            lastOccurredAt: '2026-08-12T00:00:00.000Z',
          },
        ],
        categories: [
          {
            category: 'provider_api',
            degradedTaskCount: 8,
            findingCount: 8,
            affectedTaskIds: ['a', 'b', 'c'],
            dependencies: ['kb'],
            lastOccurredAt: '2026-08-12T00:00:00.000Z',
          },
        ],
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain('Launch dependencies: degraded=8  kb=8 (provider_api)');
    // Slim human line must not dump affected task ids.
    expect(out).not.toContain('affectedTaskIds');
    expect(out).not.toContain('a, b, c');
  });

  it('renders multi-dependency launchDependencies segments (issue #2363)', () => {
    const health = {
      ...baseHealth,
      launchDependencies: {
        totalDegradedTasks: 3,
        totalFindings: 4,
        dependencies: [
          {
            dependency: 'kb',
            degradedTaskCount: 2,
            categories: ['provider_api', 'unknown'],
          },
          {
            dependency: 'gh',
            degradedTaskCount: 1,
            categories: ['auth'],
          },
        ],
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Launch dependencies: degraded=3  kb=2 (provider_api, unknown)  gh=1 (auth)',
    );
  });

  it('is a no-op when launchDependencies is zero or absent (issue #2363)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('Launch dependencies:');
    const zeroed = {
      ...baseHealth,
      launchDependencies: {
        schemaVersion: 'launch-dependency-diagnostics.v1',
        totalDegradedTasks: 0,
        totalFindings: 0,
        dependencies: [],
        categories: [],
      },
    };
    expect(renderReport({ port: 4800, health: zeroed, agents: [] }))
      .not.toContain('Launch dependencies:');
  });

  it('surfaces a WARN with count and sampled names when schedules are fail-closed paused (issue #2424)', () => {
    const health = {
      ...baseHealth,
      schedules: {
        schedulesPausedByFailure: [
          { id: 's1', name: 'orchestrator', consecutiveFailures: 30 },
          { id: 's2', name: 'deploy-conv', consecutiveFailures: 55 },
          { id: 's3', name: 'sentinel', consecutiveFailures: 29 },
          { id: 's4', name: 'idea-scout', consecutiveFailures: 12 },
        ],
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'WARN: 4 schedules paused after consecutive failures: orchestrator, deploy-conv, sentinel (+1 more)',
    );
    expect(out).not.toContain('idea-scout');
  });

  it('uses singular copy and lists every name when the pause set is small (issue #2424)', () => {
    const health = {
      ...baseHealth,
      schedules: {
        schedulesPausedByFailure: [
          { id: 's1', name: 'orchestrator', consecutiveFailures: 3 },
        ],
      },
    };
    expect(renderReport({ port: 4800, health, agents: [] })).toContain(
      'WARN: 1 schedule paused after consecutive failures: orchestrator',
    );
  });

  it('is a no-op when schedulesPausedByFailure is absent or empty (issue #2424)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('paused after consecutive failures');
    const empty = {
      ...baseHealth,
      schedules: { schedulesPausedByFailure: [] },
    };
    expect(renderReport({ port: 4800, health: empty, agents: [] }))
      .not.toContain('paused after consecutive failures');
    expect(renderReport({ port: 4800, health: empty, agents: [] }))
      .not.toContain('WARN:');
  });

  it('always surfaces lessonYield as a compact gauge when present (issue #2305)', () => {
    const health = {
      ...baseHealth,
      lessonYield: {
        schemaVersion: 'lesson-yield.v2',
        yieldRate: 0.75,
        decided: 3,
        completedInWindow: 4,
        buckets: {
          wroteLesson: 2,
          explicitSkip: 1,
          searchOnly: 0,
          noKbActivity: 1,
        },
        // Extra health fields must not appear in the human line.
        byCompletionPath: { agent: { wroteLesson: 2 } },
        contractRate: 0.75,
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Lesson yield: rate=0.75  decided=3/4  wrote=2  skip=1  searchOnly=0  noKb=1',
    );
    expect(out).not.toContain('byCompletionPath');
    expect(out).not.toContain('contractRate');
  });

  it('keeps the always-on zero lessonYield gauge (issue #2305)', () => {
    const health = {
      ...baseHealth,
      lessonYield: {
        yieldRate: 0,
        decided: 0,
        completedInWindow: 0,
        buckets: {
          wroteLesson: 0,
          explicitSkip: 0,
          searchOnly: 0,
          noKbActivity: 0,
        },
      },
    };
    expect(renderReport({ port: 4800, health, agents: [] })).toContain(
      'Lesson yield: rate=0  decided=0/0  wrote=0  skip=0  searchOnly=0  noKb=0',
    );
  });

  it('is a no-op when lessonYield is absent (issue #2305)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('Lesson yield:');
  });

  it('always surfaces ossAttempts as a compact gauge when present (issue #2332)', () => {
    const health = {
      ...baseHealth,
      ossAttempts: {
        openCount: 3,
        totalCount: 12,
        lastRefreshAt: '2026-08-12T00:00:00.000Z',
        issueCheckErrorCount: 2,
      },
    };
    expect(renderReport({ port: 4800, health, agents: [] })).toContain(
      'OSS attempts: open=3  total=12  lastRefresh=2026-08-12T00:00:00.000Z  issueCheckErrors=2',
    );
  });

  it('renders lastRefresh=never and keeps the zero error gauge (issue #2332)', () => {
    const health = {
      ...baseHealth,
      ossAttempts: {
        openCount: 0,
        totalCount: 0,
        lastRefreshAt: null,
        issueCheckErrorCount: 0,
      },
    };
    expect(renderReport({ port: 4800, health, agents: [] })).toContain(
      'OSS attempts: open=0  total=0  lastRefresh=never  issueCheckErrors=0',
    );
  });

  it('is a no-op when ossAttempts is absent (issue #2332)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('OSS attempts:');
  });

  it('always surfaces maintenancePrune as a compact gauge when present (issue #2345)', () => {
    const health = {
      ...baseHealth,
      maintenancePrune: {
        enabled: true,
        intervalHours: 24,
        lastRunAt: '2026-08-12T00:00:00.000Z',
        lastReclaimedBytes: 4096,
        lastRemovedCount: 3,
        lastError: null,
      },
    };
    expect(renderReport({ port: 4800, health, agents: [] })).toContain(
      'Maintenance prune: enabled=true  intervalHours=24  lastRun=2026-08-12T00:00:00.000Z  reclaimed=4096  removed=3  lastError=none',
    );
  });

  it('surfaces enabled=false and never-run nulls for disabled prune (issue #2345)', () => {
    const health = {
      ...baseHealth,
      maintenancePrune: {
        enabled: false,
        intervalHours: 0,
        lastRunAt: null,
        lastReclaimedBytes: null,
        lastRemovedCount: null,
        lastError: null,
      },
    };
    expect(renderReport({ port: 4800, health, agents: [] })).toContain(
      'Maintenance prune: enabled=false  intervalHours=0  lastRun=never  reclaimed=n/a  removed=n/a  lastError=none',
    );
  });

  it('is a no-op when maintenancePrune is absent (issue #2345)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('Maintenance prune:');
  });

  it('always surfaces startupRecovery as a compact gauge when present (issue #2351)', () => {
    const health = {
      ...baseHealth,
      startupRecovery: {
        relaunched: 2,
        skipped: 3,
        failed: 1,
        crashLoopSkips: 2,
        generatedAt: '2026-08-12T00:00:00.000Z',
      },
    };
    expect(renderReport({ port: 4800, health, agents: [] })).toContain(
      'Startup recovery: relaunched=2  skipped=3  failed=1  crashLoop=2',
    );
  });

  it('is a no-op when startupRecovery is absent (issue #2351)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('Startup recovery:');
  });

  it('surfaces hungSuspectTtlReclaim skip breakdown when reclaimedTotal=0 and skips elevated (issue #2229)', () => {
    const health = {
      ...baseHealth,
      capacity: {
        maxActiveTasks: 16,
        active: 10,
        free: 6,
        byClass: {
          working: 6,
          finishedAwaitingAck: 0,
          hungSuspect: 4,
          launching: 0,
        },
        effectiveWorking: 6,
        phantomActive: 4,
        utilizationPct: 62.5,
        effectiveUtilizationPct: 37.5,
      },
      hungSuspectTtlReclaim: {
        reclaimedTotal: 0,
        reclaimAttempted: 0,
        reclaimSucceeded: 0,
        skippedNoLiveness: 0,
        skippedOpenPrFailsafe: 12,
        skippedOpenPrConfirmed: 8,
        skippedOpenPrUnknown: 4,
        skippedUnderTtl: 3,
        skippedExemptAnomaly: 0,
        skippedProviderPaused: 5,
        lastCandidatesConsidered: 4,
        lastOutcomes: [
          { taskId: 'a', outcome: 'skipped_open_pr_failsafe' },
          { taskId: 'b', outcome: 'skipped_open_pr_failsafe' },
          { taskId: 'c', outcome: 'skipped_under_ttl' },
        ],
        lastAttemptedTaskIds: [],
      },
    };
    const out = renderReport({ port: 4800, health, agents: [] });
    expect(out).toContain(
      'Hung-suspect reclaim: reclaimedTotal=0 hungSuspect=4  reclaimAttempted=0  candidates=4'
        + '  skips openPr=12 openPrConfirmed=8 openPrUnknown=4 underTtl=3 providerPaused=5'
        + ' noLiveness=0 exemptAnomaly=0'
        + '  residual=skipped_open_pr_failsafe=2,skipped_under_ttl=1',
    );
  });

  it('is a no-op when hungSuspectTtlReclaim is absent, reclaiming, or all gauges zero (issue #2229)', () => {
    expect(renderReport({ port: 4800, health: baseHealth, agents: [] }))
      .not.toContain('Hung-suspect reclaim:');
    const progressing = {
      ...baseHealth,
      hungSuspectTtlReclaim: {
        reclaimedTotal: 2,
        reclaimAttempted: 2,
        skippedOpenPrFailsafe: 100,
        lastCandidatesConsidered: 1,
      },
    };
    expect(renderReport({ port: 4800, health: progressing, agents: [] }))
      .not.toContain('Hung-suspect reclaim:');
    const zeroed = {
      ...baseHealth,
      hungSuspectTtlReclaim: {
        reclaimedTotal: 0,
        reclaimAttempted: 0,
        skippedNoLiveness: 0,
        skippedOpenPrFailsafe: 0,
        skippedOpenPrConfirmed: 0,
        skippedOpenPrUnknown: 0,
        skippedUnderTtl: 0,
        skippedExemptAnomaly: 0,
        skippedProviderPaused: 0,
        lastCandidatesConsidered: 0,
        lastOutcomes: [],
      },
    };
    expect(renderReport({ port: 4800, health: zeroed, agents: [] }))
      .not.toContain('Hung-suspect reclaim:');
  });

  it('lists critical findings with padded severity label', () => {
    const agents = [
      {
        agentId: 'a1',
        taskName: 'task 1',
        taskStatus: 'inProgress',
        tokenUsage: { costUsd: 0 },
        anomaly: {
          type: 'permission_blocked',
          severity: 'critical',
          explanation: 'Blocked on sudo',
        },
      },
    ];
    const out = renderReport({ port: 4801, health: baseHealth, agents });
    expect(out).toContain('Findings (1: 1 critical)');
    expect(out).toContain('[CRITICAL]');
    expect(out).toContain('permission_blocked: Blocked on sudo');
  });

  it('pads shorter severity labels to column width', () => {
    const agents = [
      {
        agentId: 'a1',
        taskName: 't',
        taskStatus: 'inProgress',
        tokenUsage: { costUsd: 0 },
        anomaly: { type: 'stale_agent', severity: 'info', explanation: 'idle' },
      },
    ];
    const out = renderReport({ port: 4800, health: baseHealth, agents });
    // INFO (4 chars) padded to 8 → "INFO    "
    expect(out).toContain('[INFO    ]');
  });

  it('omits build version when it is the "dev" placeholder', () => {
    const out = renderReport({ port: 4800, health: baseHealth, agents: [] });
    expect(out.split('\n')[0]).toBe('Kookr on port 4800');
  });

  it('includes build version when present', () => {
    const out = renderReport({
      port: 4800,
      health: { ...baseHealth, build: { version: '1.2.3' } },
      agents: [],
    });
    expect(out.split('\n')[0]).toBe('Kookr on port 4800 (1.2.3)');
  });

  it('falls back to "unknown" uptime when serverStartedAt is missing', () => {
    const out = renderReport({
      port: 4800,
      health: { status: 'ok' },
      agents: [],
    });
    expect(out).toContain('Uptime:  unknown');
  });

  it('falls back to "unknown" uptime when serverStartedAt is not parseable', () => {
    const out = renderReport({
      port: 4800,
      health: { status: 'ok', serverStartedAt: 'not-a-date' },
      agents: [],
    });
    expect(out).toContain('Uptime:  unknown');
  });
});

describe('kookr-status summarizePipelineStarvation (issue #2183)', () => {
  it('returns null when pipelineStarvation is absent', () => {
    expect(summarizePipelineStarvation({ status: 'ok' })).toBeNull();
  });

  it('returns null when the repos map is empty', () => {
    expect(
      summarizePipelineStarvation({
        pipelineStarvation: { schemaVersion: 'pipeline-starvation.v1', repos: {} },
      }),
    ).toBeNull();
  });

  it('returns null when every repo is at steady state (consecutiveBlockedEmpty <= 0)', () => {
    expect(
      summarizePipelineStarvation({
        pipelineStarvation: {
          repos: {
            'kookr-ai/kookr': { repo: 'kookr-ai/kookr', consecutiveBlockedEmpty: 0 },
          },
        },
      }),
    ).toBeNull();
  });

  it('keeps only elevated repos and sorts them deterministically', () => {
    const summary = summarizePipelineStarvation({
      pipelineStarvation: {
        repos: {
          'z/repo': { repo: 'z/repo', consecutiveBlockedEmpty: 1, effectiveScoutCooldownMs: 0 },
          'a/repo': { repo: 'a/repo', consecutiveBlockedEmpty: 4, effectiveScoutCooldownMs: 1_800_000 },
          'idle/repo': { repo: 'idle/repo', consecutiveBlockedEmpty: 0 },
        },
      },
    });
    expect(summary).toEqual({
      elevated: 2,
      repos: [
        { repo: 'a/repo', consecutiveBlockedEmpty: 4, effectiveScoutCooldownMs: 1_800_000 },
        { repo: 'z/repo', consecutiveBlockedEmpty: 1, effectiveScoutCooldownMs: 0 },
      ],
    });
  });

  it('falls back to the map key when a row has no repo field and floors fractional cooldowns', () => {
    const summary = summarizePipelineStarvation({
      pipelineStarvation: {
        repos: {
          'kookr-ai/kookr': { consecutiveBlockedEmpty: 2, effectiveScoutCooldownMs: 1234.9 },
        },
      },
    });
    expect(summary).toEqual({
      elevated: 1,
      repos: [{ repo: 'kookr-ai/kookr', consecutiveBlockedEmpty: 2, effectiveScoutCooldownMs: 1234 }],
    });
  });
});

describe('kookr-status formatRss (issue #2209)', () => {
  it('formats binary units across scales', () => {
    expect(formatRss(0)).toBe('0 B');
    expect(formatRss(500)).toBe('500 B');
    expect(formatRss(1536)).toBe('1.5 KB');
    expect(formatRss(10 * 1024 * 1024)).toBe('10.0 MB');
    expect(formatRss(1_288_490_188)).toBe('1.2 GB');
  });

  it('defends against non-finite / negative input', () => {
    expect(formatRss(Number.NaN)).toBe('0 B');
    expect(formatRss(-1)).toBe('0 B');
  });
});

describe('kookr-status summarizeStaleProcesses (issue #2209)', () => {
  it('returns null when staleProcesses is absent', () => {
    expect(summarizeStaleProcesses({ status: 'ok' })).toBeNull();
  });

  it('returns null when all counts are zero', () => {
    expect(
      summarizeStaleProcesses({
        staleProcesses: {
          dtach: { count: 0, rssBytes: 0 },
          relayServer: { count: 0, rssBytes: 0 },
        },
      }),
    ).toBeNull();
  });

  it('keeps only elevated classes and floors fractional values', () => {
    expect(
      summarizeStaleProcesses({
        staleProcesses: {
          dtach: { count: 27.9, rssBytes: 1_288_490_188.7 },
          relayServer: { count: 0, rssBytes: 999 },
        },
      }),
    ).toEqual({
      dtach: { count: 27, rssBytes: 1_288_490_188 },
    });
  });

  it('includes relayServer when elevated without inventing a dtach row', () => {
    expect(
      summarizeStaleProcesses({
        staleProcesses: {
          relayServer: { count: 5, rssBytes: 1024 },
        },
      }),
    ).toEqual({
      relayServer: { count: 5, rssBytes: 1024 },
    });
  });
});

describe('kookr-status summarizeHostStaleDtachReaper (issue #2386)', () => {
  it('returns null when hostStaleDtachReaper is absent', () => {
    expect(summarizeHostStaleDtachReaper({ status: 'ok' })).toBeNull();
  });

  it('returns null for a quiet fleet (no pressure, zero reaped)', () => {
    expect(
      summarizeHostStaleDtachReaper({
        hostStaleDtachReaper: {
          lastDtachCount: 4,
          lastUnderPressure: false,
          lastHostStaleDtachReaped: 0,
          totalHostStaleDtachReaped: 0,
        },
      }),
    ).toBeNull();
  });

  it('returns slim projection when lastUnderPressure is true', () => {
    expect(
      summarizeHostStaleDtachReaper({
        hostStaleDtachReaper: {
          enabled: true,
          dryRun: false,
          softBound: 20,
          lastDtachCount: 24.7,
          lastUnderPressure: true,
          lastHostStaleDtachReaped: 0,
          totalHostStaleDtachReaped: 1.9,
          // Extra health fields must not leak into the slim summary.
          skippedLiveAttached: 9,
          lastReapedAlways: 1,
        },
      }),
    ).toEqual({
      lastUnderPressure: true,
      lastDtachCount: 24,
      lastHostStaleDtachReaped: 0,
      totalHostStaleDtachReaped: 1,
    });
  });

  it('returns slim projection when reaped totals are elevated without pressure', () => {
    expect(
      summarizeHostStaleDtachReaper({
        hostStaleDtachReaper: {
          lastDtachCount: null,
          lastUnderPressure: false,
          lastHostStaleDtachReaped: 3,
          totalHostStaleDtachReaped: 0,
        },
      }),
    ).toEqual({
      lastUnderPressure: false,
      lastDtachCount: null,
      lastHostStaleDtachReaped: 3,
      totalHostStaleDtachReaped: 0,
    });
  });
});

describe('kookr-status summarizePayloadDiet (issue #2220)', () => {
  it('returns null when payloadDiet is absent', () => {
    expect(summarizePayloadDiet({ status: 'ok' })).toBeNull();
  });

  it('returns null when required counters are non-numeric', () => {
    expect(
      summarizePayloadDiet({
        payloadDiet: { trackedTasks: 'x' as unknown as number, terminalTasks: 1 },
      }),
    ).toBeNull();
  });

  it('always returns the slim gauge including zero counters', () => {
    expect(
      summarizePayloadDiet({
        payloadDiet: {
          trackedTasks: 0,
          terminalTasks: 0,
          lastSnapshotBytes: null,
        },
      }),
    ).toEqual({
      trackedTasks: 0,
      terminalTasks: 0,
      lastSnapshotBytes: null,
    });
  });

  it('floors fractional counters and snapshot bytes', () => {
    expect(
      summarizePayloadDiet({
        payloadDiet: {
          trackedTasks: 40.9,
          terminalTasks: 30.1,
          lastSnapshotBytes: 123_456.7,
        },
      }),
    ).toEqual({
      trackedTasks: 40,
      terminalTasks: 30,
      lastSnapshotBytes: 123_456,
    });
  });
});

describe('kookr-status summarizeHookReplayCheckpoints (issue #2281)', () => {
  it('returns null when hookReplayCheckpoints is absent', () => {
    expect(summarizeHookReplayCheckpoints({ status: 'ok' })).toBeNull();
  });

  it('returns null when hookReplayCheckpoints is null (disabled)', () => {
    expect(summarizeHookReplayCheckpoints({
      status: 'ok',
      hookReplayCheckpoints: null,
    })).toBeNull();
  });

  it('returns null when counters are non-numeric', () => {
    expect(
      summarizeHookReplayCheckpoints({
        hookReplayCheckpoints: {
          sessionCount: 'x' as unknown as number,
          fileBytes: 1,
        },
      }),
    ).toBeNull();
  });

  it('returns the slim gauge including zero counters (for --json)', () => {
    expect(
      summarizeHookReplayCheckpoints({
        hookReplayCheckpoints: {
          sessionCount: 0,
          fileBytes: 0,
        },
      }),
    ).toEqual({
      sessionCount: 0,
      fileBytes: 0,
    });
  });

  it('floors fractional counters', () => {
    expect(
      summarizeHookReplayCheckpoints({
        hookReplayCheckpoints: {
          sessionCount: 12.9,
          fileBytes: 4096.7,
        },
      }),
    ).toEqual({
      sessionCount: 12,
      fileBytes: 4096,
    });
  });
});

describe('kookr-status summarizeProviderPausedOccupancy (issue #2236)', () => {
  it('returns null when providerPausedOccupancy is absent', () => {
    expect(summarizeProviderPausedOccupancy({ status: 'ok' })).toBeNull();
  });

  it('returns null when count is zero or non-positive', () => {
    expect(
      summarizeProviderPausedOccupancy({
        providerPausedOccupancy: {
          count: 0,
          oldestPauseAgeMs: null,
          reclaimAttempted: 0,
          reclaimedTotal: 0,
        },
      }),
    ).toBeNull();
    expect(
      summarizeProviderPausedOccupancy({
        providerPausedOccupancy: { count: -1 },
      }),
    ).toBeNull();
  });

  it('returns a slim elevated summary and floors fractional values', () => {
    expect(
      summarizeProviderPausedOccupancy({
        providerPausedOccupancy: {
          count: 8.9,
          oldestPauseAgeMs: 3_600_000.7,
          reclaimAttempted: 2.2,
          reclaimedTotal: 1.8,
          taskIds: ['x'],
          hardTtlMs: 7_200_000,
        },
      }),
    ).toEqual({
      count: 8,
      oldestPauseAgeMs: 3_600_000,
      reclaimAttempted: 2,
      reclaimedTotal: 1,
      softTtlMs: null,
      effectiveTtlMs: null,
      capacityEarlyReclaim: false,
    });
  });

  it('defaults missing reclaim counters to 0 and preserves null oldest age', () => {
    expect(
      summarizeProviderPausedOccupancy({
        providerPausedOccupancy: { count: 3, oldestPauseAgeMs: null },
      }),
    ).toEqual({
      count: 3,
      oldestPauseAgeMs: null,
      reclaimAttempted: 0,
      reclaimedTotal: 0,
      softTtlMs: null,
      effectiveTtlMs: null,
      capacityEarlyReclaim: false,
    });
  });

  it('issue #2225: surfaces soft TTL capacity-early reclaim policy when present', () => {
    expect(
      summarizeProviderPausedOccupancy({
        providerPausedOccupancy: {
          count: 5,
          oldestPauseAgeMs: 2_400_000,
          reclaimAttempted: 1,
          reclaimedTotal: 1,
          softTtlMs: 40 * 60_000,
          effectiveTtlMs: 40 * 60_000,
          capacityEarlyReclaim: true,
        },
      }),
    ).toEqual({
      count: 5,
      oldestPauseAgeMs: 2_400_000,
      reclaimAttempted: 1,
      reclaimedTotal: 1,
      softTtlMs: 40 * 60_000,
      effectiveTtlMs: 40 * 60_000,
      capacityEarlyReclaim: true,
    });
  });
});

describe('kookr-status summarizeNonCriticalTimerPause (issue #2230)', () => {
  it('returns null when nonCriticalTimerPause is absent', () => {
    expect(summarizeNonCriticalTimerPause({ status: 'ok' })).toBeNull();
  });

  it('returns null when healthy (not paused, zero ticks, p95 at or below threshold)', () => {
    expect(
      summarizeNonCriticalTimerPause({
        nonCriticalTimerPause: {
          paused: false,
          thresholdMs: 1500,
          lastEventLoopDelayP95Ms: 54,
          pausedTicksTotal: 0,
        },
      }),
    ).toBeNull();
    expect(
      summarizeNonCriticalTimerPause({
        nonCriticalTimerPause: {
          paused: false,
          thresholdMs: 1500,
          lastEventLoopDelayP95Ms: 1500,
          pausedTicksTotal: 0,
        },
      }),
    ).toBeNull();
  });

  it('returns a slim summary when paused, residual ticks, or p95 elevated', () => {
    expect(
      summarizeNonCriticalTimerPause({
        nonCriticalTimerPause: {
          paused: true,
          thresholdMs: 1500.9,
          lastEventLoopDelayP95Ms: 2400.7,
          pausedTicksTotal: 16.2,
          schemaVersion: 'non-critical-timer-pause.v1',
        },
      }),
    ).toEqual({
      paused: true,
      thresholdMs: 1500,
      lastEventLoopDelayP95Ms: 2400,
      pausedTicksTotal: 16,
    });
    expect(
      summarizeNonCriticalTimerPause({
        nonCriticalTimerPause: {
          paused: false,
          thresholdMs: 1500,
          lastEventLoopDelayP95Ms: 54,
          pausedTicksTotal: 3,
        },
      }),
    ).toEqual({
      paused: false,
      thresholdMs: 1500,
      lastEventLoopDelayP95Ms: 54,
      pausedTicksTotal: 3,
    });
    expect(
      summarizeNonCriticalTimerPause({
        nonCriticalTimerPause: {
          paused: false,
          thresholdMs: 1500,
          lastEventLoopDelayP95Ms: 1800,
          pausedTicksTotal: 0,
        },
      }),
    ).toEqual({
      paused: false,
      thresholdMs: 1500,
      lastEventLoopDelayP95Ms: 1800,
      pausedTicksTotal: 0,
    });
  });

  it('preserves null p95 and defaults missing ticks to 0', () => {
    expect(
      summarizeNonCriticalTimerPause({
        nonCriticalTimerPause: {
          paused: true,
          thresholdMs: 1500,
          lastEventLoopDelayP95Ms: null,
        },
      }),
    ).toEqual({
      paused: true,
      thresholdMs: 1500,
      lastEventLoopDelayP95Ms: null,
      pausedTicksTotal: 0,
    });
  });
});

describe('kookr-status summarizeStartupRecovery (issue #2351)', () => {
  it('returns null when startupRecovery is absent', () => {
    expect(summarizeStartupRecovery({ status: 'ok' })).toBeNull();
  });

  it('returns null when counters are non-numeric', () => {
    expect(
      summarizeStartupRecovery({
        startupRecovery: {
          relaunched: 'x' as unknown as number,
          skipped: 1,
          failed: 0,
          crashLoopSkips: 0,
        },
      }),
    ).toBeNull();
  });

  it('returns the slim gauge including zeros', () => {
    expect(
      summarizeStartupRecovery({
        startupRecovery: {
          relaunched: 0,
          skipped: 0,
          failed: 0,
          crashLoopSkips: 0,
          generatedAt: '2026-08-12T00:00:00.000Z',
        },
      }),
    ).toEqual({
      relaunched: 0,
      skipped: 0,
      failed: 0,
      crashLoopSkips: 0,
      generatedAt: '2026-08-12T00:00:00.000Z',
    });
  });

  it('floors counters and nulls empty generatedAt', () => {
    expect(
      summarizeStartupRecovery({
        startupRecovery: {
          relaunched: 1.9,
          skipped: 2.1,
          failed: 0.7,
          crashLoopSkips: 1.2,
          generatedAt: '',
        },
      }),
    ).toEqual({
      relaunched: 1,
      skipped: 2,
      failed: 0,
      crashLoopSkips: 1,
      generatedAt: null,
    });
  });
});

describe('kookr-status summarizeMaintenancePrune (issue #2345)', () => {
  it('returns null when maintenancePrune is absent', () => {
    expect(summarizeMaintenancePrune({ status: 'ok' })).toBeNull();
  });

  it('returns the full schedule block including null last-run fields', () => {
    expect(
      summarizeMaintenancePrune({
        maintenancePrune: {
          enabled: false,
          intervalHours: 0,
          lastRunAt: null,
          lastReclaimedBytes: null,
          lastRemovedCount: null,
          lastError: null,
        },
      }),
    ).toEqual({
      enabled: false,
      intervalHours: 0,
      lastRunAt: null,
      lastReclaimedBytes: null,
      lastRemovedCount: null,
      lastError: null,
    });
  });

  it('floors numeric reclaim counters and keeps lastError strings', () => {
    expect(
      summarizeMaintenancePrune({
        maintenancePrune: {
          enabled: true,
          intervalHours: 12.5,
          lastRunAt: '2026-08-12T01:00:00.000Z',
          lastReclaimedBytes: 4096.9,
          lastRemovedCount: 2.2,
          lastError: 'disk exploded',
        },
      }),
    ).toEqual({
      enabled: true,
      intervalHours: 12.5,
      lastRunAt: '2026-08-12T01:00:00.000Z',
      lastReclaimedBytes: 4096,
      lastRemovedCount: 2,
      lastError: 'disk exploded',
    });
  });

  it('returns null when enabled is missing or non-boolean', () => {
    expect(
      summarizeMaintenancePrune({
        maintenancePrune: {
          intervalHours: 24,
          lastRunAt: null,
          lastReclaimedBytes: null,
          lastRemovedCount: null,
          lastError: null,
        },
      }),
    ).toBeNull();
  });
});

describe('kookr-status summarizeOssAttempts (issue #2332)', () => {
  it('returns null when ossAttempts is absent', () => {
    expect(summarizeOssAttempts({ status: 'ok' })).toBeNull();
  });

  it('returns null when openCount/totalCount are non-numeric', () => {
    expect(
      summarizeOssAttempts({
        ossAttempts: {
          openCount: 'x' as unknown as number,
          totalCount: 2,
          issueCheckErrorCount: 0,
        },
      }),
    ).toBeNull();
    expect(
      summarizeOssAttempts({
        ossAttempts: {
          openCount: 1,
          totalCount: 'y' as unknown as number,
          issueCheckErrorCount: 0,
        },
      }),
    ).toBeNull();
  });

  it('returns the slim gauge including zeros (for --json and always-on human)', () => {
    expect(
      summarizeOssAttempts({
        ossAttempts: {
          openCount: 0,
          totalCount: 0,
          lastRefreshAt: null,
          issueCheckErrorCount: 0,
          // Extra fields must not leak into the slim projection.
          attempts: [{ id: 'should-not-leak' }],
        },
      }),
    ).toEqual({
      openCount: 0,
      totalCount: 0,
      lastRefreshAt: null,
      issueCheckErrorCount: 0,
    });
  });

  it('floors counters and preserves lastRefreshAt string', () => {
    expect(
      summarizeOssAttempts({
        ossAttempts: {
          openCount: 2.9,
          totalCount: 5.1,
          lastRefreshAt: '2026-08-12T01:00:00.000Z',
          issueCheckErrorCount: 1.7,
        },
      }),
    ).toEqual({
      openCount: 2,
      totalCount: 5,
      lastRefreshAt: '2026-08-12T01:00:00.000Z',
      issueCheckErrorCount: 1,
    });
  });

  it('defaults missing issueCheckErrorCount to zero and nulls empty lastRefreshAt', () => {
    expect(
      summarizeOssAttempts({
        ossAttempts: {
          openCount: 1,
          totalCount: 1,
          lastRefreshAt: '',
        },
      }),
    ).toEqual({
      openCount: 1,
      totalCount: 1,
      lastRefreshAt: null,
      issueCheckErrorCount: 0,
    });
  });
});

describe('kookr-status summarizeLessonYield (issue #2305)', () => {
  it('returns null when lessonYield is absent', () => {
    expect(summarizeLessonYield({ status: 'ok' })).toBeNull();
  });

  it('returns null when decided/completedInWindow are non-numeric', () => {
    expect(
      summarizeLessonYield({
        lessonYield: {
          yieldRate: 0.5,
          decided: 'x' as unknown as number,
          completedInWindow: 2,
        },
      }),
    ).toBeNull();
    expect(
      summarizeLessonYield({
        lessonYield: {
          yieldRate: 0.5,
          decided: 1,
          completedInWindow: 'y' as unknown as number,
        },
      }),
    ).toBeNull();
  });

  it('returns the slim gauge including zeros (for --json and always-on human)', () => {
    expect(
      summarizeLessonYield({
        lessonYield: {
          schemaVersion: 'lesson-yield.v2',
          yieldRate: 0,
          decided: 0,
          completedInWindow: 0,
          buckets: {
            wroteLesson: 0,
            explicitSkip: 0,
            searchOnly: 0,
            noKbActivity: 0,
          },
          // Extra fields must not leak into the slim projection.
          byCompletionPath: {},
          contractRate: 0,
        },
      }),
    ).toEqual({
      yieldRate: 0,
      decided: 0,
      completedInWindow: 0,
      buckets: {
        wroteLesson: 0,
        explicitSkip: 0,
        searchOnly: 0,
        noKbActivity: 0,
      },
    });
  });

  it('returns slim non-zero gauge, floors counters, preserves yieldRate float', () => {
    expect(
      summarizeLessonYield({
        lessonYield: {
          yieldRate: 0.666,
          decided: 2.9,
          completedInWindow: 3.1,
          buckets: {
            wroteLesson: 1.7,
            explicitSkip: 1.2,
            searchOnly: 0.4,
            noKbActivity: 0.9,
          },
        },
      }),
    ).toEqual({
      yieldRate: 0.666,
      decided: 2,
      completedInWindow: 3,
      buckets: {
        wroteLesson: 1,
        explicitSkip: 1,
        searchOnly: 0,
        noKbActivity: 0,
      },
    });
  });

  it('defaults missing buckets to zero and recomputes yieldRate when omitted', () => {
    expect(
      summarizeLessonYield({
        lessonYield: {
          decided: 2,
          completedInWindow: 4,
        },
      }),
    ).toEqual({
      yieldRate: 0.5,
      decided: 2,
      completedInWindow: 4,
      buckets: {
        wroteLesson: 0,
        explicitSkip: 0,
        searchOnly: 0,
        noKbActivity: 0,
      },
    });
  });
});

describe('kookr-status summarizeSnapshotShed (issue #2299)', () => {
  it('returns null when snapshotShed is absent', () => {
    expect(summarizeSnapshotShed({ status: 'ok' })).toBeNull();
  });

  it('returns null when shedTotal is non-numeric', () => {
    expect(
      summarizeSnapshotShed({
        snapshotShed: {
          thresholdMs: 1500,
          lastEventLoopDelayP95Ms: 400,
          shedTotal: 'x' as unknown as number,
        },
      }),
    ).toBeNull();
  });

  it('returns the slim gauge including zero shedTotal (for --json)', () => {
    expect(
      summarizeSnapshotShed({
        snapshotShed: {
          schemaVersion: 'snapshot-shed.v1',
          thresholdMs: 1500,
          lastEventLoopDelayP95Ms: 54.5,
          shedTotal: 0,
        },
      }),
    ).toEqual({
      thresholdMs: 1500,
      lastEventLoopDelayP95Ms: 54,
      shedTotal: 0,
    });
  });

  it('returns elevated summary and floors fractional values', () => {
    expect(
      summarizeSnapshotShed({
        snapshotShed: {
          thresholdMs: 1500.9,
          lastEventLoopDelayP95Ms: 400.7,
          shedTotal: 1600.2,
        },
      }),
    ).toEqual({
      thresholdMs: 1500,
      lastEventLoopDelayP95Ms: 400,
      shedTotal: 1600,
    });
  });

  it('preserves null p95 and defaults missing threshold to 0', () => {
    expect(
      summarizeSnapshotShed({
        snapshotShed: {
          lastEventLoopDelayP95Ms: null,
          shedTotal: 2,
        },
      }),
    ).toEqual({
      thresholdMs: 0,
      lastEventLoopDelayP95Ms: null,
      shedTotal: 2,
    });
  });
});

describe('kookr-status summarizeHookIngestion (issue #2319)', () => {
  it('returns null when hookIngestion is absent', () => {
    expect(summarizeHookIngestion({ status: 'ok' })).toBeNull();
  });

  it('returns null when sessionCount or notableLagCount is non-numeric', () => {
    expect(
      summarizeHookIngestion({
        hookIngestion: {
          sessionCount: 'x' as unknown as number,
          notableLagCount: 1,
        },
      }),
    ).toBeNull();
    expect(
      summarizeHookIngestion({
        hookIngestion: {
          sessionCount: 1,
          notableLagCount: 'x' as unknown as number,
        },
      }),
    ).toBeNull();
  });

  it('returns the slim gauge including zero notableLagCount (for --json)', () => {
    expect(
      summarizeHookIngestion({
        hookIngestion: {
          sessionCount: 3,
          notableLagCount: 0,
          lagWarningThresholdMs: 2000,
          maxLagMs: null,
          p95LagMs: null,
          generatedAt: '2026-08-01T12:00:00.000Z',
        },
      }),
    ).toEqual({
      sessionCount: 3,
      notableLagCount: 0,
      lagWarningThresholdMs: 2000,
      maxLagMs: null,
      p95LagMs: null,
      generatedAt: '2026-08-01T12:00:00.000Z',
    });
  });

  it('floors fractional lag values and defaults missing threshold to 0', () => {
    expect(
      summarizeHookIngestion({
        hookIngestion: {
          sessionCount: 24.9,
          notableLagCount: 192.2,
          maxLagMs: 9000.7,
          p95LagMs: 8500.1,
        },
      }),
    ).toEqual({
      sessionCount: 24,
      notableLagCount: 192,
      lagWarningThresholdMs: 0,
      maxLagMs: 9000,
      p95LagMs: 8500,
    });
  });
});

describe('kookr-status summarizeLaunchDependencies (issue #2363)', () => {
  it('returns null when launchDependencies is absent', () => {
    expect(summarizeLaunchDependencies({ status: 'ok' })).toBeNull();
  });

  it('returns null when totals are non-numeric or negative', () => {
    expect(
      summarizeLaunchDependencies({
        launchDependencies: {
          totalDegradedTasks: 'x' as unknown as number,
          totalFindings: 0,
        },
      }),
    ).toBeNull();
    expect(
      summarizeLaunchDependencies({
        launchDependencies: {
          totalDegradedTasks: 0,
          totalFindings: -1,
        },
      }),
    ).toBeNull();
  });

  it('returns the slim gauge including zero degraded (for --json)', () => {
    expect(
      summarizeLaunchDependencies({
        launchDependencies: {
          schemaVersion: 'launch-dependency-diagnostics.v1',
          totalDegradedTasks: 0,
          totalFindings: 0,
          dependencies: [],
          categories: [],
        },
      }),
    ).toEqual({
      totalDegradedTasks: 0,
      totalFindings: 0,
      dependencies: [],
    });
  });

  it('returns slim multi-dependency counts without affectedTaskIds', () => {
    expect(
      summarizeLaunchDependencies({
        launchDependencies: {
          totalDegradedTasks: 3.9,
          totalFindings: 4.2,
          dependencies: [
            {
              dependency: 'kb',
              degradedTaskCount: 2.7,
              findingCount: 3,
              affectedTaskIds: ['t1', 't2'],
              categories: ['provider_api', 'unknown'],
              lastOccurredAt: '2026-08-12T00:00:00.000Z',
            },
            {
              dependency: 'gh',
              degradedTaskCount: 1,
              findingCount: 1,
              affectedTaskIds: ['t3'],
              categories: ['auth'],
            },
            // Malformed rows are skipped, not fatal.
            { dependency: '', degradedTaskCount: 9 },
            { dependency: 'bad', degradedTaskCount: 'x' as unknown as number },
          ],
        },
      }),
    ).toEqual({
      totalDegradedTasks: 3,
      totalFindings: 4,
      dependencies: [
        {
          dependency: 'kb',
          degradedTaskCount: 2,
          categories: ['provider_api', 'unknown'],
        },
        {
          dependency: 'gh',
          degradedTaskCount: 1,
          categories: ['auth'],
        },
      ],
    });
  });
});

describe('kookr-status summarizeSchedulesPausedByFailure (issue #2424)', () => {
  it('returns null when schedules or the pause array is absent', () => {
    expect(summarizeSchedulesPausedByFailure({ status: 'ok' })).toBeNull();
    expect(
      summarizeSchedulesPausedByFailure({ status: 'ok', schedules: {} }),
    ).toBeNull();
  });

  it('returns null when the pause array is empty or every row is malformed', () => {
    expect(
      summarizeSchedulesPausedByFailure({
        schedules: { schedulesPausedByFailure: [] },
      }),
    ).toBeNull();
    expect(
      summarizeSchedulesPausedByFailure({
        schedules: {
          schedulesPausedByFailure: [
            { id: '', name: 'x', consecutiveFailures: 3 },
            { id: 's1', name: '', consecutiveFailures: 3 },
            { id: 's2', name: 'ok', consecutiveFailures: -1 },
            { id: 's3', name: 'ok', consecutiveFailures: 'x' as unknown as number },
            null as unknown as { id: string; name: string; consecutiveFailures: number },
          ],
        },
      }),
    ).toBeNull();
  });

  it('returns slim id/name/consecutiveFailures rows and skips malformed ones', () => {
    expect(
      summarizeSchedulesPausedByFailure({
        schedules: {
          schedulesPausedByFailure: [
            { id: 's1', name: 'orchestrator', consecutiveFailures: 30.9 },
            { id: 's2', name: 'deploy-conv', consecutiveFailures: 55 },
            { id: '', name: 'skip-me', consecutiveFailures: 9 },
            { extra: true } as unknown as { id: string; name: string; consecutiveFailures: number },
          ],
        },
      }),
    ).toEqual([
      { id: 's1', name: 'orchestrator', consecutiveFailures: 30 },
      { id: 's2', name: 'deploy-conv', consecutiveFailures: 55 },
    ]);
  });
});

describe('kookr-status summarizeHungSuspectTtlReclaim (issue #2229)', () => {
  it('returns null when hungSuspectTtlReclaim is absent', () => {
    expect(summarizeHungSuspectTtlReclaim({ status: 'ok' })).toBeNull();
  });

  it('returns null when reclaimedTotal > 0 (reclaim progressing)', () => {
    expect(
      summarizeHungSuspectTtlReclaim({
        hungSuspectTtlReclaim: {
          reclaimedTotal: 1,
          reclaimAttempted: 1,
          skippedOpenPrFailsafe: 99,
          lastCandidatesConsidered: 2,
        },
      }),
    ).toBeNull();
  });

  it('returns null when reclaimedTotal=0 but all skips/candidates/residual are zero', () => {
    expect(
      summarizeHungSuspectTtlReclaim({
        hungSuspectTtlReclaim: {
          reclaimedTotal: 0,
          reclaimAttempted: 0,
          skippedNoLiveness: 0,
          skippedOpenPrFailsafe: 0,
          skippedOpenPrConfirmed: 0,
          skippedOpenPrUnknown: 0,
          skippedUnderTtl: 0,
          skippedExemptAnomaly: 0,
          skippedProviderPaused: 0,
          lastCandidatesConsidered: 0,
          lastOutcomes: [],
        },
      }),
    ).toBeNull();
  });

  it('returns slim residual with skip breakdown, hungSuspect, and residual class counts', () => {
    expect(
      summarizeHungSuspectTtlReclaim({
        capacity: {
          maxActiveTasks: 16,
          active: 10,
          free: 6,
          byClass: {
            working: 6,
            finishedAwaitingAck: 0,
            hungSuspect: 4.9,
            launching: 0,
          },
        },
        hungSuspectTtlReclaim: {
          reclaimedTotal: 0,
          reclaimAttempted: 0.2,
          reclaimSucceeded: 0,
          skippedNoLiveness: 1.1,
          skippedOpenPrFailsafe: 12.7,
          skippedOpenPrConfirmed: 8.2,
          skippedOpenPrUnknown: 4.9,
          skippedUnderTtl: 3.2,
          skippedExemptAnomaly: 0,
          skippedProviderPaused: 5.9,
          lastCandidatesConsidered: 4.1,
          lastOutcomes: [
            { taskId: 'a', outcome: 'skipped_open_pr_failsafe' },
            { taskId: 'b', outcome: 'skipped_open_pr_failsafe' },
            { taskId: 'c', outcome: 'skipped_under_ttl' },
            { taskId: 'd' }, // missing outcome ignored
          ],
          lastAttemptedTaskIds: ['x'],
        },
      }),
    ).toEqual({
      reclaimedTotal: 0,
      reclaimAttempted: 0,
      skippedNoLiveness: 1,
      skippedOpenPrFailsafe: 12,
      skippedOpenPrConfirmed: 8,
      skippedOpenPrUnknown: 4,
      skippedUnderTtl: 3,
      skippedExemptAnomaly: 0,
      skippedProviderPaused: 5,
      lastCandidatesConsidered: 4,
      hungSuspect: 4,
      residualClasses: {
        skipped_open_pr_failsafe: 2,
        skipped_under_ttl: 1,
      },
    });
  });

  it('elevates on candidates alone without lifetime skips', () => {
    expect(
      summarizeHungSuspectTtlReclaim({
        hungSuspectTtlReclaim: {
          reclaimedTotal: 0,
          reclaimAttempted: 0,
          lastCandidatesConsidered: 3,
        },
      }),
    ).toEqual({
      reclaimedTotal: 0,
      reclaimAttempted: 0,
      skippedNoLiveness: 0,
      skippedOpenPrFailsafe: 0,
      skippedOpenPrConfirmed: 0,
      skippedOpenPrUnknown: 0,
      skippedUnderTtl: 0,
      skippedExemptAnomaly: 0,
      skippedProviderPaused: 0,
      lastCandidatesConsidered: 3,
    });
  });
});

describe('kookr-status summarizeFirstHookMiss (issue #2235)', () => {
  it('returns null when firstHookMissTotal is absent', () => {
    expect(summarizeFirstHookMiss({ status: 'ok' })).toBeNull();
  });

  it('returns null when firstHookMissTotal is zero', () => {
    expect(summarizeFirstHookMiss({ firstHookMissTotal: 0 })).toBeNull();
  });

  it('returns null when firstHookMissTotal is non-numeric', () => {
    expect(
      summarizeFirstHookMiss({ firstHookMissTotal: 'x' as unknown as number }),
    ).toBeNull();
  });

  it('returns the elevated total and floors fractional values', () => {
    expect(summarizeFirstHookMiss({ firstHookMissTotal: 4.9 })).toEqual({
      firstHookMissTotal: 4,
    });
  });
});

describe('kookr-status summarizeCapacity (issue #2234)', () => {
  const elevatedPhantom = {
    maxActiveTasks: 16,
    active: 15,
    free: 1,
    byClass: {
      working: 9,
      finishedAwaitingAck: 2,
      hungSuspect: 4,
      launching: 0,
    },
    effectiveWorking: 9,
    phantomActive: 6,
    utilizationPct: 93.75,
    effectiveUtilizationPct: 56.25,
    freeForGeneralSources: 5,
  };

  it('returns null when capacity is absent', () => {
    expect(summarizeCapacity({ status: 'ok' })).toBeNull();
  });

  it('returns null when required fields are non-numeric', () => {
    expect(
      summarizeCapacity({
        capacity: {
          ...elevatedPhantom,
          phantomActive: 'x' as unknown as number,
        },
      }),
    ).toBeNull();
  });

  it('returns null when byClass is incomplete', () => {
    expect(
      summarizeCapacity({
        capacity: {
          ...elevatedPhantom,
          byClass: { working: 9 } as unknown as typeof elevatedPhantom.byClass,
        },
      }),
    ).toBeNull();
  });

  it('returns slim capacity for phantom residual (sample from issue #2234)', () => {
    expect(summarizeCapacity({ capacity: elevatedPhantom })).toEqual({
      maxActiveTasks: 16,
      active: 15,
      free: 1,
      effectiveWorking: 9,
      phantomActive: 6,
      utilizationPct: 93.75,
      effectiveUtilizationPct: 56.25,
      byClass: {
        working: 9,
        finishedAwaitingAck: 2,
        hungSuspect: 4,
        launching: 0,
      },
      freeForGeneralSources: 5,
    });
  });

  it('surfaces high util without phantoms (>= 75%)', () => {
    expect(
      summarizeCapacity({
        capacity: {
          maxActiveTasks: 16,
          active: 12,
          free: 4,
          byClass: {
            working: 12,
            finishedAwaitingAck: 0,
            hungSuspect: 0,
            launching: 0,
          },
          effectiveWorking: 12,
          phantomActive: 0,
          utilizationPct: 75,
          effectiveUtilizationPct: 75,
        },
      }),
    ).toEqual({
      maxActiveTasks: 16,
      active: 12,
      free: 4,
      effectiveWorking: 12,
      phantomActive: 0,
      utilizationPct: 75,
      effectiveUtilizationPct: 75,
      byClass: {
        working: 12,
        finishedAwaitingAck: 0,
        hungSuspect: 0,
        launching: 0,
      },
    });
  });

  it('surfaces a large util gap even below high-util and without phantoms', () => {
    // Isolates CAPACITY_UTIL_GAP_PCT (defensive gate under ledger invariants).
    expect(
      summarizeCapacity({
        capacity: {
          maxActiveTasks: 16,
          active: 8,
          free: 8,
          byClass: {
            working: 8,
            finishedAwaitingAck: 0,
            hungSuspect: 0,
            launching: 0,
          },
          effectiveWorking: 6,
          phantomActive: 0,
          utilizationPct: 50,
          effectiveUtilizationPct: 37.5, // gap 12.5 >= 10
        },
      }),
    ).toMatchObject({
      utilizationPct: 50,
      effectiveUtilizationPct: 37.5,
      phantomActive: 0,
    });
  });

  it('stays quiet for healthy low-util fleets', () => {
    expect(
      summarizeCapacity({
        capacity: {
          maxActiveTasks: 16,
          active: 4,
          free: 12,
          byClass: {
            working: 4,
            finishedAwaitingAck: 0,
            hungSuspect: 0,
            launching: 0,
          },
          effectiveWorking: 4,
          phantomActive: 0,
          utilizationPct: 25,
          effectiveUtilizationPct: 25,
        },
      }),
    ).toBeNull();
  });

  it('floors integer counters while preserving util percentages', () => {
    expect(
      summarizeCapacity({
        capacity: {
          maxActiveTasks: 16.9,
          active: 15.2,
          free: 0.9,
          byClass: {
            working: 9.1,
            finishedAwaitingAck: 2.8,
            hungSuspect: 4.2,
            launching: 0.4,
          },
          effectiveWorking: 9.7,
          phantomActive: 6.3,
          utilizationPct: 93.75,
          effectiveUtilizationPct: 56.25,
        },
      }),
    ).toEqual({
      maxActiveTasks: 16,
      active: 15,
      free: 0,
      effectiveWorking: 9,
      phantomActive: 6,
      utilizationPct: 93.75,
      effectiveUtilizationPct: 56.25,
      byClass: {
        working: 9,
        finishedAwaitingAck: 2,
        hungSuspect: 4,
        launching: 0,
      },
    });
  });
});

describe('kookr-status formatUtilPct (issue #2234)', () => {
  it('trims trailing zeros while keeping two-decimal precision', () => {
    expect(formatUtilPct(93.75)).toBe('93.75');
    expect(formatUtilPct(87.5)).toBe('87.5');
    expect(formatUtilPct(50)).toBe('50');
    expect(formatUtilPct(56.2500001)).toBe('56.25');
  });

  it('returns 0 for non-finite input', () => {
    expect(formatUtilPct(Number.NaN)).toBe('0');
  });
});

describe('kookr-status main (integration-style)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeDeps(env: Record<string, string | undefined> = {}) {
    const logs: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    return {
      env,
      out: {
        log: (m: string) => logs.push(m),
        error: (m: string) => errors.push(m),
      },
      exit: ((code: number) => { exits.push(code); }) as () => never,
      logs,
      errors,
      exits,
    };
  }

  function mockSuccessfulFetch(snapshotBody: unknown[], healthExtra: Record<string, unknown> = {}) {
    const healthBody = {
      status: 'ok',
      serverStartedAt: new Date(Date.now() - 60_000).toISOString(),
      build: { version: 'dev' },
      ...healthExtra,
    };
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const href = typeof url === 'string' ? url : url.href;
      if (href.endsWith('/api/health')) {
        return new Response(JSON.stringify(healthBody), { status: 200 });
      }
      if (href.endsWith('/api/snapshot')) {
        return new Response(JSON.stringify(snapshotBody), { status: 200 });
      }
      throw new Error(`unexpected ${href}`);
    }) as typeof fetch;
    return healthBody;
  }

  it('errors out cleanly when KOOKR_PORT is not a valid integer', async () => {
    const deps = makeDeps({ KOOKR_PORT: 'abc' });
    await main(deps);
    expect(deps.exits).toEqual([1]);
    expect(deps.errors.join('\n')).toContain('KOOKR_PORT must be an integer');
    expect(deps.logs).toEqual([]);
  });

  it('prints help and exits 0', async () => {
    const deps = makeDeps({});
    await main({ ...deps, argv: ['--help'] });
    expect(deps.exits).toEqual([0]);
    expect(deps.logs.join('\n')).toContain('kookr status');
    expect(deps.errors).toEqual([]);
  });

  it('rejects unexpected arguments', async () => {
    const deps = makeDeps({});
    await main({ ...deps, argv: ['extra'] });
    expect(deps.exits).toEqual([2]);
    expect(deps.errors.join('\n')).toContain('Unexpected argument: extra');
    expect(deps.logs).toEqual([]);
  });

  it('honors --json even when it appears after an unexpected argument', async () => {
    const deps = makeDeps({});
    await main({ ...deps, argv: ['extra', '--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([2]);
    expect(deps.errors).toEqual([]);
    expect(envelope).toMatchObject({
      ok: false,
      code: 'USER_ERROR',
      message: 'Unexpected argument: extra',
      details: { subcommand: 'status' },
    });
  });

  it('errors out with "not running" when auto-detect finds no server', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof fetch;
    const deps = makeDeps({});
    await main(deps);
    expect(deps.exits).toEqual([1]);
    expect(deps.errors.join('\n')).toContain('Kookr is not running on ports 4800, 4801');
    expect(deps.logs).toEqual([]);
  });

  it('prints a JSON envelope when auto-detect finds no server with --json', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof fetch;
    const deps = makeDeps({});
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([1]);
    expect(deps.errors).toEqual([]);
    expect(envelope).toMatchObject({
      ok: false,
      code: 'NO_SERVER',
      details: { ports: [4800, 4801] },
    });
  });

  it('errors out on explicit port when the server is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof fetch;
    const deps = makeDeps({ KOOKR_PORT: '9999' });
    await main(deps);
    expect(deps.exits).toEqual([1]);
    expect(deps.errors.join('\n')).toContain('Failed to reach Kookr on port 9999');
    expect(deps.logs).toEqual([]);
  });

  it('prints a report on the happy path', async () => {
    const snapshotBody = [
      {
        agentId: 'a1',
        taskName: 't1',
        taskStatus: 'inProgress',
        tokenUsage: { costUsd: 0.5 },
        anomaly: null,
      },
    ];
    mockSuccessfulFetch(snapshotBody);

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main(deps);
    expect(deps.exits).toEqual([]);
    expect(deps.errors).toEqual([]);
    expect(deps.logs).toHaveLength(1);
    const out = deps.logs[0];
    expect(out).toContain('Kookr on port 4800');
    expect(out).toContain('Agents:  1');
    expect(out).toContain('Cost:    $0.50');
    expect(out).toContain('No active findings.');
  });

  it('prints a JSON envelope with snapshot details on the happy path', async () => {
    const snapshotBody = [
      {
        agentId: 'a1',
        taskName: 't1',
        taskStatus: 'inProgress',
        tokenUsage: { costUsd: 0.5 },
        anomaly: null,
      },
    ];
    const healthBody = mockSuccessfulFetch(snapshotBody);

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(deps.errors).toEqual([]);
    expect(envelope).toMatchObject({
      ok: true,
      code: 'OK',
      message: 'Kookr status snapshot',
      details: {
        port: 4800,
        health: healthBody,
        agents: snapshotBody,
        summary: {
          statusCounts: { inProgress: 1 },
          totalCost: 0.5,
        },
      },
    });
    expect(envelope.details.failOn).toBeUndefined();
    expect(envelope.details.highestSeverity).toBeUndefined();
    // No pipelineStarvation / staleProcesses / payloadDiet / firstHookMissTotal
    // / providerPausedOccupancy / nonCriticalTimerPause / snapshotShed /
    // hungSuspectTtlReclaim / lessonYield / launchDependencies block on
    // /api/health → no slim summary (no-op).
    expect(envelope.details.pipelineStarvation).toBeUndefined();
    expect(envelope.details.staleProcesses).toBeUndefined();
    expect(envelope.details.hostStaleDtachReaper).toBeUndefined();
    expect(envelope.details.payloadDiet).toBeUndefined();
    expect(envelope.details.firstHookMissTotal).toBeUndefined();
    expect(envelope.details.providerPausedOccupancy).toBeUndefined();
    expect(envelope.details.nonCriticalTimerPause).toBeUndefined();
    expect(envelope.details.snapshotShed).toBeUndefined();
    expect(envelope.details.hungSuspectTtlReclaim).toBeUndefined();
    expect(envelope.details.lessonYield).toBeUndefined();
    expect(envelope.details.launchDependencies).toBeUndefined();
  });

  it('includes a slim hostStaleDtachReaper summary in --json when elevated (issue #2386)', async () => {
    mockSuccessfulFetch([], {
      hostStaleDtachReaper: {
        enabled: true,
        dryRun: false,
        softBound: 20,
        maxReapsPerSweep: 5,
        lastSweepAt: '2026-08-12T00:00:00.000Z',
        lastDtachCount: 24,
        lastUnderPressure: true,
        lastHostStaleDtachReaped: 0,
        totalHostStaleDtachReaped: 1,
        skippedLiveAttached: 9,
        lastReapedAlways: 1,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.hostStaleDtachReaper).toEqual({
      lastUnderPressure: true,
      lastDtachCount: 24,
      lastHostStaleDtachReaped: 0,
      totalHostStaleDtachReaped: 1,
    });
  });

  it('omits details.hostStaleDtachReaper in --json for a quiet fleet (issue #2386)', async () => {
    mockSuccessfulFetch([], {
      hostStaleDtachReaper: {
        lastDtachCount: 4,
        lastUnderPressure: false,
        lastHostStaleDtachReaped: 0,
        totalHostStaleDtachReaped: 0,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.hostStaleDtachReaper).toBeUndefined();
  });

  it('includes a slim pipelineStarvation summary in --json when elevated (issue #2183)', async () => {
    mockSuccessfulFetch([], {
      pipelineStarvation: {
        schemaVersion: 'pipeline-starvation.v1',
        repos: {
          'kookr-ai/kookr': {
            repo: 'kookr-ai/kookr',
            consecutiveBlockedEmpty: 2,
            effectiveScoutCooldownMs: 1_800_000,
            // Extra fields on the raw health row must NOT leak into the slim summary.
            lastSpawnSkipReason: 'cooldown',
          },
          'idle/repo': { repo: 'idle/repo', consecutiveBlockedEmpty: 0 },
        },
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.pipelineStarvation).toEqual({
      elevated: 1,
      repos: [
        { repo: 'kookr-ai/kookr', consecutiveBlockedEmpty: 2, effectiveScoutCooldownMs: 1_800_000 },
      ],
    });
  });

  it('includes a slim staleProcesses summary in --json when elevated (issue #2209)', async () => {
    mockSuccessfulFetch([], {
      staleProcesses: {
        dtach: { count: 27, rssBytes: 1_288_490_188 },
        relayServer: { count: 0, rssBytes: 0 },
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.staleProcesses).toEqual({
      dtach: { count: 27, rssBytes: 1_288_490_188 },
    });
  });

  it('omits details.staleProcesses in --json when counts are zero (issue #2209)', async () => {
    mockSuccessfulFetch([], {
      staleProcesses: {
        dtach: { count: 0, rssBytes: 0 },
        relayServer: { count: 0, rssBytes: 0 },
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.staleProcesses).toBeUndefined();
  });

  it('includes details.payloadDiet in --json when present, including zeros (issue #2220)', async () => {
    mockSuccessfulFetch([], {
      payloadDiet: {
        trackedTasks: 40,
        terminalTasks: 30,
        lastSnapshotBytes: 123_456,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.payloadDiet).toEqual({
      trackedTasks: 40,
      terminalTasks: 30,
      lastSnapshotBytes: 123_456,
    });
  });

  it('includes details.payloadDiet with null snapshot bytes (issue #2220)', async () => {
    mockSuccessfulFetch([], {
      payloadDiet: {
        trackedTasks: 0,
        terminalTasks: 0,
        lastSnapshotBytes: null,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.payloadDiet).toEqual({
      trackedTasks: 0,
      terminalTasks: 0,
      lastSnapshotBytes: null,
    });
  });

  it('includes details.hookReplayCheckpoints in --json when present, including zeros (issue #2281)', async () => {
    mockSuccessfulFetch([], {
      hookReplayCheckpoints: {
        sessionCount: 5364,
        fileBytes: 19_900_000,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.hookReplayCheckpoints).toEqual({
      sessionCount: 5364,
      fileBytes: 19_900_000,
    });
  });

  it('includes details.hookReplayCheckpoints zeros in --json (issue #2281)', async () => {
    mockSuccessfulFetch([], {
      hookReplayCheckpoints: { sessionCount: 0, fileBytes: 0 },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.hookReplayCheckpoints).toEqual({
      sessionCount: 0,
      fileBytes: 0,
    });
  });

  it('omits details.hookReplayCheckpoints in --json when null/disabled (issue #2281)', async () => {
    mockSuccessfulFetch([], { hookReplayCheckpoints: null });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.hookReplayCheckpoints).toBeUndefined();
  });

  it('includes details.firstHookMissTotal in --json when elevated (issue #2235)', async () => {
    mockSuccessfulFetch([], { firstHookMissTotal: 4 });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.firstHookMissTotal).toBe(4);
  });

  it('omits details.firstHookMissTotal in --json when zero (issue #2235)', async () => {
    mockSuccessfulFetch([], { firstHookMissTotal: 0 });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.firstHookMissTotal).toBeUndefined();
  });

  it('includes details.lessonYield in --json when present, including zeros (issue #2305)', async () => {
    mockSuccessfulFetch([], {
      lessonYield: {
        schemaVersion: 'lesson-yield.v2',
        yieldRate: 0.75,
        decided: 3,
        completedInWindow: 4,
        buckets: {
          wroteLesson: 2,
          explicitSkip: 1,
          searchOnly: 0,
          noKbActivity: 1,
        },
        // Extra fields must not leak into the slim projection.
        byCompletionPath: { agent: { wroteLesson: 2 } },
        contractRate: 0.75,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.lessonYield).toEqual({
      yieldRate: 0.75,
      decided: 3,
      completedInWindow: 4,
      buckets: {
        wroteLesson: 2,
        explicitSkip: 1,
        searchOnly: 0,
        noKbActivity: 1,
      },
    });
    expect(envelope.details.lessonYield.byCompletionPath).toBeUndefined();
    expect(envelope.details.lessonYield.contractRate).toBeUndefined();
  });

  it('includes details.lessonYield zeros in --json (issue #2305)', async () => {
    mockSuccessfulFetch([], {
      lessonYield: {
        yieldRate: 0,
        decided: 0,
        completedInWindow: 0,
        buckets: {
          wroteLesson: 0,
          explicitSkip: 0,
          searchOnly: 0,
          noKbActivity: 0,
        },
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.lessonYield).toEqual({
      yieldRate: 0,
      decided: 0,
      completedInWindow: 0,
      buckets: {
        wroteLesson: 0,
        explicitSkip: 0,
        searchOnly: 0,
        noKbActivity: 0,
      },
    });
  });

  it('includes details.maintenancePrune in --json when present, including disabled (issue #2345)', async () => {
    mockSuccessfulFetch([], {
      maintenancePrune: {
        enabled: false,
        intervalHours: 0,
        lastRunAt: null,
        lastReclaimedBytes: null,
        lastRemovedCount: null,
        lastError: null,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.maintenancePrune).toEqual({
      enabled: false,
      intervalHours: 0,
      lastRunAt: null,
      lastReclaimedBytes: null,
      lastRemovedCount: null,
      lastError: null,
    });
  });

  it('includes details.maintenancePrune last-run fields in --json (issue #2345)', async () => {
    mockSuccessfulFetch([], {
      maintenancePrune: {
        enabled: true,
        intervalHours: 24,
        lastRunAt: '2026-08-12T02:00:00.000Z',
        lastReclaimedBytes: 8192,
        lastRemovedCount: 5,
        lastError: null,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.maintenancePrune).toEqual({
      enabled: true,
      intervalHours: 24,
      lastRunAt: '2026-08-12T02:00:00.000Z',
      lastReclaimedBytes: 8192,
      lastRemovedCount: 5,
      lastError: null,
    });
  });

  it('omits details.maintenancePrune in --json when absent (issue #2345)', async () => {
    mockSuccessfulFetch([], {});

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.maintenancePrune).toBeUndefined();
  });

  it('includes a slim capacity summary in --json when elevated (issue #2234)', async () => {
    mockSuccessfulFetch([], {
      capacity: {
        maxActiveTasks: 16,
        active: 15,
        free: 1,
        byClass: {
          working: 9,
          finishedAwaitingAck: 2,
          hungSuspect: 4,
          launching: 0,
        },
        effectiveWorking: 9,
        phantomActive: 6,
        utilizationPct: 93.75,
        effectiveUtilizationPct: 56.25,
        freeForGeneralSources: 5,
        // Extra ledger fields must not leak into the slim projection.
        pendingQueueDepth: 0,
        oldestPendingAgeMs: null,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.capacity).toEqual({
      maxActiveTasks: 16,
      active: 15,
      free: 1,
      effectiveWorking: 9,
      phantomActive: 6,
      utilizationPct: 93.75,
      effectiveUtilizationPct: 56.25,
      byClass: {
        working: 9,
        finishedAwaitingAck: 2,
        hungSuspect: 4,
        launching: 0,
      },
      freeForGeneralSources: 5,
    });
    expect(envelope.details.capacity.pendingQueueDepth).toBeUndefined();
  });

  it('omits details.capacity in --json when fleet is quiet (issue #2234)', async () => {
    mockSuccessfulFetch([], {
      capacity: {
        maxActiveTasks: 16,
        active: 4,
        free: 12,
        byClass: {
          working: 4,
          finishedAwaitingAck: 0,
          hungSuspect: 0,
          launching: 0,
        },
        effectiveWorking: 4,
        phantomActive: 0,
        utilizationPct: 25,
        effectiveUtilizationPct: 25,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.capacity).toBeUndefined();
  });

  it('includes a slim providerPausedOccupancy summary in --json when elevated (issue #2236)', async () => {
    mockSuccessfulFetch([], {
      providerPausedOccupancy: {
        count: 8,
        oldestPauseAgeMs: 3_600_000,
        reclaimAttempted: 2,
        reclaimedTotal: 1,
        // Extra health fields must NOT leak into the slim summary.
        taskIds: ['a', 'b'],
        hardTtlMs: 7_200_000,
        lastOutcomes: [],
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.providerPausedOccupancy).toEqual({
      count: 8,
      oldestPauseAgeMs: 3_600_000,
      reclaimAttempted: 2,
      reclaimedTotal: 1,
      softTtlMs: null,
      effectiveTtlMs: null,
      capacityEarlyReclaim: false,
    });
  });

  it('omits details.providerPausedOccupancy in --json when count is zero (issue #2236)', async () => {
    mockSuccessfulFetch([], {
      providerPausedOccupancy: {
        count: 0,
        oldestPauseAgeMs: null,
        reclaimAttempted: 0,
        reclaimedTotal: 0,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.providerPausedOccupancy).toBeUndefined();
  });

  it('includes a slim nonCriticalTimerPause summary in --json when elevated (issue #2230)', async () => {
    mockSuccessfulFetch([], {
      nonCriticalTimerPause: {
        schemaVersion: 'non-critical-timer-pause.v1',
        paused: true,
        thresholdMs: 1500,
        lastEventLoopDelayP95Ms: 2400.7,
        pausedTicksTotal: 16,
        // Extra health fields must NOT leak into the slim summary.
        unused: true,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.nonCriticalTimerPause).toEqual({
      paused: true,
      thresholdMs: 1500,
      lastEventLoopDelayP95Ms: 2400,
      pausedTicksTotal: 16,
    });
  });

  it('omits details.nonCriticalTimerPause in --json when healthy (issue #2230)', async () => {
    mockSuccessfulFetch([], {
      nonCriticalTimerPause: {
        paused: false,
        thresholdMs: 1500,
        lastEventLoopDelayP95Ms: 54,
        pausedTicksTotal: 0,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.nonCriticalTimerPause).toBeUndefined();
  });

  it('includes details.snapshotShed in --json when present, including zeros (issue #2299)', async () => {
    mockSuccessfulFetch([], {
      snapshotShed: {
        schemaVersion: 'snapshot-shed.v1',
        thresholdMs: 1500,
        lastEventLoopDelayP95Ms: 54.5,
        shedTotal: 0,
        // Extra health fields must NOT leak into the slim summary.
        unused: true,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.snapshotShed).toEqual({
      thresholdMs: 1500,
      lastEventLoopDelayP95Ms: 54,
      shedTotal: 0,
    });
  });

  it('includes elevated details.snapshotShed in --json (issue #2299)', async () => {
    mockSuccessfulFetch([], {
      snapshotShed: {
        thresholdMs: 1500.9,
        lastEventLoopDelayP95Ms: 400.7,
        shedTotal: 1600.2,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.snapshotShed).toEqual({
      thresholdMs: 1500,
      lastEventLoopDelayP95Ms: 400,
      shedTotal: 1600,
    });
  });

  it('omits details.snapshotShed in --json when absent (issue #2299)', async () => {
    mockSuccessfulFetch([], {});

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.snapshotShed).toBeUndefined();
  });

  it('includes details.hookIngestion in --json when present, including zeros (issue #2319)', async () => {
    mockSuccessfulFetch([], {
      hookIngestion: {
        sessionCount: 3,
        notableLagCount: 0,
        lagWarningThresholdMs: 2000,
        maxLagMs: null,
        p95LagMs: null,
        generatedAt: '2026-08-01T12:00:00.000Z',
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.hookIngestion).toEqual({
      sessionCount: 3,
      notableLagCount: 0,
      lagWarningThresholdMs: 2000,
      maxLagMs: null,
      p95LagMs: null,
      generatedAt: '2026-08-01T12:00:00.000Z',
    });
  });

  it('includes elevated details.hookIngestion in --json (issue #2319)', async () => {
    mockSuccessfulFetch([], {
      hookIngestion: {
        sessionCount: 24.9,
        notableLagCount: 192.2,
        lagWarningThresholdMs: 2000.1,
        maxLagMs: 9000.7,
        p95LagMs: 8500.1,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.hookIngestion).toEqual({
      sessionCount: 24,
      notableLagCount: 192,
      lagWarningThresholdMs: 2000,
      maxLagMs: 9000,
      p95LagMs: 8500,
    });
  });

  it('omits details.hookIngestion in --json when absent (issue #2319)', async () => {
    mockSuccessfulFetch([], {});

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.hookIngestion).toBeUndefined();
  });

  it('includes details.launchDependencies in --json when present, including zeros (issue #2363)', async () => {
    mockSuccessfulFetch([], {
      launchDependencies: {
        schemaVersion: 'launch-dependency-diagnostics.v1',
        totalDegradedTasks: 0,
        totalFindings: 0,
        dependencies: [],
        categories: [],
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.launchDependencies).toEqual({
      totalDegradedTasks: 0,
      totalFindings: 0,
      dependencies: [],
    });
  });

  it('includes a slim multi-dependency launchDependencies summary in --json (issue #2363)', async () => {
    mockSuccessfulFetch([], {
      launchDependencies: {
        schemaVersion: 'launch-dependency-diagnostics.v1',
        totalDegradedTasks: 8,
        totalFindings: 9,
        dependencies: [
          {
            dependency: 'kb',
            degradedTaskCount: 8,
            findingCount: 8,
            affectedTaskIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
            categories: ['provider_api'],
            lastOccurredAt: '2026-08-12T00:00:00.000Z',
          },
          {
            dependency: 'gh',
            degradedTaskCount: 1,
            findingCount: 1,
            affectedTaskIds: ['z'],
            categories: ['auth'],
          },
        ],
        categories: [
          {
            category: 'provider_api',
            degradedTaskCount: 8,
            findingCount: 8,
            affectedTaskIds: ['a'],
            dependencies: ['kb'],
          },
        ],
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.launchDependencies).toEqual({
      totalDegradedTasks: 8,
      totalFindings: 9,
      dependencies: [
        {
          dependency: 'kb',
          degradedTaskCount: 8,
          categories: ['provider_api'],
        },
        {
          dependency: 'gh',
          degradedTaskCount: 1,
          categories: ['auth'],
        },
      ],
    });
    // Slim projection must not dump full task-id lists.
    expect(JSON.stringify(envelope.details.launchDependencies)).not.toContain('affectedTaskIds');
  });

  it('omits details.launchDependencies in --json when absent (issue #2363)', async () => {
    mockSuccessfulFetch([], {});

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.launchDependencies).toBeUndefined();
  });

  it('includes details.schedulesPausedByFailure in --json when non-empty (issue #2424)', async () => {
    mockSuccessfulFetch([], {
      schedules: {
        timezone: 'Europe/Paris',
        catchUpMode: 'auto',
        catchUpEnabled: true,
        schedulerHealthy: true,
        schedulesPausedByFailure: [
          { id: 's1', name: 'orchestrator', consecutiveFailures: 30 },
          { id: 's2', name: 'deploy-conv', consecutiveFailures: 55.2 },
        ],
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.schedulesPausedByFailure).toEqual([
      { id: 's1', name: 'orchestrator', consecutiveFailures: 30 },
      { id: 's2', name: 'deploy-conv', consecutiveFailures: 55 },
    ]);
    expect(JSON.stringify(envelope.details.schedulesPausedByFailure)).not.toContain('timezone');
  });

  it('omits details.schedulesPausedByFailure in --json when absent or empty (issue #2424)', async () => {
    mockSuccessfulFetch([], {});
    const missing = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...missing, argv: ['--json'] });
    expect(parseSingleJsonLog(missing.logs).details.schedulesPausedByFailure).toBeUndefined();

    mockSuccessfulFetch([], { schedules: { schedulesPausedByFailure: [] } });
    const empty = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...empty, argv: ['--json'] });
    expect(parseSingleJsonLog(empty.logs).details.schedulesPausedByFailure).toBeUndefined();
  });

  it('includes a slim hungSuspectTtlReclaim summary in --json when residual elevated (issue #2229)', async () => {
    mockSuccessfulFetch([], {
      capacity: {
        maxActiveTasks: 16,
        active: 10,
        free: 6,
        byClass: {
          working: 6,
          finishedAwaitingAck: 0,
          hungSuspect: 4,
          launching: 0,
        },
        effectiveWorking: 6,
        phantomActive: 4,
        utilizationPct: 62.5,
        effectiveUtilizationPct: 37.5,
      },
      hungSuspectTtlReclaim: {
        reclaimedTotal: 0,
        reclaimAttempted: 0,
        reclaimSucceeded: 0,
        skippedNoLiveness: 0,
        skippedOpenPrFailsafe: 12,
        skippedOpenPrConfirmed: 8,
        skippedOpenPrUnknown: 4,
        skippedUnderTtl: 3,
        skippedExemptAnomaly: 0,
        skippedProviderPaused: 5,
        lastCandidatesConsidered: 4,
        lastOutcomes: [
          { taskId: 'a', outcome: 'skipped_open_pr_failsafe' },
          { taskId: 'b', outcome: 'skipped_open_pr_failsafe' },
        ],
        lastAttemptedTaskIds: ['x'],
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([0]);
    expect(envelope.details.hungSuspectTtlReclaim).toEqual({
      reclaimedTotal: 0,
      reclaimAttempted: 0,
      skippedNoLiveness: 0,
      skippedOpenPrFailsafe: 12,
      skippedOpenPrConfirmed: 8,
      skippedOpenPrUnknown: 4,
      skippedUnderTtl: 3,
      skippedExemptAnomaly: 0,
      skippedProviderPaused: 5,
      lastCandidatesConsidered: 4,
      hungSuspect: 4,
      residualClasses: { skipped_open_pr_failsafe: 2 },
    });
    expect(envelope.details.hungSuspectTtlReclaim.lastAttemptedTaskIds).toBeUndefined();
  });

  it('omits details.hungSuspectTtlReclaim in --json when reclaiming or gauges zero (issue #2229)', async () => {
    mockSuccessfulFetch([], {
      hungSuspectTtlReclaim: {
        reclaimedTotal: 2,
        reclaimAttempted: 2,
        skippedOpenPrFailsafe: 100,
        lastCandidatesConsidered: 1,
      },
    });

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(envelope.details.hungSuspectTtlReclaim).toBeUndefined();
  });

  it('keeps default status exit behavior at zero even with active findings', async () => {
    mockSuccessfulFetch([
      {
        agentId: 'a1',
        taskName: 't1',
        taskStatus: 'inProgress',
        anomaly: { type: 'stale_agent', severity: 'critical', explanation: 'idle' },
      },
    ]);

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main(deps);
    expect(deps.exits).toEqual([]);
    expect(deps.logs[0]).toContain('Findings (1: 1 critical)');
  });

  it('exits 5 when --fail-on threshold is met', async () => {
    mockSuccessfulFetch([
      {
        agentId: 'a1',
        taskName: 't1',
        taskStatus: 'inProgress',
        anomaly: { type: 'stale_agent', severity: 'warning', explanation: 'idle' },
      },
    ]);

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--fail-on', 'warning'] });
    expect(deps.exits).toEqual([5]);
    expect(deps.logs[0]).toContain('Findings (1: 1 warning)');
  });

  it('does not exit non-zero when --fail-on threshold is not met', async () => {
    mockSuccessfulFetch([
      {
        agentId: 'a1',
        taskName: 't1',
        taskStatus: 'inProgress',
        anomaly: { type: 'stale_agent', severity: 'warning', explanation: 'idle' },
      },
    ]);

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--fail-on=critical'] });
    expect(deps.exits).toEqual([]);
    expect(deps.logs[0]).toContain('Findings (1: 1 warning)');
  });

  it('prints a JSON failure envelope when --fail-on threshold is met', async () => {
    mockSuccessfulFetch([
      {
        agentId: 'a1',
        taskName: 't1',
        taskStatus: 'inProgress',
        anomaly: { type: 'permission_blocked', severity: 'critical', explanation: 'blocked' },
      },
    ]);

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main({ ...deps, argv: ['--json', '--fail-on=critical'] });
    const envelope = parseSingleJsonLog(deps.logs);
    expect(deps.exits).toEqual([5]);
    expect(deps.errors).toEqual([]);
    expect(envelope).toMatchObject({
      ok: false,
      code: 'FINDINGS_PRESENT',
      details: {
        failOn: 'critical',
        highestSeverity: 'critical',
        summary: {
          severityCounts: { critical: 1, warning: 0, info: 0 },
        },
      },
    });
  });

  it('rejects a non-array /api/snapshot response', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const href = typeof url === 'string' ? url : url.href;
      if (href.endsWith('/api/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      return new Response(JSON.stringify({ not: 'an array' }), { status: 200 });
    }) as typeof fetch;

    const deps = makeDeps({ KOOKR_PORT: '4800' });
    await main(deps);
    expect(deps.exits).toEqual([1]);
    expect(deps.errors.join('\n')).toContain('Unexpected /api/snapshot response');
  });
});

describe('kookr-status resolvePort', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns explicit when KOOKR_PORT is a valid integer', async () => {
    const result = await resolvePort({ KOOKR_PORT: '4801' });
    expect(result).toEqual({ kind: 'explicit', port: 4801 });
  });

  it('returns invalid when KOOKR_PORT is garbage', async () => {
    const result = await resolvePort({ KOOKR_PORT: 'nope' });
    expect(result).toMatchObject({ kind: 'invalid', raw: 'nope' });
  });

  it('auto-detects 4800 first when nothing is set', async () => {
    const attempted: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const href = typeof url === 'string' ? url : url.href;
      attempted.push(href);
      if (href.includes(':4800/')) return new Response('{}', { status: 200 });
      throw new Error('nope');
    }) as typeof fetch;
    const result = await resolvePort({});
    expect(result).toEqual({ kind: 'auto', port: 4800 });
    expect(attempted[0]).toContain(':4800/');
  });

  it('falls through to 4801 when 4800 is down', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const href = typeof url === 'string' ? url : url.href;
      if (href.includes(':4801/')) return new Response('{}', { status: 200 });
      throw new Error('nope');
    }) as typeof fetch;
    const result = await resolvePort({});
    expect(result).toEqual({ kind: 'auto', port: 4801 });
  });

  it('returns none when both ports are unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('down')) as typeof fetch;
    const result = await resolvePort({});
    expect(result).toEqual({ kind: 'none' });
  });
});
