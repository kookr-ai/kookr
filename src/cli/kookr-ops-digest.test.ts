import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EXIT_NO_SERVER,
  EXIT_NO_SNAPSHOT,
  EXIT_OK,
  EXIT_READY_FAIL,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  OPS_TIMERS_TIMEOUT_MS,
  collectOpsDigestWarnings,
  formatOpsDigestHuman,
  formatOpsDigestOffline,
  formatOpsTimersHuman,
  loadOfflineSnapshot,
  parseOpsDigestArgs,
  parseTimerHealthBody,
  resolveOpsKookrDirs,
  runOpsDigestCli,
  type OpsDigestSnapshot,
} from './kookr-ops-digest.js';
import { LastGoodHealthWriter, type LastGoodHealthRead } from '../server/last-good-health.js';

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
      offline: false,
      help: false,
    });
    expect(parseOpsDigestArgs(['digest', '--json'])).toEqual({
      verb: 'digest',
      json: true,
      offline: false,
      help: false,
    });
    expect(parseOpsDigestArgs(['--json', 'digest'])).toEqual({
      verb: 'digest',
      json: true,
      offline: false,
      help: false,
    });
  });

  it('parses timers with optional --json', () => {
    expect(parseOpsDigestArgs(['timers'])).toEqual({
      verb: 'timers',
      json: false,
      offline: false,
      help: false,
    });
    expect(parseOpsDigestArgs(['timers', '--json'])).toEqual({
      verb: 'timers',
      json: true,
      offline: false,
      help: false,
    });
    expect(parseOpsDigestArgs(['--json', 'timers'])).toEqual({
      verb: 'timers',
      json: true,
      offline: false,
      help: false,
    });
  });

  it('parses --offline', () => {
    expect(parseOpsDigestArgs(['digest', '--offline']).offline).toBe(true);
    expect(parseOpsDigestArgs(['digest']).offline).toBe(false);
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

  it('surfaces helper-LLM auth pauses without raw error bodies (issue #2641)', () => {
    const { warnings } = collectOpsDigestWarnings({
      helperLlm: {
        paused: [
          {
            provider: 'groq',
            model: 'llama-3.3-70b-versatile',
            category: 'auth',
            pausedUntil: '2026-08-18T02:22:00.000Z',
            lastMessage: 'invalid api key',
            apiKey: 'sk-live-not-a-real-key',
          },
        ],
        stormsSuppressed: 2,
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe('helperLlm.paused');
    expect(warnings[0]?.summary).toContain('groq category=auth');
    expect(warnings[0]?.summary).toContain('until=2026-08-18T02:22:00.000Z');
    expect(warnings[0]?.summary).toContain('stormsSuppressed=2');
    expect(JSON.stringify(warnings[0])).not.toMatch(/sk-live|invalid api key/i);
    expect(warnings[0]?.value).not.toHaveProperty('lastMessage');
    expect(warnings[0]?.value).not.toHaveProperty('apiKey');
  });

  it('surfaces stormsSuppressed alone when no provider is paused', () => {
    const { warnings } = collectOpsDigestWarnings({
      helperLlm: { paused: [], stormsSuppressed: 7 },
    });
    expect(warnings[0]?.path).toBe('helperLlm.stormsSuppressed');
    expect(warnings[0]?.summary).toBe('stormsSuppressed=7');
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
      // Hermetic: no on-disk snapshot ⇒ the offline degrade is a no-op here.
      offlineLoader: () => null,
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
      // Hermetic: no on-disk snapshot ⇒ the offline degrade is a no-op here.
      offlineLoader: () => null,
    });
    expect(code).toBe(EXIT_SERVER_ERROR);
    expect(c.errors.join('\n')).toMatch(/HTTP 500/);
  });
});

describe('kookr ops digest offline last-good (issue #2495)', () => {
  function fakeRead(overrides: Partial<LastGoodHealthRead> = {}): LastGoodHealthRead {
    return {
      path: '/tmp/kookr-test/.kookr/last-good-health.json',
      mtimeMs: 1_000_000,
      ageMs: 42_000,
      snapshot: {
        schemaVersion: 'last-good-health.v1',
        capturedAt: '2026-08-17T00:00:00.000Z',
        truncated: false,
        health: HEALTH_WITH_WARNINGS,
      },
      ...overrides,
    };
  }

  describe('resolveOpsKookrDirs (explicit config is authoritative)', () => {
    it('returns only KOOKR_DIR when set', () => {
      expect(resolveOpsKookrDirs({ KOOKR_DIR: '/custom', HOME: '/h', KOOKR_PORT: '4800' }))
        .toEqual(['/custom']);
    });
    it('returns only the port-derived dir when KOOKR_PORT is set', () => {
      expect(resolveOpsKookrDirs({ HOME: '/h', KOOKR_PORT: '4800' })).toEqual(['/h/.kookr']);
      expect(resolveOpsKookrDirs({ HOME: '/h', KOOKR_PORT: '4802' })).toEqual(['/h/.kookr-4802']);
    });
    it('probes both default-port dirs in the fully-auto case', () => {
      expect(resolveOpsKookrDirs({ HOME: '/h' })).toEqual(['/h/.kookr', '/h/.kookr-4801']);
    });
    it('yields no candidate for an invalid KOOKR_PORT', () => {
      expect(resolveOpsKookrDirs({ HOME: '/h', KOOKR_PORT: 'nope' })).toEqual([]);
    });
  });

  describe('loadOfflineSnapshot picks the freshest across candidate dirs', () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ops-offline-')); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    it('selects the newest last-good-health.json by mtime', () => {
      const older = join(root, '.kookr');
      const newer = join(root, '.kookr-4801');
      new LastGoodHealthWriter({ kookrDir: older, now: () => 1 }).record({ status: 'old', agents: 1 });
      new LastGoodHealthWriter({ kookrDir: newer, now: () => 2 }).record({ status: 'new', agents: 2 });
      // Force the newer dir's file to have a later mtime.
      utimesSync(join(older, 'last-good-health.json'), 1000, 1000);
      utimesSync(join(newer, 'last-good-health.json'), 2000, 2000);
      const read = loadOfflineSnapshot({ HOME: root }, 3_000_000);
      expect(read).not.toBeNull();
      expect(read!.snapshot.health.status).toBe('new');
    });

    it('returns null when no snapshot exists', () => {
      expect(loadOfflineSnapshot({ HOME: root }, 1000)).toBeNull();
    });
  });

  it('formatOpsDigestOffline reports staleness and reuses the live warning set', () => {
    const text = formatOpsDigestOffline(fakeRead());
    expect(text).toContain('offline');
    expect(text).toContain('stale');
    expect(text).toContain('captured=2026-08-17T00:00:00.000Z');
    // Same signal paths the live digest would surface.
    expect(text).toContain('resourceWatchdog.pressureWhileDisabled');
    expect(text).toContain('capacity.phantomActive');
  });

  it('--offline prints the snapshot and exits 0', async () => {
    const cap = captureConsole();
    const code = await runOpsDigestCli(['digest', '--offline'], {
      ...cap,
      env: {},
      offlineLoader: () => fakeRead(),
      nowMs: () => 5,
    });
    expect(code).toBe(EXIT_OK);
    expect(cap.logs.join('\n')).toContain('offline');
    expect(cap.errors).toEqual([]);
  });

  it('--offline --json emits an OFFLINE_SNAPSHOT envelope', async () => {
    const cap = captureConsole();
    const code = await runOpsDigestCli(['digest', '--offline', '--json'], {
      ...cap,
      env: {},
      offlineLoader: () => fakeRead(),
    });
    expect(code).toBe(EXIT_OK);
    const env = JSON.parse(cap.logs[0]!);
    expect(env).toMatchObject({
      ok: true,
      code: 'OFFLINE_SNAPSHOT',
      details: { offline: { ageMs: 42_000 } },
    });
  });

  it('--offline exits EXIT_NO_SNAPSHOT when none is on disk', async () => {
    const cap = captureConsole();
    const code = await runOpsDigestCli(['digest', '--offline', '--json'], {
      ...cap,
      env: { HOME: '/nope' },
      offlineLoader: () => null,
    });
    expect(code).toBe(EXIT_NO_SNAPSHOT);
    const env = JSON.parse(cap.logs[0]!);
    expect(env).toMatchObject({ ok: false, code: 'NO_SNAPSHOT' });
    expect(env.details.dirs).toEqual(['/nope/.kookr', '/nope/.kookr-4801']);
  });

  it('auto-degrades to the snapshot when no server is reachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const cap = captureConsole();
    const code = await runOpsDigestCli(['digest'], {
      ...cap,
      env: {},
      offlineLoader: () => fakeRead(),
    });
    expect(code).toBe(EXIT_NO_SERVER);
    expect(cap.errors.join('\n')).toContain('no Kookr server reachable');
    expect(cap.logs.join('\n')).toContain('offline');
  });

  it('auto-degrade surfaces the snapshot in the --json NO_SERVER envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const cap = captureConsole();
    const code = await runOpsDigestCli(['digest', '--json'], {
      ...cap,
      env: {},
      offlineLoader: () => fakeRead(),
    });
    expect(code).toBe(EXIT_NO_SERVER);
    const env = JSON.parse(cap.logs[0]!);
    expect(env).toMatchObject({ code: 'NO_SERVER', details: { offline: { ageMs: 42_000 } } });
  });

  it('does not degrade when the server is reachable (offline loader untouched)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const href = typeof url === 'string' ? url : url.href;
      if (href.endsWith('/api/ready')) return jsonResponse(READY_OK, 200);
      return jsonResponse(HEALTH_WITH_WARNINGS, 200);
    }));
    const cap = captureConsole();
    const loader = vi.fn(() => fakeRead());
    const code = await runOpsDigestCli(['digest', '--json'], {
      ...cap,
      env: { KOOKR_PORT: '4800' },
      offlineLoader: loader,
    });
    expect(code).toBe(EXIT_OK);
    expect(loader).not.toHaveBeenCalled();
  });
});

