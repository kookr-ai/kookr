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
    // No pipelineStarvation / staleProcesses block on /api/health → no slim summary (no-op).
    expect(envelope.details.pipelineStarvation).toBeUndefined();
    expect(envelope.details.staleProcesses).toBeUndefined();
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
