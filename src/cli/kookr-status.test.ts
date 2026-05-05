import { describe, it, expect, vi, afterEach } from 'vitest';
// The CLI ships as a plain ESM .js file in bin/ (same pattern as bin/kookr.js)
// so it runs without a build step. Types come from bin/kookr-status.d.ts.
import {
  formatUptime,
  formatCost,
  summarize,
  renderReport,
  parsePortEnv,
  resolvePort,
  main,
} from '../../bin/kookr-status.js';

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

  it('errors out cleanly when KOOKR_PORT is not a valid integer', async () => {
    const deps = makeDeps({ KOOKR_PORT: 'abc' });
    await main(deps);
    expect(deps.exits).toEqual([1]);
    expect(deps.errors.join('\n')).toContain('KOOKR_PORT must be an integer');
    expect(deps.logs).toEqual([]);
  });

  it('errors out with "not running" when auto-detect finds no server', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof fetch;
    const deps = makeDeps({});
    await main(deps);
    expect(deps.exits).toEqual([1]);
    expect(deps.errors.join('\n')).toContain('Kookr is not running on ports 4800, 4801');
    expect(deps.logs).toEqual([]);
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
    const healthBody = {
      status: 'ok',
      serverStartedAt: new Date(Date.now() - 60_000).toISOString(),
      build: { version: 'dev' },
    };
    const snapshotBody = [
      {
        agentId: 'a1',
        taskName: 't1',
        taskStatus: 'inProgress',
        tokenUsage: { costUsd: 0.5 },
        anomaly: null,
      },
    ];
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
