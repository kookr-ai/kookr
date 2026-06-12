#!/usr/bin/env node
/**
 * Synthetic multi-agent hook-event load/soak harness.
 *
 * First slice for issue #926: generate deterministic replay-scoped hook event
 * storms, push them through the existing HTTP ingestion route, and emit an
 * informational JSON or markdown report. This intentionally stays out of the
 * default test loop and does not enforce CI budgets.
 *
 * Usage:
 *   node --import tsx scripts/load-harness.ts --sessions 10 --events-per-session 25
 *   node --import tsx scripts/load-harness.ts --base-url http://127.0.0.1:4801 --format markdown
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';

import type { KookrServerInternal } from '../src/server/server-test-helpers.js';
import {
  createEmptyBroadcastMetrics,
  formatMarkdownReport,
  generateSyntheticHookStorm,
  recordBroadcastMessage,
  type BroadcastMetrics,
  type LoadHarnessReport,
} from './load-harness-core.js';

interface CliOptions {
  sessions: number;
  eventsPerSession: number;
  ratePerSecond: number | null;
  seed: number;
  format: 'json' | 'markdown';
  baseUrl?: string;
  output?: string;
  cwd: string;
  host: string;
}

interface RuntimeTarget {
  mode: 'in-process' | 'external';
  baseUrl: string;
  close(): Promise<void>;
}

const HERMETIC_IN_PROCESS_ENV_KEYS = [
  'HOME',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'KOOKR_OPENROUTER_API_KEY',
  'OPENROUTER_API_KEY',
  'KOOKR_REQUESTY_API_KEY',
  'REQUESTY_API_KEY',
  'KOOKR_LLM_PROVIDER',
  'KOOKR_LLM_MODEL',
  'KOOKR_LLM_BASE_URL',
  'KOOKR_REMOTE_CHAT_DISABLED',
  'KOOKR_RELAY_URL',
  'KOOKR_RELAY_TOKEN',
  'KOOKR_HOSTED_RELAY_ENABLED',
  'KOOKR_BUDGET_WARN_USD',
] as const;

type HermeticEnvKey = (typeof HERMETIC_IN_PROCESS_ENV_KEYS)[number];
type EnvSnapshot = Partial<Record<HermeticEnvKey, string>>;

const DEFAULT_OPTIONS: CliOptions = {
  sessions: 10,
  eventsPerSession: 25,
  ratePerSecond: null,
  seed: 926,
  format: 'json',
  cwd: '/tmp/kookr-load-harness',
  host: '127.0.0.1',
};

function parseArgs(argv: string[]): CliOptions | { help: true } {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const opts: CliOptions = { ...DEFAULT_OPTIONS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--sessions':
        opts.sessions = parsePositiveInt(argv[++i], arg);
        break;
      case '--events-per-session':
        opts.eventsPerSession = parsePositiveInt(argv[++i], arg);
        break;
      case '--rate-per-second':
        opts.ratePerSecond = parsePositiveInt(argv[++i], arg);
        break;
      case '--seed':
        opts.seed = parseNonNegativeInt(argv[++i], arg);
        break;
      case '--format':
        opts.format = parseFormat(argv[++i]);
        break;
      case '--base-url':
        opts.baseUrl = requireValue(argv[++i], arg).replace(/\/$/, '');
        break;
      case '--output':
        opts.output = requireValue(argv[++i], arg);
        break;
      case '--cwd':
        opts.cwd = requireValue(argv[++i], arg);
        break;
      case '--host':
        opts.host = requireValue(argv[++i], arg);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function parseFormat(raw: string | undefined): 'json' | 'markdown' {
  const value = requireValue(raw, '--format');
  if (value === 'json' || value === 'markdown') return value;
  throw new Error(`--format expects "json" or "markdown" (got ${JSON.stringify(raw)})`);
}

function parsePositiveInt(raw: string | undefined, flag: string): number {
  const value = Number(requireValue(raw, flag));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} expects a positive integer (got ${JSON.stringify(raw)})`);
  }
  return value;
}

function parseNonNegativeInt(raw: string | undefined, flag: string): number {
  const value = Number(requireValue(raw, flag));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} expects a non-negative integer (got ${JSON.stringify(raw)})`);
  }
  return value;
}

function requireValue(raw: string | undefined, flag: string): string {
  if (!raw || raw.startsWith('--')) throw new Error(`${flag} requires a value`);
  return raw;
}

async function createTarget(opts: CliOptions): Promise<RuntimeTarget> {
  if (opts.baseUrl) {
    await assertHealthy(opts.baseUrl);
    return {
      mode: 'external',
      baseUrl: opts.baseUrl,
      close: async () => {},
    };
  }
  return createInProcessTarget(opts);
}

async function createInProcessTarget(opts: CliOptions): Promise<RuntimeTarget> {
  const tempDir = await mkdtemp(join(tmpdir(), 'kookr-load-harness-'));
  const previousEnv = applyHermeticInProcessEnv(tempDir);
  const [
    { FakeTerminalBackend },
    { createKookrServerInternal },
  ] = await Promise.all([
    import('../src/adapters/fake-terminal-backend.js'),
    import('../src/server/index.js'),
  ]);
  const terminal = new FakeTerminalBackend();
  const lifecycle = new AbortController();

  let server: KookrServerInternal | null = null;
  try {
    server = await createKookrServerInternal({
      port: 0,
      host: opts.host,
      kookrDir: tempDir,
      tasksFile: join(tempDir, 'tasks.json'),
      hooksDir: join(tempDir, 'hooks'),
      settingsDir: join(tempDir, 'settings'),
      serverCwd: opts.cwd,
      frontendDir: join(process.cwd(), 'dist', 'frontend'),
      saveIntervalMs: 600_000,
      livenessIntervalMs: 600_000,
      terminalBackend: terminal,
      useFakeTerminalBridge: true,
      claudeDir: join(tempDir, 'claude'),
      lifecycleSignal: lifecycle.signal,
      validateLaunchCwd: async () => {},
    });
  } catch (err) {
    restoreEnv(previousEnv);
    await rm(tempDir, { recursive: true, force: true });
    throw err;
  }

  const address = server.httpServer.address();
  const port = typeof address === 'object' && address ? (address as AddressInfo).port : 0;
  if (port <= 0) {
    await server.close();
    restoreEnv(previousEnv);
    await rm(tempDir, { recursive: true, force: true });
    throw new Error('In-process server did not expose an address');
  }

  return {
    mode: 'in-process',
    baseUrl: `http://${opts.host}:${port}`,
    close: async () => {
      lifecycle.abort();
      restoreEnv(previousEnv);
      await server?.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function applyHermeticInProcessEnv(homeDir: string): EnvSnapshot {
  const previous: EnvSnapshot = {};
  for (const key of HERMETIC_IN_PROCESS_ENV_KEYS) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = homeDir;
  process.env.KOOKR_REMOTE_CHAT_DISABLED = '1';
  process.env.KOOKR_BUDGET_WARN_USD = '0';
  return previous;
}

function restoreEnv(previous: EnvSnapshot): void {
  for (const key of HERMETIC_IN_PROCESS_ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function assertHealthy(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`Target ${baseUrl} is not healthy: HTTP ${response.status}`);
}

async function connectBroadcastCounter(baseUrl: string): Promise<{ metrics: BroadcastMetrics; close(): Promise<void> }> {
  const { WebSocket } = await import('ws');
  const metrics = createEmptyBroadcastMetrics();
  const wsUrl = baseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') + '/ws';
  const ws = new WebSocket(wsUrl);
  ws.on('message', (data) => {
    const raw = typeof data === 'string' ? data : data.toString('utf8');
    recordBroadcastMessage(metrics, raw);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out opening ${wsUrl}`)), 2_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return {
    metrics,
    close: async () => new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once('close', () => resolve());
      ws.close();
      setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
        resolve();
      }, 500).unref();
    }),
  };
}

async function dispatchStorm(opts: CliOptions, target: RuntimeTarget): Promise<{
  attemptedEvents: number;
  dispatchedEvents: number;
  failedEvents: number;
  durationMs: number;
}> {
  const records = generateSyntheticHookStorm({
    sessions: opts.sessions,
    eventsPerSession: opts.eventsPerSession,
    seed: opts.seed,
    cwd: opts.cwd,
    nowMs: Date.now(),
  });
  const startedAt = performance.now();
  let dispatchedEvents = 0;
  let failedEvents = 0;
  const delayMs = opts.ratePerSecond ? 1_000 / opts.ratePerSecond : 0;
  for (let i = 0; i < records.length; i += 1) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    const record = records[i];
    try {
      const response = await fetch(`${target.baseUrl}/api/hook-event/${record.sessionId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...record.event, kookr_hook_written_at_ms: Date.now() }),
      });
      if (!response.ok) {
        failedEvents += 1;
        continue;
      }
      const body = await response.json() as { dispatched?: boolean; reason?: string };
      if (body.dispatched) dispatchedEvents += 1;
      else failedEvents += 1;
    } catch {
      failedEvents += 1;
    }
  }
  const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
  return {
    attemptedEvents: records.length,
    dispatchedEvents,
    failedEvents,
    durationMs,
  };
}

async function buildReport(
  opts: CliOptions,
  target: RuntimeTarget,
  dispatch: Awaited<ReturnType<typeof dispatchStorm>>,
  broadcast: BroadcastMetrics,
  startRssBytes: number,
): Promise<LoadHarnessReport> {
  await sleep(50);
  const [diagnostics, snapshot] = await Promise.all([
    fetchJson(`${target.baseUrl}/api/diagnostics/hook-ingestion`),
    fetchJson(`${target.baseUrl}/api/snapshot`),
  ]);
  const finalSnapshotBody = JSON.stringify(snapshot);
  const finalSnapshotBytes = Buffer.byteLength(finalSnapshotBody, 'utf8');
  const endRssBytes = process.memoryUsage().rss;
  const ingestionLag = summarizeIngestionLag(diagnostics);
  const throughput = dispatch.dispatchedEvents / Math.max(dispatch.durationMs / 1_000, 0.001);
  return {
    schemaVersion: 'kookr-load-harness-report.v1',
    generatedAt: new Date().toISOString(),
    target: {
      mode: target.mode,
      baseUrl: target.baseUrl,
    },
    config: {
      sessions: opts.sessions,
      eventsPerSession: opts.eventsPerSession,
      totalEvents: opts.sessions * opts.eventsPerSession,
      ratePerSecond: opts.ratePerSecond,
      seed: opts.seed,
    },
    result: {
      ...dispatch,
      throughputEventsPerSecond: Number(throughput.toFixed(2)),
    },
    broadcast,
    snapshot: {
      finalAgentCount: Array.isArray(snapshot) ? snapshot.length : null,
      finalSnapshotBytes,
    },
    ingestionLag,
    memory: {
      startRssBytes,
      endRssBytes,
      deltaRssBytes: endRssBytes - startRssBytes,
    },
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function summarizeIngestionLag(raw: unknown): LoadHarnessReport['ingestionLag'] {
  const sessions = extractDiagnosticSessions(raw);
  const sampleCount = sessions.reduce((sum, session) => sum + numeric(session.lag?.count), 0);
  const weightedMeanTotal = sessions.reduce((sum, session) => {
    const count = numeric(session.lag?.count);
    const mean = nullableNumber(session.lag?.meanMs);
    return mean === null ? sum : sum + mean * count;
  }, 0);
  const p95Values = sessions
    .map((session) => nullableNumber(session.lag?.p95Ms))
    .filter((value): value is number => value !== null);
  const maxValues = sessions
    .map((session) => nullableNumber(session.lag?.maxMs))
    .filter((value): value is number => value !== null);
  return {
    sampleCount,
    meanMs: sampleCount === 0 ? null : Math.round(weightedMeanTotal / sampleCount),
    p95Ms: p95Values.length === 0 ? null : Math.max(...p95Values),
    maxMs: maxValues.length === 0 ? null : Math.max(...maxValues),
  };
}

function extractDiagnosticSessions(raw: unknown): Array<{ lag?: Record<string, unknown> }> {
  if (!raw || typeof raw !== 'object') return [];
  const route = raw as { ingestion?: { sessions?: unknown } };
  return Array.isArray(route.ingestion?.sessions)
    ? route.ingestion.sessions as Array<{ lag?: Record<string, unknown> }>
    : [];
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ('help' in parsed) {
    printHelp();
    return 0;
  }

  const target = await createTarget(parsed);
  const broadcastCounter = await connectBroadcastCounter(target.baseUrl);
  const startRssBytes = process.memoryUsage().rss;
  try {
    const dispatch = await dispatchStorm(parsed, target);
    const report = await buildReport(parsed, target, dispatch, broadcastCounter.metrics, startRssBytes);
    const output = parsed.format === 'json'
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatMarkdownReport(report);
    if (parsed.output) await writeFile(parsed.output, output, 'utf8');
    else process.stdout.write(output);
    return dispatch.failedEvents > 0 ? 1 : 0;
  } finally {
    await Promise.allSettled([
      withShutdownTimeout('broadcast socket', () => broadcastCounter.close()),
      withShutdownTimeout('target server', () => target.close()),
    ]);
  }
}

async function withShutdownTimeout(label: string, close: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[load-harness] timed out closing ${label}; report already written`);
          resolve();
        }, 2_000);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function printHelp(): void {
  console.log([
    'Usage: node --import tsx scripts/load-harness.ts [options]',
    '',
    'Options:',
    '  --sessions <n>             Synthetic replay sessions (default 10)',
    '  --events-per-session <n>   Hook records per session, including SessionStart (default 25)',
    '  --rate-per-second <n>      Optional sequential dispatch rate cap',
    '  --seed <n>                 Deterministic generator seed (default 926)',
    '  --base-url <url>           Target an already-running server instead of a fake in-process server',
    '  --format <json|markdown>   Report format (default json)',
    '  --output <path>            Write report to a file instead of stdout',
    '  --cwd <path>               Synthetic hook cwd (default /tmp/kookr-load-harness)',
    '  --host <host>              In-process bind host (default 127.0.0.1)',
    '  -h, --help                 Show this help',
  ].join('\n'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2))
    .then((code) => { process.exit(code); })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

export {
  main,
  parseArgs,
  summarizeIngestionLag,
};