const TIMER_HEALTH_BODY = {
  schemaVersion: 'timer-health.v1',
  generatedAt: '2026-08-18T12:00:00.000Z',
  loops: [
    {
      name: 'maintenancePrune',
      lastFiredAt: null,
      expectedIntervalMs: 3_600_000,
      overdue: true,
    },
    {
      name: 'save',
      lastFiredAt: '2026-08-18T11:59:00.000Z',
      expectedIntervalMs: 30_000,
      overdue: false,
    },
  ],
};

describe('kookr ops timers (issue #2639)', () => {
  it('prints every registered loop with last-fired or never and overdue', () => {
    const snap = parseTimerHealthBody(TIMER_HEALTH_BODY);
    expect(snap).not.toBeNull();
    const text = formatOpsTimersHuman(snap!);
    expect(text).toContain('maintenancePrune  last=never  interval=3600000ms  overdue=true');
    expect(text).toContain(
      'save  last=2026-08-18T11:59:00.000Z  interval=30000ms  overdue=false',
    );
    expect(text).not.toMatch(/tokenScan|watchdog|liveness/);
  });

  it('does not invent loop names the server omitted', () => {
    const snap = parseTimerHealthBody({
      schemaVersion: 'timer-health.v1',
      generatedAt: '2026-08-18T12:00:00.000Z',
      loops: [
        { name: 'save', lastFiredAt: null, expectedIntervalMs: 30_000, overdue: false },
      ],
    });
    expect(snap?.loops.map((l) => l.name)).toEqual(['save']);
    expect(formatOpsTimersHuman(snap!)).not.toMatch(
      /tokenScan|watchdog|maintenancePrune/,
    );
  });

  it('drops nameless rows instead of filling them in', () => {
    const snap = parseTimerHealthBody({
      loops: [
        { lastFiredAt: null, expectedIntervalMs: 1, overdue: true },
        { name: 'save', lastFiredAt: null, expectedIntervalMs: 1, overdue: false },
      ],
    });
    expect(snap?.loops.map((l) => l.name)).toEqual(['save']);
    expect(snap?.overdue).toEqual([]);
  });

  it('prints the live table via GET /api/diagnostics/timer-health', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/diagnostics/timer-health')) {
        return jsonResponse(TIMER_HEALTH_BODY, 200);
      }
      return jsonResponse({ error: 'not found' }, 404);
    });
    const c = captureConsole();
    const code = await runOpsDigestCli(['timers'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_OK);
    const text = c.logs.join('\n');
    expect(text).toContain(
      'timers  loops=2  overdue=1  generated=2026-08-18T12:00:00.000Z',
    );
    expect(text).toContain(
      'maintenancePrune  last=never  interval=3600000ms  overdue=true',
    );
    expect(text).toContain(
      'save  last=2026-08-18T11:59:00.000Z  interval=30000ms  overdue=false',
    );
    const loopNames = text
      .split('\n')
      .slice(1)
      .map((line) => line.split(/\s+/)[0]);
    expect(loopNames).toEqual(['maintenancePrune', 'save']);
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      'http://127.0.0.1:4800/api/diagnostics/timer-health',
    ]);
  });

  it('--json returns the timer-health document plus a computed overdue list', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(TIMER_HEALTH_BODY, 200));
    const c = captureConsole();
    const code = await runOpsDigestCli(['timers', '--json'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(c.logs[0]!);
    expect(payload.ok).toBe(true);
    expect(payload.code).toBe('OK');
    expect(payload.details.schemaVersion).toBe('timer-health.v1');
    expect(payload.details.generatedAt).toBe('2026-08-18T12:00:00.000Z');
    expect(payload.details.loops).toEqual(TIMER_HEALTH_BODY.loops);
    expect(payload.details.overdue).toEqual(['maintenancePrune']);
  });

  it('uses a 5-second fetch timeout and exits non-zero on abort', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          throw Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
          });
        }
        return jsonResponse(TIMER_HEALTH_BODY, 200);
      });
      timeoutSpy.mockReturnValue(AbortSignal.abort());
      const c = captureConsole();
      const code = await runOpsDigestCli(['timers'], {
        env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out: c.out,
        err: c.err,
        fetchImpl: fetchImpl as typeof fetch,
      });
      expect(timeoutSpy).toHaveBeenCalledWith(OPS_TIMERS_TIMEOUT_MS);
      expect(OPS_TIMERS_TIMEOUT_MS).toBe(5_000);
      expect(code).toBe(EXIT_NO_SERVER);
      expect(c.errors.join('\n')).toMatch(/no Kookr server reachable/);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('returns 3 when no server is reachable and does not print invented loops', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const c = captureConsole();
    const code = await runOpsDigestCli(['timers'], {
      env: {},
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
      offlineLoader: () => ({
        path: '/tmp/last-good-health.json',
        mtimeMs: 1,
        ageMs: 1,
        snapshot: {
          schemaVersion: 'last-good-health.v1',
          capturedAt: '2026-08-17T00:00:00.000Z',
          truncated: false,
          health: HEALTH_WITH_WARNINGS,
        },
      }),
    });
    expect(code).toBe(EXIT_NO_SERVER);
    expect(c.logs).toEqual([]);
    expect(c.errors.join('\n')).toMatch(/no Kookr server reachable/);
    expect(c.errors.join('\n') + c.logs.join('\n')).not.toMatch(
      /offline|last-good|ready:/,
    );
  });

  it('prints (none registered) when the server reports an empty loop list', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { schemaVersion: 'timer-health.v1', generatedAt: '2026-08-18T12:00:00.000Z', loops: [] },
        200,
      ),
    );
    const c = captureConsole();
    const code = await runOpsDigestCli(['timers'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_OK);
    expect(c.logs.join('\n')).toContain('(none registered)');
    expect(c.logs.join('\n')).not.toMatch(/tokenScan|watchdog|maintenancePrune/);
  });

  it('returns 4 when timer-health is not a loops document', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: 'ok' }, 200));
    const c = captureConsole();
    const code = await runOpsDigestCli(['timers', '--json'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_SERVER_ERROR);
    const payload = JSON.parse(c.logs[0]!);
    expect(payload).toMatchObject({ ok: false, code: 'SERVER_ERROR' });
    expect(payload.message).toMatch(/unexpected timer-health payload/);
  });

  it('returns 4 when timer-health is non-2xx', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'boom' }, 500));
    const c = captureConsole();
    const code = await runOpsDigestCli(['timers'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_SERVER_ERROR);
    expect(c.errors.join('\n')).toMatch(/HTTP 500/);
  });

  it('rejects --offline for timers', async () => {
    const c = captureConsole();
    const code = await runOpsDigestCli(['timers', '--offline', '--json'], {
      env: {},
      out: c.out,
      err: c.err,
    });
    expect(code).toBe(EXIT_USER_ERROR);
    const payload = JSON.parse(c.logs[0]!);
    expect(payload).toMatchObject({
      ok: false,
      code: 'USER_ERROR',
      message: '--offline is not supported for timers',
    });
  });

  it('attaches KOOKR_API_TOKEN as Bearer auth', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(TIMER_HEALTH_BODY, 200));
    const c = captureConsole();
    await runOpsDigestCli(['timers'], {
      env: {
        KOOKR_API_BASE_URL: 'http://127.0.0.1:4800',
        KOOKR_API_TOKEN: '  secret  ',
      },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret');
  });
});
