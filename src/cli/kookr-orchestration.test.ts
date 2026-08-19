import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  EXIT_OK,
  EXIT_USER_ERROR,
  EXIT_NO_SERVER,
  EXIT_SERVER_ERROR,
  formatOrchestrationStatusLine,
  parseOrchestrationArgs,
  runOrchestrationCli,
} from './kookr-orchestration.js';

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    out: { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) },
    err: { error: (...a: unknown[]) => errors.push(a.map(String).join(' ')) },
    logs,
    errors,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const BASE_ENV = { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' } as NodeJS.ProcessEnv;

afterEach(() => vi.restoreAllMocks());

describe('parseOrchestrationArgs', () => {
  it('parses verbs', () => {
    expect(parseOrchestrationArgs(['status']).verb).toBe('status');
    expect(parseOrchestrationArgs(['pause']).verb).toBe('pause');
    expect(parseOrchestrationArgs(['resume']).verb).toBe('resume');
  });

  it('parses pause flags', () => {
    const a = parseOrchestrationArgs(['pause', '--reason', 'quota reset', '--by', 'jean', '--source', 'soft-quota']);
    expect(a.reason).toBe('quota reset');
    expect(a.by).toBe('jean');
    expect(a.source).toBe('soft-quota');
  });

  it('parses --flag=value form', () => {
    const a = parseOrchestrationArgs(['pause', '--reason=hold', '--source=human']);
    expect(a.reason).toBe('hold');
    expect(a.source).toBe('human');
  });

  it('rejects an invalid --source', () => {
    expect(parseOrchestrationArgs(['pause', '--source', 'bogus']).error).toMatch(/--source must be/);
  });

  it('rejects a missing flag value', () => {
    expect(parseOrchestrationArgs(['pause', '--reason']).error).toMatch(/requires a value/);
  });

  it('rejects an unknown verb', () => {
    expect(parseOrchestrationArgs(['frobnicate']).error).toMatch(/unknown verb/);
  });

  it('parses --auto for resume', () => {
    expect(parseOrchestrationArgs(['resume', '--auto']).auto).toBe(true);
  });
});

describe('formatOrchestrationStatusLine', () => {
  it('summarizes a paused status', () => {
    const line = formatOrchestrationStatusLine({
      paused: true,
      pause: { source: 'human', pausedAt: '2026-08-18T08:05:04Z', pausedBy: 'jean', reason: 'hold' },
      quota: { agentType: 'grok-build', supported: false },
    });
    expect(line).toContain('PAUSED');
    expect(line).toContain('source=human');
    expect(line).toContain('by=jean');
    expect(line).toContain('quota[grok-build]=unsupported');
  });

  it('summarizes a running status with a supported quota sample', () => {
    const line = formatOrchestrationStatusLine({
      paused: false,
      quota: { agentType: 'claude-code', supported: true, utilization: 42 },
      recommendation: { action: 'none' },
    });
    expect(line).toContain('running');
    expect(line).toContain('quota[claude-code]=42%');
  });
});

describe('runOrchestrationCli', () => {
  it('requires a verb', async () => {
    const io = captureConsole();
    const code = await runOrchestrationCli([], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl: vi.fn() });
    expect(code).toBe(EXIT_USER_ERROR);
  });

  it('prints help', async () => {
    const io = captureConsole();
    const code = await runOrchestrationCli(['--help'], { env: BASE_ENV, out: io.out, err: io.err });
    expect(code).toBe(EXIT_OK);
    expect(io.logs.join('\n')).toContain('kookr orchestration');
  });

  it('POSTs pause with the reason/source and prints the result', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({ reason: 'quota', source: 'soft-quota' });
      return jsonResponse({ paused: true, pause: { source: 'soft-quota', pausedBy: 'orchestrator' } });
    }) as unknown as typeof fetch;

    const code = await runOrchestrationCli(
      ['pause', '--reason', 'quota', '--source', 'soft-quota'],
      { env: BASE_ENV, out: io.out, err: io.err, fetchImpl },
    );
    expect(code).toBe(EXIT_OK);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4800/api/orchestration/pause',
      expect.anything(),
    );
    expect(io.logs.join('\n')).toContain('Orchestration paused');
  });

  it('GETs status', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:4800/api/orchestration/status');
      expect(init?.method).toBe('GET');
      return jsonResponse({ paused: false, quota: { agentType: 'claude-code', supported: true, utilization: 10 } });
    }) as unknown as typeof fetch;

    const code = await runOrchestrationCli(['status'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl });
    expect(code).toBe(EXIT_OK);
    expect(io.logs.join('\n')).toContain('running');
  });

  it('emits --json passthrough of the server body', async () => {
    const io = captureConsole();
    const body = { paused: true, pause: { source: 'human' } };
    const fetchImpl = vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch;
    const code = await runOrchestrationCli(['status', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl });
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(io.logs[0])).toEqual(body);
  });

  it('surfaces a server error as EXIT_SERVER_ERROR', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'Orchestration control not configured' }, 500)) as unknown as typeof fetch;
    const code = await runOrchestrationCli(['status'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl });
    expect(code).toBe(EXIT_SERVER_ERROR);
    expect(io.errors.join('\n')).toContain('not configured');
  });

  it('reports no server reachable', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const code = await runOrchestrationCli(['status'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl });
    expect(code).toBe(EXIT_NO_SERVER);
  });

  it('rejects --source on resume (user error, no request sent)', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn();
    const code = await runOrchestrationCli(['resume', '--source', 'human'], {
      env: BASE_ENV, out: io.out, err: io.err, fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(code).toBe(EXIT_USER_ERROR);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
