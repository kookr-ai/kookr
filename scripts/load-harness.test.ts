import { describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

import {
  collectRttSamples,
  createEmptyBroadcastMetrics,
  disabledInputRtt,
  formatMarkdownReport,
  generateSyntheticHookStorm,
  recordBroadcastMessage,
  summarizeInputRtt,
  type LoadHarnessReport,
} from './load-harness-core.js';
import { createFakeTerminalRttProbe, main, parseArgs, summarizeIngestionLag } from './load-harness.js';
import { FakeTerminalBackend } from '../src/adapters/fake-terminal-backend.js';

describe('load-harness synthetic event generator', () => {
  it('generates deterministic interleaved multi-session hook records', () => {
    const first = generateSyntheticHookStorm({
      sessions: 2,
      eventsPerSession: 3,
      seed: 926,
      cwd: '/repo',
      nowMs: 1_000,
    });
    const second = generateSyntheticHookStorm({
      sessions: 2,
      eventsPerSession: 3,
      seed: 926,
      cwd: '/repo',
      nowMs: 1_000,
    });

    expect(first.map((record) => JSON.stringify(record.event))).toEqual(
      second.map((record) => JSON.stringify(record.event)),
    );
    expect(first).toHaveLength(6);
    expect(first.map((record) => record.sessionId)).toEqual([
      'kookr-replay-load-926-0000',
      'kookr-replay-load-926-0001',
      'kookr-replay-load-926-0000',
      'kookr-replay-load-926-0001',
      'kookr-replay-load-926-0000',
      'kookr-replay-load-926-0001',
    ]);
    expect(first.map((record) => record.event.hook_event_name)).toEqual([
      'SessionStart',
      'SessionStart',
      'PreToolUse',
      'PreToolUse',
      'PostToolUse',
      'PostToolUse',
    ]);
  });

  it('uses parseable hook payload shapes with write timestamps for lag diagnostics', () => {
    const records = generateSyntheticHookStorm({
      sessions: 1,
      eventsPerSession: 7,
      seed: 7,
      cwd: '/repo',
      nowMs: 123_456,
    });

    for (const record of records) {
      const parsed = JSON.parse(JSON.stringify(record.event)) as Record<string, unknown>;
      expect(parsed.session_id).toBe('claude-load-7-0');
      expect(parsed.cwd).toBe('/repo');
      expect(parsed.kookr_hook_written_at_ms).toBe(123_456);
      expect(typeof parsed.hook_event_name).toBe('string');
    }
    expect(records.map((record) => record.event.hook_event_name)).toEqual([
      'SessionStart',
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'PermissionRequest',
      'Notification',
      'Stop',
    ]);
    expect(records[1].event.tool_input).toEqual({ command: 'printf load-0-1' });
    expect(records[1].event.tool_use_id).toBe(records[2].event.tool_use_id);
    expect(records[2].event.tool_response).toBe('load-0-2');
    expect(records[3].event.prompt).toBe('continue synthetic load 0/3');
    expect(records[4].event.permission_suggestions).toEqual([{ action: 'allow', command: 'cat' }]);
    expect(records[5].event.message).toBe('synthetic notification 0/5');
    expect(records[6].event.last_assistant_message).toBe('synthetic stop 0/6');
  });

  it('rejects nonsensical dimensions before producing records', () => {
    expect(() => generateSyntheticHookStorm({
      sessions: 0,
      eventsPerSession: 1,
      seed: 1,
      cwd: '/repo',
      nowMs: 1,
    })).toThrow(/sessions/);
  });
});

describe('load-harness report helpers', () => {
  it('counts total broadcasts and snapshot bytes', () => {
    const metrics = createEmptyBroadcastMetrics();
    recordBroadcastMessage(metrics, JSON.stringify({ type: 'snapshot', agents: [] }));
    recordBroadcastMessage(metrics, JSON.stringify({ type: 'alert', summary: 'x' }));
    recordBroadcastMessage(metrics, 'not-json');

    expect(metrics.messageCount).toBe(3);
    expect(metrics.snapshotCount).toBe(1);
    expect(metrics.snapshotBytes).toBeGreaterThan(0);
    expect(metrics.totalBytes).toBeGreaterThan(metrics.snapshotBytes);
  });

  it('formats a markdown report with key metrics and an embedded JSON artifact', () => {
    const markdown = formatMarkdownReport(sampleReport());

    expect(markdown).toContain('# Kookr Event Pipeline Load Harness');
    expect(markdown).toContain('Events: 20/20 dispatched (0 failed)');
    expect(markdown).toContain('Throughput: 100.00 events/sec');
    expect(markdown).toContain('Input RTT: count 200, p50 3.00 ms, p95 8.00 ms, max 12.00 ms, budget 50.00 ms (within budget)');
    expect(markdown).toContain('"schemaVersion": "kookr-load-harness-report.v1"');
  });

  it('renders the input RTT line as disabled when the scenario is off', () => {
    const report = sampleReport();
    report.inputRtt = disabledInputRtt();
    expect(formatMarkdownReport(report)).toContain('Input RTT: disabled');
  });

  it('renders the over-budget and no-budget input RTT branches', () => {
    const over = sampleReport();
    over.inputRtt = { ...over.inputRtt, budgetMs: 5, withinBudget: false };
    expect(formatMarkdownReport(over)).toContain('budget 5.00 ms (OVER BUDGET)');

    const noBudget = sampleReport();
    noBudget.inputRtt = { ...noBudget.inputRtt, budgetMs: null, withinBudget: null };
    const line = formatMarkdownReport(noBudget)
      .split('\n')
      .find((l) => l.startsWith('- Input RTT:'));
    expect(line).toContain('count 200, p50 3.00 ms, p95 8.00 ms, max 12.00 ms');
    expect(line).not.toContain('budget');
  });

  it('summarizes hook ingestion lag across diagnostic sessions', () => {
    expect(summarizeIngestionLag({
      ingestion: {
        sessions: [
          { lag: { count: 2, meanMs: 10, p95Ms: 15, maxMs: 16 } },
          { lag: { count: 3, meanMs: 20, p95Ms: 25, maxMs: 28 } },
        ],
      },
    })).toEqual({
      sampleCount: 5,
      meanMs: 16,
      p95Ms: 25,
      maxMs: 28,
    });
  });
});

describe('load-harness CLI parsing', () => {
  it('parses defaults and options', () => {
    expect(parseArgs([])).toMatchObject({
      sessions: 10,
      eventsPerSession: 25,
      format: 'json',
    });
    expect(parseArgs([
      '--sessions', '2',
      '--events-per-session', '3',
      '--rate-per-second', '50',
      '--seed', '4',
      '--format', 'markdown',
      '--base-url', 'http://127.0.0.1:4801/',
      '--output', '/tmp/report.md',
    ])).toMatchObject({
      sessions: 2,
      eventsPerSession: 3,
      ratePerSecond: 50,
      seed: 4,
      format: 'markdown',
      baseUrl: 'http://127.0.0.1:4801',
      output: '/tmp/report.md',
    });
  });

  it('parses the keystroke-RTT scenario flags', () => {
    expect(parseArgs([])).toMatchObject({ rttSamples: 0, rttIntervalMs: 0, rttBudgetMs: null });
    expect(parseArgs([
      '--rtt-samples', '150',
      '--rtt-interval-ms', '2',
      '--rtt-budget-ms', '50',
    ])).toMatchObject({ rttSamples: 150, rttIntervalMs: 2, rttBudgetMs: 50 });
  });

  it('rejects unknown options and invalid formats', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['--format', 'xml'])).toThrow(/json/);
    expect(() => parseArgs(['--rtt-budget-ms', '0'])).toThrow(/positive integer/);
  });
});

