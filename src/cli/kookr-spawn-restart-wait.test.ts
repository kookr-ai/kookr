// Issue #3928: `kookr spawn` waits through a planned server restart.
//
// When no server answers, spawn reads the deploy script's planned-restart note
// (bin/kookr-restart-intent.js). While the note is fresh it keeps probing and
// launches once the server is back; when the note goes stale or the caller's
// limit passes it exits 3 and writes one operator alert naming the lost launch.
// With no note, nothing changes.
//
// Every test injects the note lookup and a fake clock, and points HOME and the
// operator-signal folder at a temp dir, so a live deploy on this host can
// neither make these tests wait nor receive their alerts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer, type Server } from 'node:http';
import {
  EXIT_NO_SERVER,
  EXIT_OK,
  EXIT_USER_ERROR,
  main,
  parseArgs,
  parseRestartWaitSeconds,
  resolveBaseUrl,
  UsageError,
  type RestartIntentRecord,
} from '../../bin/kookr-spawn.js';
import { listSignalFiles, readSignal } from '../observability/signal-delivery/operator-signal.js';
import { resolveKookrDir, writeRestartIntent } from '../../bin/kookr-restart-intent.js';

const MIN = 60_000;

function note(ageMs: number, { reason = 'prod:update', staleAfterMs = 10 * MIN, clock = 0 } = {}): RestartIntentRecord {
  const startedAtMs = clock - ageMs;
  return {
    schemaVersion: 'restart-intent.v1',
    reason,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    initiator: 'prod-restart.sh',
    pid: 1234,
    staleAfterMs,
    host: 'test-host',
  };
}

/** A fake clock that only advances when spawn sleeps. */
function fakeClock(start = 0) {
  const state = { ms: start, sleeps: [] as number[] };
  return {
    state,
    now: () => state.ms,
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      state.ms += ms;
    },
  };
}

function ttyStdin() {
  const stream = Readable.from(Buffer.from([])) as NodeJS.ReadableStream & { isTTY?: boolean };
  stream.isTTY = true;
  return stream;
}

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      log: (m: string) => { logs.push(String(m)); },
      error: (m: string) => { errors.push(String(m)); },
    },
  };
}

function exitCapture() {
  const codes: number[] = [];
  return { codes, exit: ((c: number) => { codes.push(c); }) as (code: number) => never | void };
}

/** Health answers 503 until `isUp()`; POST /api/tasks creates a task. */
async function startRestartingServer(isUp: () => boolean) {
  const posts: unknown[] = [];
  let healthHits = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/api/health') {
        healthHits += 1;
        if (!isUp()) {
          res.writeHead(503);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ serverStartedAt: '2026-11-16T10:00:00.000Z' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/tasks') {
        posts.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'task-after-restart', agentType: 'claude-code', status: 'working' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    posts,
    healthHits: () => healthHits,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

let home: string;
let signalDir: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kookr-spawn-3928-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kookr-spawn-3928-cwd-'));
  signalDir = join(home, 'operator-signals');
  vi.stubEnv('HOME', home);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

/** Auto-detect fetch mock: 4800 recovers once `isUp()`; deploy/status is down. */
function mockAutoDetectFetch(isUp: () => boolean) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes(':4800/api/health') && isUp()) {
      return { ok: true, json: async () => ({ serverStartedAt: '2026-11-16T10:00:00.000Z' }) } as Response;
    }
    throw new Error('ECONNREFUSED');
  });
}

