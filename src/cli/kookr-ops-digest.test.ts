import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_NO_SERVER,
  EXIT_OK,
  EXIT_READY_FAIL,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  collectOpsDigestWarnings,
  formatOpsDigestHuman,
  parseOpsDigestArgs,
  runOpsDigestCli,
  type OpsDigestSnapshot,
} from './kookr-ops-digest.js';

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    out: { log: (msg?: unknown) => logs.push(String(msg ?? '')) },
    err: { error: (msg?: unknown) => errors.push(String(msg ?? '')) },
    logs,
    errors,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status });
}

const HEALTH_WITH_WARNINGS = {
  status: 'ok',
  serverStartedAt: '2026-08-12T00:00:00.000Z',
  sha: 'abcdef0123456789',
  resourceWatchdog: {
    enabled: false,
    pressureWhileDisabled: true,
    pressureWhileDisabledReason: 'staleProcesses.dtach.count=35 ≥ soft bound 20',
  },
  capacity: {
    active: 15,
    maxActiveTasks: 16,
    free: 1,
    phantomActive: 5,
    byClass: { working: 10, finishedAwaitingAck: 1, hungSuspect: 4, launching: 0 },
  },
  safeMode: { engaged: false },
  pipelineStarvation: {
    schemaVersion: 'pipeline-starvation.v1',
    repos: {
      'kookr-ai/kookr': {
        repo: 'kookr-ai/kookr',
        consecutiveBlockedEmpty: 10,
      },
    },
  },
  dataDirectoryFreePercent: 4.2,
};

const READY_OK = {
  ready: true,
  checks: {
    startup: { critical: true, ready: true, status: 'ready' },
  },
};

const READY_FAIL = {
  ready: false,
  checks: {
    startup: { critical: true, ready: false, status: 'recovering' },
    persistence: { critical: true, ready: true, status: 'ok' },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseOpsDigestArgs', () => {
  it('parses digest with optional --json', () => {
    expect(parseOpsDigestArgs(['digest'])).toEqual({
      verb: 'digest',
      json: false,
      help: false,
    });
    expect(parseOpsDigestArgs(['digest', '--json'])).toEqual({
      verb: 'digest',
      json: true,
      help: false,
    });
    expect(parseOpsDigestArgs(['--json', 'digest'])).toEqual({
      verb: 'digest',
      json: true,
      help: false,
    });
  });

  it('parses --help', () => {
    expect(parseOpsDigestArgs(['--help']).help).toBe(true);
    expect(parseOpsDigestArgs(['-h', 'digest']).help).toBe(true);
  });

  it('rejects unknown options and verbs', () => {
    expect(parseOpsDigestArgs(['digest', '--nope']).error).toMatch(/unknown option/);
    expect(parseOpsDigestArgs(['list']).error).toMatch(/unknown verb/);
    expect(parseOpsDigestArgs(['digest', 'extra']).error).toMatch(/unexpected argument/);
  });
});

describe('collectOpsDigestWarnings', () => {
  it('includes pressureWhileDisabled and phantomActive with field paths', () => {
    const { warnings, signals } = collectOpsDigestWarnings(HEALTH_WITH_WARNINGS);
    expect(signals.pressureWhileDisabled).toBe(true);
    expect(signals.phantomActive).toBe(5);
    const paths = warnings.map((w) => w.path);
    expect(paths).toContain('resourceWatchdog.pressureWhileDisabled');
    expect(paths).toContain('capacity.phantomActive');
    expect(paths).toContain('capacity.byClass.hungSuspect');
    expect(paths).toContain(
      'pipelineStarvation.repos.kookr-ai/kookr.consecutiveBlockedEmpty',
    );
    expect(paths).toContain('dataDirectory.diskFreePercent');
    expect(warnings.length).toBeLessThanOrEqual(5);
  });

  it('stays quiet when signals are healthy/absent', () => {
    const { warnings, signals } = collectOpsDigestWarnings({
      status: 'ok',
      resourceWatchdog: { enabled: true, pressureWhileDisabled: false },
      capacity: { phantomActive: 0, byClass: { hungSuspect: 0 } },
      safeMode: { engaged: false },
    });
    expect(warnings).toEqual([]);
    expect(signals.pressureWhileDisabled).toBe(false);
    expect(signals.phantomActive).toBe(0);
  });

  it('surfaces safeMode when engaged', () => {
    const { warnings } = collectOpsDigestWarnings({
      safeMode: { engaged: true, since: '2026-08-01T00:00:00.000Z' },
    });
    expect(warnings[0]?.path).toBe('safeMode.engaged');
    expect(warnings[0]?.summary).toMatch(/since=/);
  });
});

describe('formatOpsDigestHuman', () => {
  it('stays within 20 lines and names required field paths', () => {
    const collected = collectOpsDigestWarnings(HEALTH_WITH_WARNINGS);
    const snap: OpsDigestSnapshot = {
      baseUrl: 'http://127.0.0.1:4800',
      ready: true,
      readyHttpStatus: 200,
      failingCritical: [],
      warnings: collected.warnings,
      signals: collected.signals,
      serverStartedAt: collected.serverStartedAt,
      sha: collected.sha,
    };
    const text = formatOpsDigestHuman(snap);
    const lines = text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(text).toMatch(/ready: yes/);
    expect(text).toContain('resourceWatchdog.pressureWhileDisabled');
    expect(text).toContain('capacity.phantomActive');
  });
});