describe('load-harness runtime orchestration', () => {
  it('posts generated records, observes broadcasts, fetches diagnostics, and writes a report', async () => {
    const fixture = await startFakeHarnessTarget();
    const tempDir = await mkdtemp(join(tmpdir(), 'kookr-load-harness-test-'));
    const output = join(tempDir, 'report.json');
    try {
      const code = await main([
        '--base-url', fixture.baseUrl,
        '--sessions', '2',
        '--events-per-session', '3',
        '--format', 'json',
        '--output', output,
      ]);
      expect(code).toBe(0);
      expect(fixture.posts).toHaveLength(6);
      const report = JSON.parse(await readFile(output, 'utf8')) as LoadHarnessReport;
      expect(report.result).toMatchObject({
        attemptedEvents: 6,
        dispatchedEvents: 6,
        failedEvents: 0,
      });
      expect(report.broadcast.messageCount).toBeGreaterThan(0);
      expect(report.snapshot.finalAgentCount).toBe(2);
      expect(report.ingestionLag.sampleCount).toBe(6);
    } finally {
      await fixture.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('returns a failing exit code and report when a hook post fails', async () => {
    const fixture = await startFakeHarnessTarget({ failPostNumbers: new Set([2]) });
    const tempDir = await mkdtemp(join(tmpdir(), 'kookr-load-harness-test-'));
    const output = join(tempDir, 'report.json');
    const nowValues = [1_000, 2_000, 3_000, 4_000];
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => nowValues.shift() ?? 4_000);
    try {
      const code = await main([
        '--base-url', fixture.baseUrl,
        '--sessions', '1',
        '--events-per-session', '3',
        '--format', 'json',
        '--output', output,
      ]);
      expect(code).toBe(1);
      const report = JSON.parse(await readFile(output, 'utf8')) as LoadHarnessReport;
      expect(report.result).toMatchObject({
        attemptedEvents: 3,
        dispatchedEvents: 2,
        failedEvents: 1,
      });
      expect(fixture.posts.map((body) => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        return {
          hookEventName: parsed.hook_event_name,
          writtenAtMs: parsed.kookr_hook_written_at_ms,
        };
      })).toEqual([
        { hookEventName: 'SessionStart', writtenAtMs: 2_000 },
        { hookEventName: 'PreToolUse', writtenAtMs: 3_000 },
        { hookEventName: 'PostToolUse', writtenAtMs: 4_000 },
      ]);
    } finally {
      dateNow.mockRestore();
      await fixture.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('load-harness keystroke RTT scenario', () => {
  it('summarizes samples and evaluates the p95 budget', () => {
    const metrics = summarizeInputRtt([10, 20, 30, 40, 100], 90);
    expect(metrics).toMatchObject({
      enabled: true,
      sampleCount: 5,
      meanMs: 40,
      p50Ms: 30,
      p95Ms: 100,
      maxMs: 100,
      budgetMs: 90,
      withinBudget: false,
    });
  });

  it('passes the budget when p95 is within bounds and reports null when no budget is set', () => {
    expect(summarizeInputRtt([1, 2, 3, 4], 100).withinBudget).toBe(true);
    expect(summarizeInputRtt([1, 2, 3, 4], null).withinBudget).toBeNull();
  });

  it('treats a scenario that collected zero samples as a budget failure', () => {
    expect(summarizeInputRtt([], 50)).toMatchObject({
      enabled: true,
      sampleCount: 0,
      p95Ms: null,
      withinBudget: false,
    });
    expect(summarizeInputRtt([], null).withinBudget).toBeNull();
  });

  it('collects the requested number of samples with an injected probe', async () => {
    const durations = [4, 6, 8];
    let i = 0;
    const sleeps: number[] = [];
    const samples = await collectRttSamples(
      () => Promise.resolve(durations[i++] ?? 0),
      { count: 3, intervalMs: 5 },
      { sleepFn: (ms) => { sleeps.push(ms); return Promise.resolve(); } },
    );
    expect(samples).toEqual([4, 6, 8]);
    expect(sleeps).toEqual([5, 5]); // no trailing sleep after the last sample
  });

  it('stops sampling early when the signal is aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    const samples = await collectRttSamples(
      () => { calls += 1; if (calls === 2) controller.abort(); return Promise.resolve(calls); },
      { count: 10, intervalMs: 0 },
      { signal: controller.signal },
    );
    expect(samples).toEqual([1, 2]);
    expect(calls).toBe(2);
  });

  it('measures a finite round-trip against the fake terminal backend', async () => {
    const backend = new FakeTerminalBackend();
    const probe = await createFakeTerminalRttProbe(backend);
    try {
      const first = await probe.probeOnce();
      const second = await probe.probeOnce();
      // A round-trip that never observed its echo would hang; reaching here with
      // finite samples proves the write -> echo handshake fired for each probe.
      expect(Number.isFinite(first)).toBe(true);
      expect(Number.isFinite(second)).toBe(true);
      const session = backend.sessions.get('kookr-load-harness-rtt-probe');
      expect(session?.written.length).toBe(2);
    } finally {
      await probe.close();
    }
    expect(backend.sessions.get('kookr-load-harness-rtt-probe')?.alive).toBe(false);
  });

  it('rejects the RTT scenario against an external target', async () => {
    await expect(main([
      '--base-url', 'http://127.0.0.1:1',
      '--rtt-samples', '5',
    ])).rejects.toThrow(/in-process/);
  });

  it('rejects a budget without samples so a gate cannot be silently ignored', async () => {
    await expect(main(['--rtt-budget-ms', '50'])).rejects.toThrow(/has no effect without --rtt-samples/);
  });
});

function sampleReport(): LoadHarnessReport {
  return {
    schemaVersion: 'kookr-load-harness-report.v1',
    generatedAt: '2026-06-12T00:00:00.000Z',
    target: { mode: 'in-process', baseUrl: 'http://127.0.0.1:1' },
    config: {
      sessions: 2,
      eventsPerSession: 10,
      totalEvents: 20,
      ratePerSecond: null,
      seed: 926,
    },
    result: {
      attemptedEvents: 20,
      dispatchedEvents: 20,
      failedEvents: 0,
      durationMs: 200,
      throughputEventsPerSecond: 100,
    },
    broadcast: {
      messageCount: 4,
      totalBytes: 4096,
      snapshotCount: 3,
      snapshotBytes: 3072,
      largestSnapshotBytes: 2048,
    },
    snapshot: {
      finalAgentCount: 2,
      finalSnapshotBytes: 1024,
    },
    ingestionLag: {
      sampleCount: 20,
      meanMs: 4,
      p95Ms: 8,
      maxMs: 9,
    },
    inputRtt: {
      enabled: true,
      sampleCount: 200,
      meanMs: 3,
      p50Ms: 3,
      p95Ms: 8,
      maxMs: 12,
      budgetMs: 50,
      withinBudget: true,
    },
    memory: {
      startRssBytes: 1000,
      endRssBytes: 1500,
      deltaRssBytes: 500,
    },
  };
}

async function startFakeHarnessTarget(options: { failPostNumbers?: Set<number> } = {}): Promise<{
  baseUrl: string;
  posts: string[];
  close(): Promise<void>;
}> {
  const posts: string[] = [];
  const sessions = new Map<string, number>();
  const failPostNumbers = options.failPostNumbers ?? new Set<number>();
  const server = createServer(async (req, res) => {
    await handleFakeHarnessRequest(req, res, { posts, sessions, wss, failPostNumbers });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?', 1)[0] !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      ws.send(JSON.stringify({ type: 'snapshot', agents: [], serverCwd: '/repo' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    posts,
    close: async () => {
      for (const client of wss.clients) client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleFakeHarnessRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: {
    posts: string[];
    sessions: Map<string, number>;
    wss: WebSocketServer;
    failPostNumbers: Set<number>;
  },
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/api/health') {
    writeJson(res, { status: 'ok' });
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/hook-event/')) {
    const sessionId = decodeURIComponent(url.pathname.replace('/api/hook-event/', ''));
    const body = await readRequestBody(req);
    state.posts.push(body);
    if (state.failPostNumbers.has(state.posts.length)) {
      writeJson(res, { error: 'synthetic-failure' }, 500);
      return;
    }
    state.sessions.set(sessionId, (state.sessions.get(sessionId) ?? 0) + 1);
    const snapshot = { type: 'snapshot', agents: [...state.sessions.keys()].map((agentId) => ({ agentId })), serverCwd: '/repo' };
    for (const client of state.wss.clients) client.send(JSON.stringify(snapshot));
    writeJson(res, { dispatched: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/diagnostics/hook-ingestion') {
    writeJson(res, {
      ingestion: {
        sessions: [...state.sessions].map(([kookrSessionId, count]) => ({
          kookrSessionId,
          lag: { count, meanMs: 3, p95Ms: 5, maxMs: 6 },
        })),
      },
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/snapshot') {
    writeJson(res, [...state.sessions.keys()].map((agentId) => ({ agentId })));
    return;
  }
  writeJson(res, { error: 'not-found' }, 404);
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(res: ServerResponse, body: unknown, statusCode = 200): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