describe('resolveBaseUrl — auto-detect through a planned restart (#3928)', () => {
  it('keeps probing while the note is fresh and returns the server once it is back', async () => {
    const clock = fakeClock();
    // Note written 2 minutes before spawn started; server back 4 minutes in.
    const intent = note(2 * MIN);
    mockAutoDetectFetch(() => clock.now() >= 4 * MIN);
    const logs: string[] = [];
    const r = await resolveBaseUrl({
      env: {},
      sleep: clock.sleep,
      now: clock.now,
      log: (m) => logs.push(m),
      lookupRestartIntent: () => intent,
    });
    expect(r).toMatchObject({
      kind: 'auto',
      port: 4800,
      restartWait: { outcome: 'recovered', waitedMs: 4 * MIN, state: 'in-progress', reason: 'prod:update' },
    });
    // One progress line per 30 seconds of waiting (0s, 30s, … 210s), not one per probe.
    expect(logs).toHaveLength(8);
    expect(logs[0]).toBe('kookr spawn: Kookr is restarting, prod:update started 2m ago, waiting...');
    expect(logs[1]).toMatch(/started 2m 30s ago, waiting/);
    expect(clock.state.sleeps.every((ms) => ms === 3000)).toBe(true);
  });

  it('with no note keeps today\'s short retry and timing', async () => {
    const clock = fakeClock();
    mockAutoDetectFetch(() => false);
    const lookup = vi.fn(() => null);
    const logs: string[] = [];
    const r = await resolveBaseUrl({
      env: {},
      sleep: clock.sleep,
      now: clock.now,
      log: (m) => logs.push(m),
      lookupRestartIntent: lookup,
    });
    expect(r).toEqual({ kind: 'none', ports: [4800, 4801], attempts: 3 });
    expect(clock.state.sleeps).toEqual([3000, 3000]);
    expect(logs).toEqual([]);
    expect(lookup).toHaveBeenCalled();
  });

  it('a stale note stops the wait but keeps the short retry, and reports the failed deploy', async () => {
    const clock = fakeClock();
    mockAutoDetectFetch(() => false);
    const r = await resolveBaseUrl({
      env: {},
      sleep: clock.sleep,
      now: clock.now,
      log: () => {},
      lookupRestartIntent: () => note(11 * MIN),
    });
    expect(r).toMatchObject({ kind: 'none', attempts: 3, restartWait: { outcome: 'stale', state: 'stale' } });
    expect(clock.state.sleeps).toEqual([3000, 3000]);
  });

  it('stops at the note\'s own deadline when the server never comes back', async () => {
    const clock = fakeClock();
    mockAutoDetectFetch(() => false);
    const intent = note(8 * MIN); // stale 2 minutes from now
    const r = await resolveBaseUrl({
      env: {},
      sleep: clock.sleep,
      now: clock.now,
      log: () => {},
      lookupRestartIntent: () => intent,
    });
    expect(r).toMatchObject({ kind: 'none', restartWait: { outcome: 'stale' } });
    expect(clock.now()).toBeGreaterThan(2 * MIN);
    expect(clock.now()).toBeLessThanOrEqual(2 * MIN + 3000);
  });

  it('stops when the caller\'s limit passes before the note goes stale', async () => {
    const clock = fakeClock();
    mockAutoDetectFetch(() => false);
    const logs: string[] = [];
    const r = await resolveBaseUrl({
      env: {},
      sleep: clock.sleep,
      now: clock.now,
      log: (m) => logs.push(m),
      restartWaitLimitMs: 60_000,
      lookupRestartIntent: () => note(MIN),
    });
    expect(r).toMatchObject({ kind: 'none', restartWait: { outcome: 'limit_reached', waitedMs: 60_000 } });
    expect(logs[0]).toMatch(/waiting \(limit 1m\)\.\.\.$/);
  });

  it('gives one more probe when the note disappears, then stops without blaming a deploy', async () => {
    const clock = fakeClock();
    mockAutoDetectFetch(() => false);
    const intent = note(MIN);
    // The note is there for the first minute, then the deploy clears it.
    const r = await resolveBaseUrl({
      env: {},
      sleep: clock.sleep,
      now: clock.now,
      log: () => {},
      lookupRestartIntent: () => (clock.now() < MIN ? intent : null),
    });
    expect(r).toMatchObject({ kind: 'none', restartWait: { outcome: 'cleared' } });
    // First probe with no note, then exactly one extra probe.
    expect(clock.now()).toBe(MIN + 3000);
  });
});