describe('runOpsDigestCli', () => {
  it('prints help and returns 0', async () => {
    const c = captureConsole();
    const code = await runOpsDigestCli(['--help'], { env: {}, out: c.out, err: c.err });
    expect(code).toBe(EXIT_OK);
    expect(c.logs.join('\n')).toMatch(/kookr ops digest/);
  });

  it('returns 2 when the verb is missing', async () => {
    const c = captureConsole();
    const code = await runOpsDigestCli([], { env: {}, out: c.out, err: c.err });
    expect(code).toBe(EXIT_USER_ERROR);
    expect(c.errors.join('\n')).toMatch(/verb is required/);
  });

  it('returns 2 on invalid KOOKR_PORT', async () => {
    const c = captureConsole();
    const code = await runOpsDigestCli(['digest'], {
      env: { KOOKR_PORT: 'nope' },
      out: c.out,
      err: c.err,
    });
    expect(code).toBe(EXIT_USER_ERROR);
    expect(c.errors.join('\n')).toMatch(/KOOKR_PORT/);
  });

  it('returns 3 when no server is reachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const c = captureConsole();
    const code = await runOpsDigestCli(['digest'], {
      env: {},
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_NO_SERVER);
    expect(c.errors.join('\n')).toMatch(/no Kookr server reachable/);
  });

  it('exits 0 on healthy ready and prints required field paths', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/ready')) return jsonResponse(READY_OK, 200);
      if (url.endsWith('/api/health')) return jsonResponse(HEALTH_WITH_WARNINGS, 200);
      return jsonResponse({ error: 'not found' }, 404);
    });
    const c = captureConsole();
    const code = await runOpsDigestCli(['digest'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_OK);
    const text = c.logs.join('\n');
    expect(text).toMatch(/ready: yes/);
    expect(text).toContain('resourceWatchdog.pressureWhileDisabled');
    expect(text).toContain('capacity.phantomActive');
    // Both endpoints must be hit.
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith('/api/ready'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/api/health'))).toBe(true);
  });

  it('exits 1 on ready fail (HTTP 503)', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/ready')) return jsonResponse(READY_FAIL, 503);
      if (url.endsWith('/api/health')) return jsonResponse(HEALTH_WITH_WARNINGS, 200);
      return jsonResponse({ error: 'not found' }, 404);
    });
    const c = captureConsole();
    const code = await runOpsDigestCli(['digest'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_READY_FAIL);
    expect(c.logs.join('\n')).toMatch(/ready: NO/);
    expect(c.logs.join('\n')).toMatch(/failing critical: startup:recovering/);
  });

  it('prints a JSON envelope with --json', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/ready')) return jsonResponse(READY_OK, 200);
      if (url.endsWith('/api/health')) return jsonResponse(HEALTH_WITH_WARNINGS, 200);
      return jsonResponse({ error: 'not found' }, 404);
    });
    const c = captureConsole();
    const code = await runOpsDigestCli(['digest', '--json'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(c.logs[0]!);
    expect(payload.ok).toBe(true);
    expect(payload.code).toBe('OK');
    expect(payload.details.signals.pressureWhileDisabled).toBe(true);
    expect(payload.details.signals.phantomActive).toBe(5);
    expect(
      payload.details.warnings.some(
        (w: { path: string }) => w.path === 'resourceWatchdog.pressureWhileDisabled',
      ),
    ).toBe(true);
  });

  it('returns READY_FAIL code in JSON when ready is false', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/ready')) return jsonResponse(READY_FAIL, 503);
      if (url.endsWith('/api/health')) return jsonResponse({ status: 'ok' }, 200);
      return jsonResponse({ error: 'not found' }, 404);
    });
    const c = captureConsole();
    const code = await runOpsDigestCli(['digest', '--json'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_READY_FAIL);
    const payload = JSON.parse(c.logs[0]!);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('READY_FAIL');
  });

  it('attaches KOOKR_API_TOKEN as Bearer auth', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/ready')) return jsonResponse(READY_OK, 200);
      if (url.endsWith('/api/health')) return jsonResponse({ status: 'ok' }, 200);
      return jsonResponse({ error: 'not found' }, 404);
    });
    const c = captureConsole();
    await runOpsDigestCli(['digest'], {
      env: {
        KOOKR_API_BASE_URL: 'http://127.0.0.1:4800',
        KOOKR_API_TOKEN: '  secret  ',
      },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer secret');
    }
  });

  it('returns 4 when health is non-2xx', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/ready')) return jsonResponse(READY_OK, 200);
      if (url.endsWith('/api/health')) return jsonResponse({ error: 'boom' }, 500);
      return jsonResponse({ error: 'not found' }, 404);
    });
    const c = captureConsole();
    const code = await runOpsDigestCli(['digest'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_SERVER_ERROR);
    expect(c.errors.join('\n')).toMatch(/HTTP 500/);
  });
});