describe('resolveBaseUrl — explicit base URL through a planned restart (#3928)', () => {
  it('with no note makes no extra request (KOOKR_PORT)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await resolveBaseUrl({ env: { KOOKR_PORT: '4821' }, lookupRestartIntent: () => null });
    expect(r).toEqual({ kind: 'explicit', baseUrl: 'http://127.0.0.1:4821' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores the note for a remote base URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const lookup = vi.fn(() => note(MIN));
    const r = await resolveBaseUrl({
      env: { KOOKR_API_BASE_URL: 'http://kookr.example.invalid:4800' },
      lookupRestartIntent: lookup,
    });
    expect(r).toEqual({ kind: 'explicit', baseUrl: 'http://kookr.example.invalid:4800' });
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores a note that is already stale: no extra request before the POST', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await resolveBaseUrl({
      env: { KOOKR_PORT: '4821' },
      lookupRestartIntent: () => note(11 * MIN, { clock: Date.now() }),
    });
    expect(r).toEqual({ kind: 'explicit', baseUrl: 'http://127.0.0.1:4821' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a healthy server wins over an in-progress note', async () => {
    const srv = await startRestartingServer(() => true);
    try {
      const r = await resolveBaseUrl({
        env: { KOOKR_API_BASE_URL: srv.baseUrl },
        lookupRestartIntent: () => note(MIN, { clock: Date.now() }),
      });
      expect(r).toEqual({ kind: 'explicit', baseUrl: srv.baseUrl });
      expect(srv.healthHits()).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it('reads the note for the explicit port and waits for /api/health', async () => {
    const clock = fakeClock();
    const srv = await startRestartingServer(() => clock.now() >= MIN);
    const ports: Array<number | null> = [];
    try {
      const r = await resolveBaseUrl({
        env: { KOOKR_API_BASE_URL: srv.baseUrl },
        sleep: clock.sleep,
        now: clock.now,
        log: () => {},
        lookupRestartIntent: ({ port }) => {
          ports.push(port);
          return note(MIN);
        },
      });
      expect(r).toMatchObject({ kind: 'explicit', baseUrl: srv.baseUrl, restartWait: { outcome: 'recovered', waitedMs: MIN } });
      expect(new Set(ports)).toEqual(new Set([srv.port]));
    } finally {
      await srv.close();
    }
  });
});

describe('resolveBaseUrl — the wait is opt-in (#3928)', () => {
  // `kookr signal` and `kookr issue` call resolveBaseUrl({ env, sleep }) and
  // must not inherit spawn's wait: a signal spools and exits 0 at once.
  it('ignores a note on disk unless the caller passes a lookup', async () => {
    writeRestartIntent({ kookrDir: resolveKookrDir({ port: 4899 }), reason: 'prod:update', staleAfterMs: 30 * MIN });
    const sleeps: number[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await resolveBaseUrl({
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4899' },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(r).toEqual({ kind: 'explicit', baseUrl: 'http://127.0.0.1:4899' });
    expect(sleeps).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('main — planned restart acceptance (#3928)', () => {
  it('reads the real note from disk by default', async () => {
    const clock = fakeClock(Date.now());
    const startedAt = clock.now();
    const srv = await startRestartingServer(() => clock.now() >= startedAt + MIN);
    // Written under the test's HOME, at the server's port, 30 seconds ago.
    writeRestartIntent({
      kookrDir: resolveKookrDir({ port: srv.port }),
      reason: 'prod:update',
      staleAfterMs: 30 * MIN,
      now: startedAt - 30_000,
    });
    try {
      const out = capture();
      const err = capture();
      const { codes, exit } = exitCapture();
      await main({
        argv: ['--json', 'hello'],
        env: { KOOKR_API_BASE_URL: srv.baseUrl, KOOKR_OPERATOR_SIGNAL_DIR: signalDir },
        stdin: ttyStdin(),
        cwd,
        out: out.io,
        err: err.io,
        exit,
        sleep: clock.sleep,
        now: clock.now,
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(srv.posts).toHaveLength(1);
      expect(JSON.parse(out.logs[0]).details.restartWait).toMatchObject({ outcome: 'recovered', waitedMs: MIN });
      expect(err.errors[0]).toMatch(/Kookr is restarting, prod:update started 30s ago, waiting/);
    } finally {
      await srv.close();
    }
  });


  it('note 2 minutes old, server back after 4 minutes: one task, exit 0, wait facts in --json', async () => {
    const clock = fakeClock();
    const srv = await startRestartingServer(() => clock.now() >= 4 * MIN);
    try {
      const out = capture();
      const err = capture();
      const { codes, exit } = exitCapture();
      await main({
        argv: ['--json', '--idempotency-key', 'feeder:issue-42', 'implement issue 42'],
        env: { KOOKR_API_BASE_URL: srv.baseUrl, KOOKR_OPERATOR_SIGNAL_DIR: signalDir },
        stdin: ttyStdin(),
        cwd,
        out: out.io,
        err: err.io,
        exit,
        sleep: clock.sleep,
        now: clock.now,
        lookupRestartIntent: () => note(2 * MIN),
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(srv.posts).toHaveLength(1);
      expect(srv.posts[0]).toMatchObject({ idempotencyKey: 'feeder:issue-42' });
      expect(out.logs).toHaveLength(1);
      const envelope = JSON.parse(out.logs[0]);
      expect(envelope).toMatchObject({
        ok: true,
        details: {
          taskId: 'task-after-restart',
          restartWait: { outcome: 'recovered', waitedMs: 4 * MIN, reason: 'prod:update' },
        },
      });
      expect(await listSignalFiles(signalDir)).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it('with no note, a down server fails as before and writes no alert', async () => {
    const clock = fakeClock();
    mockAutoDetectFetch(() => false);
    const err = capture();
    const { codes, exit } = exitCapture();
    await main({
      argv: ['hello'],
      env: { KOOKR_OPERATOR_SIGNAL_DIR: signalDir },
      stdin: ttyStdin(),
      cwd,
      out: capture().io,
      err: err.io,
      exit,
      sleep: clock.sleep,
      now: clock.now,
      lookupRestartIntent: () => null,
    });
    expect(codes).toEqual([EXIT_NO_SERVER]);
    expect(clock.state.sleeps).toEqual([3000, 3000]);
    expect(err.errors.join('\n')).toContain('after 3 attempts');
    expect(await listSignalFiles(signalDir)).toEqual([]);
  });

  it('stale note: exit 3 and one alert naming the prompt\'s first line and the claimed issue', async () => {
    const clock = fakeClock(Date.parse('2026-11-16T12:00:00.000Z'));
    mockAutoDetectFetch(() => false);
    const intent = note(25 * MIN, { clock: clock.now() });
    const run = async () => {
      const out = capture();
      const err = capture();
      const { codes, exit } = exitCapture();
      await main({
        argv: ['--json', '--claim-issue', '3928', '--claim-repo', 'kookr-ai/kookr', 'Implement issue 3928\n\nlong body'],
        env: { KOOKR_OPERATOR_SIGNAL_DIR: signalDir },
        stdin: ttyStdin(),
        cwd,
        out: out.io,
        err: err.io,
        exit,
        sleep: clock.sleep,
        now: clock.now,
        lookupRestartIntent: () => intent,
      });
      return { codes, envelope: JSON.parse(out.logs[0]) };
    };

    const first = await run();
    expect(first.codes).toEqual([EXIT_NO_SERVER]);
    expect(first.envelope).toMatchObject({
      ok: false,
      code: 'NO_SERVER',
      details: { restartWait: { outcome: 'stale', reason: 'prod:update' }, alert: { written: true } },
    });
    expect(first.envelope.message).toMatch(/the deploy looks failed/);

    const files = await listSignalFiles(signalDir);
    expect(files).toHaveLength(1);
    const signal = await readSignal(signalDir, files[0]);
    expect(signal).toMatchObject({ kind: 'alert', source: 'kookr-spawn' });
    expect(signal?.title).toContain('Implement issue 3928');
    expect(signal?.title).not.toContain('long body');
    expect(signal?.title).toContain('#3928');
    expect(signal?.detail).toContain(cwd);

    // A feeder retrying the same lost launch must not page the operator again.
    const second = await run();
    expect(second.codes).toEqual([EXIT_NO_SERVER]);
    expect(second.envelope.details.alert).toMatchObject({ written: false, path: first.envelope.details.alert.path });
    expect(await readdir(signalDir)).toEqual(files);
  });

  it('limit reached: exit 3 and one alert; the text output says why', async () => {
    const clock = fakeClock();
    mockAutoDetectFetch(() => false);
    const err = capture();
    const { codes, exit } = exitCapture();
    await main({
      argv: ['--restart-wait', '30', 'hello'],
      env: { KOOKR_OPERATOR_SIGNAL_DIR: signalDir },
      stdin: ttyStdin(),
      cwd,
      out: capture().io,
      err: err.io,
      exit,
      sleep: clock.sleep,
      now: clock.now,
      lookupRestartIntent: () => note(MIN),
    });
    expect(codes).toEqual([EXIT_NO_SERVER]);
    const text = err.errors.join('\n');
    expect(text).toMatch(/still restarting .* wait limit passed after 30s/);
    expect(text).toMatch(/operator alert written: /);
    expect(await listSignalFiles(signalDir)).toHaveLength(1);
  });

  it('KOOKR_SPAWN_RESTART_WAIT_SECONDS sets the limit and the flag overrides it', async () => {
    mockAutoDetectFetch(() => false);
    const waitedWith = async (argv: string[]) => {
      const clock = fakeClock();
      const out = capture();
      const { codes, exit } = exitCapture();
      await main({
        argv: ['--json', ...argv, 'hello'],
        env: { KOOKR_OPERATOR_SIGNAL_DIR: signalDir, KOOKR_SPAWN_RESTART_WAIT_SECONDS: '45' },
        stdin: ttyStdin(),
        cwd,
        out: out.io,
        err: capture().io,
        exit,
        sleep: clock.sleep,
        now: clock.now,
        lookupRestartIntent: () => note(MIN),
      });
      expect(codes).toEqual([EXIT_NO_SERVER]);
      return JSON.parse(out.logs[0]).details.restartWait;
    };
    expect(await waitedWith([])).toMatchObject({ outcome: 'limit_reached', waitedMs: 45_000 });
    expect(await waitedWith(['--restart-wait', '30'])).toMatchObject({ outcome: 'limit_reached', waitedMs: 30_000 });
  });

  it('a note cleared while the server stays down: usual exit 3, no alert', async () => {
    const clock = fakeClock();
    mockAutoDetectFetch(() => false);
    const intent = note(MIN);
    const out = capture();
    const { codes, exit } = exitCapture();
    await main({
      argv: ['--json', 'hello'],
      env: { KOOKR_OPERATOR_SIGNAL_DIR: signalDir },
      stdin: ttyStdin(),
      cwd,
      out: out.io,
      err: capture().io,
      exit,
      sleep: clock.sleep,
      now: clock.now,
      lookupRestartIntent: () => (clock.now() < MIN ? intent : null),
    });
    expect(codes).toEqual([EXIT_NO_SERVER]);
    const envelope = JSON.parse(out.logs[0]);
    expect(envelope.message).toMatch(/no Kookr server reachable on :4800 or :4801 after \d+ attempts/);
    expect(envelope.details.alert).toBeUndefined();
    expect(await listSignalFiles(signalDir)).toEqual([]);
  });

  it('explicit URL whose restart never finishes: exit 3 and one alert once the note goes stale', async () => {
    const clock = fakeClock();
    const srv = await startRestartingServer(() => false);
    try {
      const out = capture();
      const { codes, exit } = exitCapture();
      await main({
        argv: ['--json', 'hello'],
        env: { KOOKR_API_BASE_URL: srv.baseUrl, KOOKR_OPERATOR_SIGNAL_DIR: signalDir },
        stdin: ttyStdin(),
        cwd,
        out: out.io,
        err: capture().io,
        exit,
        sleep: clock.sleep,
        now: clock.now,
        lookupRestartIntent: () => note(9 * MIN), // stale one minute in
      });
      expect(codes).toEqual([EXIT_NO_SERVER]);
      expect(JSON.parse(out.logs[0])).toMatchObject({
        code: 'NO_SERVER',
        details: { ports: [srv.port], restartWait: { outcome: 'stale' }, alert: { written: true } },
      });
      expect(srv.posts).toEqual([]);
      expect(await listSignalFiles(signalDir)).toHaveLength(1);
    } finally {
      await srv.close();
    }
  });

  it('--dry-run never writes a lost-launch alert', async () => {
    const clock = fakeClock();
    mockAutoDetectFetch(() => false);
    const { codes, exit } = exitCapture();
    await main({
      argv: ['--dry-run', 'hello'],
      env: { KOOKR_OPERATOR_SIGNAL_DIR: signalDir },
      stdin: ttyStdin(),
      cwd,
      out: capture().io,
      err: capture().io,
      exit,
      sleep: clock.sleep,
      now: clock.now,
      lookupRestartIntent: () => note(11 * MIN),
    });
    expect(codes).toEqual([EXIT_NO_SERVER]);
    expect(await listSignalFiles(signalDir)).toEqual([]);
  });

  it('rejects a bad KOOKR_SPAWN_RESTART_WAIT_SECONDS with exit 2', async () => {
    const { codes, exit } = exitCapture();
    const err = capture();
    await main({
      argv: ['hello'],
      env: { KOOKR_SPAWN_RESTART_WAIT_SECONDS: 'soon' },
      stdin: ttyStdin(),
      cwd,
      out: capture().io,
      err: err.io,
      exit,
      lookupRestartIntent: () => null,
    });
    expect(codes).toEqual([EXIT_USER_ERROR]);
    expect(err.errors.join('\n')).toMatch(/KOOKR_SPAWN_RESTART_WAIT_SECONDS/);
  });
});

describe('--restart-wait parsing (#3928)', () => {
  it('accepts both spellings and 0', () => {
    expect(parseArgs(['--restart-wait', '120', 'p']).restartWaitSeconds).toBe(120);
    expect(parseArgs(['--restart-wait=0', 'p']).restartWaitSeconds).toBe(0);
    expect(parseArgs(['p']).restartWaitSeconds).toBeNull();
  });

  it('rejects negatives, non-numbers and values past the cap', () => {
    for (const bad of ['-1', 'x', '', '3601']) {
      expect(() => parseRestartWaitSeconds(bad, '--restart-wait')).toThrow(UsageError);
    }
  });
});
