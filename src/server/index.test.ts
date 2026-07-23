import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { createKookrServerInternal, notifyBootReconciledTaskOutcomes } from './index.js';
import type { KookrServerInternal } from './server-test-helpers.js';
import type { ResourceStatusSampler } from './resource-status-service.js';
import type { SystemResourceStatus } from '../shared/contracts/messages.js';
import { createRelayServer } from '../../relay/server.js';

const RELAY_TRUSTED_ENV = 'KOOKR_RELAY_' + 'TRUSTED';

// RFC F12: launchTask validates that the working directory exists before
// spawning, so launch cwds used by these integration tests must be real
// directories. (Direct taskStore.createTask calls are not validated, but the
// same constants are reused there for consistency.)
const CWD = mkdtempSync(join(tmpdir(), 'kookr-it-cwd-'));
const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'kookr-it-project-'));
const REPO_A = mkdtempSync(join(tmpdir(), 'kookr-it-repo-a-'));
const REPO_B = mkdtempSync(join(tmpdir(), 'kookr-it-repo-b-'));
const CLI_CWD = mkdtempSync(join(tmpdir(), 'kookr-it-cli-'));

describe('notifyBootReconciledTaskOutcomes', () => {
  test('replays boot-completed and boot-terminated task outcomes', () => {
    const onTaskOutcome = vi.fn();

    notifyBootReconciledTaskOutcomes(onTaskOutcome, {
      tasksCompleted: ['task-completed'],
      tasksTerminated: ['task-terminated'],
    });

    expect(onTaskOutcome).toHaveBeenCalledWith('task-completed', { kind: 'completed' });
    expect(onTaskOutcome).toHaveBeenCalledWith('task-terminated', { kind: 'failed' });
  });

  test('isolates boot outcome callback failures', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onTaskOutcome = vi.fn((taskId: string) => {
      if (taskId === 'task-completed') throw new Error('telegram down');
    });

    notifyBootReconciledTaskOutcomes(onTaskOutcome, {
      tasksCompleted: ['task-completed'],
      tasksTerminated: ['task-terminated'],
    });

    expect(onTaskOutcome).toHaveBeenCalledWith('task-terminated', { kind: 'failed' });
    warn.mockRestore();
  });
});

function getActualPort(server: KookrServerInternal): number {
  const addr = server.httpServer.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('Server not listening');
}

type MalformedAlertMessage = {
  type?: string;
  severity?: string;
  agentId?: string;
  summary?: string;
  details?: string;
};

function waitForMalformedAlert(ws: WebSocket, label: string): Promise<MalformedAlertMessage> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onMsg = (data: unknown) => {
      const parsed = JSON.parse((data as Buffer).toString()) as MalformedAlertMessage;
      if (
        parsed.type !== 'alert'
        || parsed.severity !== 'critical'
        || typeof parsed.summary !== 'string'
        || !parsed.summary.includes('Malformed WebSocket message')
      ) {
        return;
      }

      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(parsed);
    };

    timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`No malformed message alert for ${label}`));
    }, 2000);

    ws.on('message', onMsg);
  });
}

function waitForOperationalAlert(ws: WebSocket, summaryText: string): Promise<MalformedAlertMessage> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onMsg = (data: unknown) => {
      const parsed = JSON.parse((data as Buffer).toString()) as MalformedAlertMessage;
      if (
        parsed.type !== 'alert'
        || parsed.severity !== 'warning'
        || typeof parsed.summary !== 'string'
        || !parsed.summary.includes(summaryText)
      ) {
        return;
      }

      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(parsed);
    };

    timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`No operational alert containing ${summaryText}`));
    }, 2000);

    ws.on('message', onMsg);
  });
}

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 2_000) {
        clearInterval(timer);
        reject(new Error('timed out waiting for condition'));
      }
    }, 10);
  });
}

class FixedResourceSampler implements ResourceStatusSampler {
  start(): void {}
  stop(): void {}
  sample(): SystemResourceStatus {
    return {
      source: { kind: 'server-host' },
      sampledAt: '2026-06-05T00:00:00.000Z',
      sampleGapMs: null,
      timerDriftMs: null,
      host: {
        cpuUsagePercent: 10,
        memoryUsedPercent: 95,
        memoryFreeBytes: 5,
        memoryTotalBytes: 100,
        dataDirectory: {
          path: '/tmp/kookr-data',
          diskFreeBytes: 3_000_000_000,
          diskTotalBytes: 100_000_000_000,
          diskFreePercent: 3,
        },
      },
      server: {
        eventLoopDelayP95Ms: 1,
        processRssBytes: 1,
        processHeapUsedBytes: 1,
        processHeapTotalBytes: 1,
      },
      unavailable: [],
    };
  }
}

async function memberWebSocketNonce(relayUrl: string, memberToken: string, deviceId?: string): Promise<string> {
  const res = await fetch(`${relayUrl}/relay/member/share-state`, {
    headers: {
      cookie: [
        `kookr_relay_member_token=${memberToken}`,
        deviceId ? `kookr_relay_device_id=${deviceId}` : '',
      ].filter(Boolean).join('; '),
    },
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { security?: { webSocketNonce?: string } };
  expect(body.security?.webSocketNonce).toBeTruthy();
  return body.security!.webSocketNonce!;
}

async function acquireRelayControllerLease(relayUrl: string, nodeId: string, memberToken: string, deviceId: string): Promise<void> {
  const stateRes = await fetch(`${relayUrl}/relay/member/share-state`, {
    headers: {
      cookie: [
        `kookr_relay_member_token=${memberToken}`,
        `kookr_relay_device_id=${deviceId}`,
      ].join('; '),
    },
  });
  expect(stateRes.status).toBe(200);
  const state = await stateRes.json() as { security?: { csrfToken?: string; deviceId?: string } };
  const csrfToken = state.security?.csrfToken;
  expect(csrfToken).toBeTruthy();
  const resolvedDeviceId = state.security?.deviceId ?? deviceId;
  const leaseRes = await fetch(`${relayUrl}/relay/member/controller-lease`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: [
        `kookr_relay_member_token=${memberToken}`,
        `kookr_relay_csrf_token=${csrfToken}`,
        `kookr_relay_device_id=${resolvedDeviceId}`,
      ].join('; '),
      'x-kookr-csrf-token': csrfToken!,
    },
    body: JSON.stringify({ nodeId, holderLabel: 'test device' }),
  });
  expect(leaseRes.status).toBe(200);
}

describe('createKookrServer', () => {
  let tempDir: string;
  let server: KookrServerInternal;
  let port: number;
  let baseUrl: string;
  let serverClosed: boolean;
  let terminalBackend: FakeTerminalBackend;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-test-'));
    serverClosed = false;
    terminalBackend = new FakeTerminalBackend();

    server = await createKookrServerInternal({
      port: 0,
      host: '127.0.0.1',
      kookrDir: tempDir,
      tasksFile: join(tempDir, 'tasks.json'),
      hooksDir: join(tempDir, 'hooks'),
      settingsDir: join(tempDir, 'settings'),
      serverCwd: '/test/cwd',
      frontendDir: join(tempDir, 'frontend'),
      saveIntervalMs: 600_000,
      livenessIntervalMs: 600_000,
      terminalBackend,
      claudeDir: join(tempDir, 'claude'),
    });
    port = getActualPort(server);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (!serverClosed) {
      await server.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('HTTP API', () => {
    test('POST /api/hook-event routes malformed records through hook runtime diagnostics', async () => {
      const sessionId = 'hook-runtime-malformed';
      const res = await fetch(`${baseUrl}/api/hook-event/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'received', dispatched: false });
      expect(server.queue.getActiveAnomaly(sessionId)).toMatchObject({
        agentId: sessionId,
        type: 'hook_parse_degraded',
        severity: 'warning',
      });

      const ledgerPath = join(tempDir, 'activity', `${sessionId}.jsonl`);
      await waitForCondition(() => {
        try {
          return readFileSync(ledgerPath, 'utf-8').includes('"parseStatus":"malformed"');
        } catch {
          return false;
        }
      });
      const [line] = readFileSync(ledgerPath, 'utf-8').trim().split('\n');
      expect(JSON.parse(line!)).toMatchObject({
        envelope: {
          kookrSessionId: sessionId,
          source: 'http',
          parseStatus: 'malformed',
        },
        projection: 'diagnostic_only',
      });
    });

    test('env-configured webhook observer posts findings and clears dedupe on resolution', { timeout: 15_000 }, async () => {
      await server.close();
      serverClosed = true;

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
      let webhookServer: KookrServerInternal | null = null;
      try {
        await withEnv({
          KOOKR_WEBHOOK_URL: 'https://receiver.example/kookr',
          KOOKR_WEBHOOK_MIN_SEVERITY: 'critical',
        }, async () => {
          webhookServer = await createKookrServerInternal({
            port: 0,
            host: '127.0.0.1',
            kookrDir: join(tempDir, 'webhook-kookr'),
            tasksFile: join(tempDir, 'webhook-tasks.json'),
            hooksDir: join(tempDir, 'webhook-hooks'),
            settingsDir: join(tempDir, 'webhook-settings'),
            serverCwd: '/test/cwd',
            frontendDir: join(tempDir, 'frontend'),
            saveIntervalMs: 600_000,
            livenessIntervalMs: 600_000,
            terminalBackend: new FakeTerminalBackend(),
            claudeDir: join(tempDir, 'claude'),
          });
        });

        const task = webhookServer!.taskStore.createTask('Webhook task', '/repo');
        webhookServer!.taskStore.setProjectId(task.id, 'github.com/kookr-ai/kookr');
        webhookServer!.projectConfigStore.setConfig('github.com/kookr-ai/kookr', {
          webhook: { minSeverity: 'warning' },
        });
        webhookServer!.taskStore.addSession(task.id, {
          tmuxSession: 'webhook-session',
          agentType: 'claude-code',
          cwd: '/repo',
          createdAt: new Date('2026-06-12T10:00:00.000Z'),
          lastStatus: 'running',
        });

        const anomaly = {
          agentId: 'webhook-session',
          type: 'permission_blocked' as const,
          severity: 'warning' as const,
          explanation: 'Agent is waiting for permission',
          detectedAt: new Date('2026-06-12T10:00:00.000Z'),
        };
        webhookServer!.queue.enqueue('webhook-session', anomaly);
        webhookServer!.queue.enqueue('webhook-session', anomaly);

        await waitForCondition(() => fetchSpy.mock.calls.some(([url]) => url === 'https://receiver.example/kookr'));
        expect(fetchSpy.mock.calls.filter(([url]) => url === 'https://receiver.example/kookr')).toHaveLength(1);

        webhookServer!.queue.respondAndAdvance('webhook-session');
        webhookServer!.queue.enqueue('webhook-session', anomaly);

        await waitForCondition(() => fetchSpy.mock.calls.filter(([url]) => url === 'https://receiver.example/kookr').length === 2);
        const [, init] = fetchSpy.mock.calls.find(([url]) => url === 'https://receiver.example/kookr')!;
        const body = JSON.parse(String(init?.body));
        expect(body.finding).toMatchObject({
          agentId: 'webhook-session',
          type: 'permission_blocked',
          severity: 'warning',
        });
        expect(body.task).toMatchObject({
          id: task.id,
          prompt: 'Webhook task',
        });
      } finally {
        fetchSpy.mockRestore();
        await webhookServer?.close();
      }
    });

    test('admin alert-config update changes the live operational alert evaluator', { timeout: 15_000 }, async () => {
      await server.close();
      serverClosed = true;

      const previousAdminToken = process.env.KOOKR_ADMIN_TOKEN;
      const previousCpu = process.env.KOOKR_ALERT_CPU_PERCENT;
      const previousMemory = process.env.KOOKR_ALERT_MEMORY_PERCENT;
      const previousLoop = process.env.KOOKR_ALERT_EVENT_LOOP_DELAY_MS;
      const previousSustain = process.env.KOOKR_ALERT_SUSTAIN_SAMPLES;
      process.env.KOOKR_ADMIN_TOKEN = 'secret';
      delete process.env.KOOKR_ALERT_CPU_PERCENT;
      delete process.env.KOOKR_ALERT_MEMORY_PERCENT;
      delete process.env.KOOKR_ALERT_EVENT_LOOP_DELAY_MS;
      delete process.env.KOOKR_ALERT_SUSTAIN_SAMPLES;

      let alertServer: KookrServerInternal | null = null;
      let ws: WebSocket | null = null;
      try {
        alertServer = await createKookrServerInternal({
          port: 0,
          host: '127.0.0.1',
          kookrDir: join(tempDir, 'alert-kookr'),
          tasksFile: join(tempDir, 'alert-tasks.json'),
          hooksDir: join(tempDir, 'alert-hooks'),
          settingsDir: join(tempDir, 'alert-settings'),
          serverCwd: '/test/cwd',
          frontendDir: join(tempDir, 'frontend'),
          saveIntervalMs: 600_000,
          livenessIntervalMs: 600_000,
          terminalBackend: new FakeTerminalBackend(),
          claudeDir: join(tempDir, 'claude'),
          resourceStatusSampler: new FixedResourceSampler(),
          resourceStatusIntervalMs: 20,
        });

        const alertPort = getActualPort(alertServer);
        ws = new WebSocket(`ws://127.0.0.1:${alertPort}/ws`);
        await new Promise<void>((resolve) => ws!.once('open', () => resolve()));
        const alertPromise = waitForOperationalAlert(ws, 'High host memory usage');

        const res = await fetch(`http://127.0.0.1:${alertPort}/api/admin/operational-alert-config`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-kookr-admin-token': 'secret',
          },
          body: JSON.stringify({ memoryPercent: 90, sustainSamples: 1 }),
        });
        expect(res.status).toBe(200);
        expect(await alertPromise).toMatchObject({
          type: 'alert',
          severity: 'warning',
          agentId: 'system',
        });
      } finally {
        ws?.close();
        await alertServer?.close();
        if (previousAdminToken === undefined) {
          delete process.env.KOOKR_ADMIN_TOKEN;
        } else {
          process.env.KOOKR_ADMIN_TOKEN = previousAdminToken;
        }
        if (previousCpu === undefined) {
          delete process.env.KOOKR_ALERT_CPU_PERCENT;
        } else {
          process.env.KOOKR_ALERT_CPU_PERCENT = previousCpu;
        }
        if (previousMemory === undefined) {
          delete process.env.KOOKR_ALERT_MEMORY_PERCENT;
        } else {
          process.env.KOOKR_ALERT_MEMORY_PERCENT = previousMemory;
        }
        if (previousLoop === undefined) {
          delete process.env.KOOKR_ALERT_EVENT_LOOP_DELAY_MS;
        } else {
          process.env.KOOKR_ALERT_EVENT_LOOP_DELAY_MS = previousLoop;
        }
        if (previousSustain === undefined) {
          delete process.env.KOOKR_ALERT_SUSTAIN_SAMPLES;
        } else {
          process.env.KOOKR_ALERT_SUSTAIN_SAMPLES = previousSustain;
        }
      }
    });

    test('connects remote node client only when relay env is configured and stops it on close', { timeout: 15_000 }, async () => {
      await server.close();
      serverClosed = true;

      const relay = createRelayServer();
      await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
      const registration = relay.registerNode({ displayName: 'integration' });
      const remoteKookrDir = join(tempDir, 'remote-kookr');
      mkdirSync(remoteKookrDir, { recursive: true });
      writeFileSync(join(remoteKookrDir, 'node-id'), `${registration.nodeId}\n`);

      const previousRelayUrl = process.env.KOOKR_RELAY_URL;
      const previousRelayToken = process.env.KOOKR_RELAY_TOKEN;
      process.env.KOOKR_RELAY_URL = relay.url();
      process.env.KOOKR_RELAY_TOKEN = registration.nodeToken;

      let remoteServer: KookrServerInternal | null = null;
      try {
        remoteServer = await createKookrServerInternal({
          port: 0,
          host: '127.0.0.1',
          kookrDir: remoteKookrDir,
          tasksFile: join(remoteKookrDir, 'tasks.json'),
          hooksDir: join(remoteKookrDir, 'hooks'),
          settingsDir: join(remoteKookrDir, 'settings'),
          serverCwd: '/test/cwd',
          frontendDir: join(tempDir, 'frontend'),
          saveIntervalMs: 600_000,
          livenessIntervalMs: 600_000,
          terminalBackend: new FakeTerminalBackend(),
          claudeDir: join(tempDir, 'claude'),
        });

        await new Promise<void>((resolve, reject) => {
          const started = Date.now();
          const timer = setInterval(() => {
            if (relay.nodeStatuses().some((node) => node.nodeId === registration.nodeId && node.connected)) {
              clearInterval(timer);
              resolve();
            } else if (Date.now() - started > 2_000) {
              clearInterval(timer);
              reject(new Error('timed out waiting for remote node connection'));
            }
          }, 10);
        });

        await remoteServer.close();
        remoteServer = null;

        await new Promise<void>((resolve, reject) => {
          const started = Date.now();
          const timer = setInterval(() => {
            if (relay.nodeStatuses().some((node) => node.nodeId === registration.nodeId && !node.connected)) {
              clearInterval(timer);
              resolve();
            } else if (Date.now() - started > 2_000) {
              clearInterval(timer);
              reject(new Error('timed out waiting for remote node disconnect'));
            }
          }, 10);
        });
      } finally {
        if (previousRelayUrl === undefined) {
          delete process.env.KOOKR_RELAY_URL;
        } else {
          process.env.KOOKR_RELAY_URL = previousRelayUrl;
        }
        if (previousRelayToken === undefined) {
          delete process.env.KOOKR_RELAY_TOKEN;
        } else {
          process.env.KOOKR_RELAY_TOKEN = previousRelayToken;
        }
        await remoteServer?.close();
        await relay.close();
      }
    });

    // Full-suite load regularly pushes this past vitest's 5s default (solo ~4.5s).
    test('executes a relay presetReply through the real server command handler', { timeout: 20_000 }, async () => {
      await server.close();
      serverClosed = true;

      const relay = createRelayServer({ allowInsecureClients: true });
      await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
      const registration = relay.registerNode({ displayName: 'integration' });
      const remoteKookrDir = join(tempDir, 'remote-command-kookr');
      mkdirSync(remoteKookrDir, { recursive: true });
      writeFileSync(join(remoteKookrDir, 'node-id'), `${registration.nodeId}\n`);

      const previousRelayUrl = process.env.KOOKR_RELAY_URL;
      const previousRelayToken = process.env.KOOKR_RELAY_TOKEN;
      process.env.KOOKR_RELAY_URL = relay.url();
      process.env.KOOKR_RELAY_TOKEN = registration.nodeToken;

      let remoteServer: KookrServerInternal | null = null;
      const remoteBackend = new FakeTerminalBackend();
      let clientWs: WebSocket | null = null;
      try {
        remoteServer = await createKookrServerInternal({
          port: 0,
          host: '127.0.0.1',
          kookrDir: remoteKookrDir,
          tasksFile: join(remoteKookrDir, 'tasks.json'),
          hooksDir: join(remoteKookrDir, 'hooks'),
          settingsDir: join(remoteKookrDir, 'settings'),
          serverCwd: '/test/cwd',
          frontendDir: join(tempDir, 'frontend'),
          saveIntervalMs: 600_000,
          livenessIntervalMs: 600_000,
          terminalBackend: remoteBackend,
          claudeDir: join(tempDir, 'claude'),
        });

        await waitForCondition(() => relay.nodeStatuses().some((node) => node.nodeId === registration.nodeId && node.connected));

        await remoteBackend.createSession('remote-session', 'bash');
        const task = remoteServer.taskStore.createTask('remote command task', '/repo');
        remoteServer.taskStore.addSession(task.id, {
          tmuxSession: 'remote-session',
          agentType: 'claude-code',
          cwd: '/repo',
          createdAt: new Date('2026-05-15T19:00:00.000Z'),
        });
        remoteServer.monitor.registerAgent('remote-session');

        const clientUrl = new URL('/relay/client', relay.url());
        clientUrl.protocol = 'ws:';
        clientUrl.searchParams.set('nodeId', registration.nodeId);
        clientWs = new WebSocket(clientUrl);
        const messages: unknown[] = [];
        clientWs.on('message', (data) => messages.push(JSON.parse(data.toString()) as unknown));
        await new Promise<void>((resolve) => clientWs!.once('open', () => resolve()));
        clientWs.send(JSON.stringify({
          type: 'remote.command',
          commandId: 'cmd-real-server',
          actorId: 'spoofed-client-value',
          clientId: 'client-1',
          nodeId: registration.nodeId,
          nodeEpoch: '1',
          sessionId: 'remote-session',
          sessionEpoch: '1',
          grantId: 'spoofed-grant',
          idempotencyKey: 'idem-1',
          action: 'presetReply',
          payload: { presetId: 'continue' },
        }));

        await waitForCondition(() => messages.some((msg) => (msg as { commandId?: string; outcome?: string }).commandId === 'cmd-real-server'));
        expect(remoteBackend.sessions.get('remote-session')?.keysReceived).toContain('continue');
        expect(readFileSync(join(remoteKookrDir, 'audit.jsonl'), 'utf8')).toContain('"commandId":"cmd-real-server"');
        expect(relay.metadataAuditRows().filter((row) => row.commandId === 'cmd-real-server')).toEqual([
          expect.objectContaining({ outcome: 'forwarded' }),
          expect.objectContaining({ outcome: 'accepted' }),
        ]);
      } finally {
        clientWs?.close();
        if (previousRelayUrl === undefined) {
          delete process.env.KOOKR_RELAY_URL;
        } else {
          process.env.KOOKR_RELAY_URL = previousRelayUrl;
        }
        if (previousRelayToken === undefined) {
          delete process.env.KOOKR_RELAY_TOKEN;
        } else {
          process.env.KOOKR_RELAY_TOKEN = previousRelayToken;
        }
        await remoteServer?.close();
        await relay.close();
      }
    });

    test('executes relay submitMessage through the lease-checked remote input adapter', { timeout: 15_000 }, async () => {
      await server.close();
      serverClosed = true;

      const relay = createRelayServer({ allowInsecureClients: true });
      await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
      const registration = relay.registerNode({ displayName: 'integration' });
      const remoteKookrDir = join(tempDir, 'remote-input-kookr');
      mkdirSync(remoteKookrDir, { recursive: true });
      writeFileSync(join(remoteKookrDir, 'node-id'), `${registration.nodeId}\n`);

      const previousRelayUrl = process.env.KOOKR_RELAY_URL;
      const previousRelayToken = process.env.KOOKR_RELAY_TOKEN;
      const previousRelayTrusted = process.env[RELAY_TRUSTED_ENV];
      const previousRelayFeatures = process.env.KOOKR_RELAY_FEATURES;
      process.env.KOOKR_RELAY_URL = relay.url();
      process.env.KOOKR_RELAY_TOKEN = registration.nodeToken;
      process.env[RELAY_TRUSTED_ENV] = 'true';
      delete process.env.KOOKR_RELAY_FEATURES;

      let remoteServer: KookrServerInternal | null = null;
      const remoteBackend = new FakeTerminalBackend();
      let clientWs: WebSocket | null = null;
      let imposterWs: WebSocket | null = null;
      try {
        remoteServer = await createKookrServerInternal({
          port: 0,
          host: '127.0.0.1',
          kookrDir: remoteKookrDir,
          tasksFile: join(remoteKookrDir, 'tasks.json'),
          hooksDir: join(remoteKookrDir, 'hooks'),
          settingsDir: join(remoteKookrDir, 'settings'),
          serverCwd: '/test/cwd',
          frontendDir: join(tempDir, 'frontend'),
          saveIntervalMs: 600_000,
          livenessIntervalMs: 600_000,
          terminalBackend: remoteBackend,
          claudeDir: join(tempDir, 'claude'),
        });

        await waitForCondition(() => relay.nodeStatuses().some((node) => node.nodeId === registration.nodeId && node.connected));

        await remoteBackend.createSession('remote-session', 'bash');
        const task = remoteServer.taskStore.createTask('remote input task', '/repo');
        remoteServer.taskStore.addSession(task.id, {
          tmuxSession: 'remote-session',
          agentType: 'claude-code',
          cwd: '/repo',
          createdAt: new Date('2026-05-15T19:00:00.000Z'),
        });
        remoteServer.monitor.registerAgent('remote-session');

        const clientUrl = new URL('/relay/client', relay.url());
        clientUrl.protocol = 'ws:';
        clientUrl.searchParams.set('nodeId', registration.nodeId);
        clientWs = new WebSocket(clientUrl);
        const messages: unknown[] = [];
        clientWs.on('message', (data) => messages.push(JSON.parse(data.toString()) as unknown));
        await new Promise<void>((resolve) => clientWs!.once('open', () => resolve()));
        clientWs.send(JSON.stringify({
          type: 'remote.command',
          commandId: 'cmd-lease-acquire',
          actorId: 'spoofed-client-value',
          clientId: 'spoofed-client-id',
          nodeId: registration.nodeId,
          nodeEpoch: '1',
          sessionId: 'remote-session',
          sessionEpoch: '1',
          grantId: 'spoofed-grant',
          idempotencyKey: 'idem-lease-1',
          action: 'leaseAcquire',
          baseRevision: 1,
          payload: { leaseId: 'lease-1' },
        }));
        await waitForCondition(() => messages.some((msg) => (
          (msg as { commandId?: string; outcome?: string }).commandId === 'cmd-lease-acquire'
          && (msg as { outcome?: string }).outcome === 'accepted'
        )));

        clientWs.send(JSON.stringify({
          type: 'remote.command',
          commandId: 'cmd-lease-heartbeat',
          actorId: 'spoofed-client-value',
          clientId: 'spoofed-client-id',
          nodeId: registration.nodeId,
          nodeEpoch: '1',
          sessionId: 'remote-session',
          sessionEpoch: '1',
          grantId: 'spoofed-grant',
          idempotencyKey: 'idem-heartbeat-1',
          action: 'leaseHeartbeat',
          leaseId: 'lease-1',
          baseRevision: 1,
        }));
        await waitForCondition(() => messages.some((msg) => (
          (msg as { commandId?: string; outcome?: string }).commandId === 'cmd-lease-heartbeat'
          && (msg as { outcome?: string }).outcome === 'accepted'
        )));
        expect(messages).toContainEqual(expect.objectContaining({
          commandId: 'cmd-lease-heartbeat',
          action: 'leaseHeartbeat',
          outcome: 'accepted',
          result: expect.objectContaining({ leaseId: 'lease-1', state: 'held-remote' }),
        }));

        clientWs.send(JSON.stringify({
          type: 'remote.command',
          commandId: 'cmd-submit-message',
          actorId: 'spoofed-client-value',
          clientId: 'spoofed-client-id',
          nodeId: registration.nodeId,
          nodeEpoch: '1',
          sessionId: 'remote-session',
          sessionEpoch: '1',
          grantId: 'spoofed-grant',
          idempotencyKey: 'idem-submit-1',
          action: 'submitMessage',
          leaseId: 'lease-1',
          baseRevision: 1,
          lastSeenSeq: 0,
          payload: {
            type: 'submit-message',
            sessionId: 'remote-session',
            sessionEpoch: '1',
            leaseId: 'lease-1',
            commandId: 'cmd-submit-message',
            idempotencyKey: 'idem-submit-1',
            text: 'hello remote',
            appendNewline: true,
            baseRevision: 1,
            lastSeenSeq: 0,
            maxAgeMs: 10_000,
          },
        }));

        await waitForCondition(() => messages.some((msg) => (msg as { commandId?: string; outcome?: string }).commandId === 'cmd-submit-message'));
        expect(remoteBackend.getWrittenText('remote-session')).toBe('hello remote\r');
        expect(messages).toContainEqual(expect.objectContaining({
          commandId: 'cmd-submit-message',
          action: 'submitMessage',
          outcome: 'accepted',
        }));

        imposterWs = new WebSocket(clientUrl);
        const imposterMessages: unknown[] = [];
        imposterWs.on('message', (data) => imposterMessages.push(JSON.parse(data.toString()) as unknown));
        await new Promise<void>((resolve) => imposterWs!.once('open', () => resolve()));
        imposterWs.send(JSON.stringify({
          type: 'remote.command',
          commandId: 'cmd-spoof-submit',
          actorId: 'spoofed-client-value',
          clientId: 'client-1',
          nodeId: registration.nodeId,
          nodeEpoch: '1',
          sessionId: 'remote-session',
          sessionEpoch: '1',
          grantId: 'spoofed-grant',
          idempotencyKey: 'idem-spoof-submit',
          action: 'submitMessage',
          leaseId: 'lease-1',
          baseRevision: 1,
          lastSeenSeq: 0,
          payload: {
            type: 'submit-message',
            sessionId: 'remote-session',
            sessionEpoch: '1',
            leaseId: 'lease-1',
            commandId: 'cmd-spoof-submit',
            idempotencyKey: 'idem-spoof-submit',
            text: 'stolen lease',
            appendNewline: true,
            baseRevision: 1,
            lastSeenSeq: 0,
            maxAgeMs: 10_000,
          },
        }));
        await waitForCondition(() => imposterMessages.some((msg) => (msg as { commandId?: string }).commandId === 'cmd-spoof-submit'));
        expect(imposterMessages).toContainEqual(expect.objectContaining({
          commandId: 'cmd-spoof-submit',
          action: 'submitMessage',
          outcome: 'rejected',
          reason: 'error.leaseMismatch',
        }));
        expect(remoteBackend.getWrittenText('remote-session')).toBe('hello remote\r');

        clientWs.send(JSON.stringify({
          type: 'remote.command',
          commandId: 'cmd-lease-override',
          actorId: 'spoofed-client-value',
          clientId: 'spoofed-client-id',
          nodeId: registration.nodeId,
          nodeEpoch: '1',
          sessionId: 'remote-session',
          sessionEpoch: '1',
          grantId: 'spoofed-grant',
          idempotencyKey: 'idem-override-1',
          action: 'leaseOverride',
          leaseId: 'lease-1',
          baseRevision: 1,
        }));
        await waitForCondition(() => messages.some((msg) => (
          (msg as { commandId?: string; outcome?: string }).commandId === 'cmd-lease-override'
          && (msg as { outcome?: string }).outcome === 'accepted'
        )));
        expect(messages).toContainEqual(expect.objectContaining({
          commandId: 'cmd-lease-override',
          action: 'leaseOverride',
          outcome: 'accepted',
          result: { revoked: true },
        }));

        clientWs.send(JSON.stringify({
          type: 'remote.command',
          commandId: 'cmd-submit-after-override',
          actorId: 'spoofed-client-value',
          clientId: 'spoofed-client-id',
          nodeId: registration.nodeId,
          nodeEpoch: '1',
          sessionId: 'remote-session',
          sessionEpoch: '1',
          grantId: 'spoofed-grant',
          idempotencyKey: 'idem-submit-after-override',
          action: 'submitMessage',
          leaseId: 'lease-1',
          baseRevision: 1,
          lastSeenSeq: 0,
          payload: {
            type: 'submit-message',
            sessionId: 'remote-session',
            sessionEpoch: '1',
            leaseId: 'lease-1',
            commandId: 'cmd-submit-after-override',
            idempotencyKey: 'idem-submit-after-override',
            text: 'after override',
            appendNewline: true,
            baseRevision: 1,
            lastSeenSeq: 0,
            maxAgeMs: 10_000,
          },
        }));
        await waitForCondition(() => messages.some((msg) => (
          (msg as { commandId?: string }).commandId === 'cmd-submit-after-override'
        )));
        expect(messages).toContainEqual(expect.objectContaining({
          commandId: 'cmd-submit-after-override',
          action: 'submitMessage',
          outcome: 'rejected',
          reason: 'error.leaseRevoked',
        }));
        expect(remoteBackend.getWrittenText('remote-session')).toBe('hello remote\r');
      } finally {
        clientWs?.close();
        imposterWs?.close();
        if (previousRelayUrl === undefined) delete process.env.KOOKR_RELAY_URL;
        else process.env.KOOKR_RELAY_URL = previousRelayUrl;
        if (previousRelayToken === undefined) delete process.env.KOOKR_RELAY_TOKEN;
        else process.env.KOOKR_RELAY_TOKEN = previousRelayToken;
        if (previousRelayTrusted === undefined) delete process.env[RELAY_TRUSTED_ENV];
        else process.env[RELAY_TRUSTED_ENV] = previousRelayTrusted;
        if (previousRelayFeatures === undefined) delete process.env.KOOKR_RELAY_FEATURES;
        else process.env.KOOKR_RELAY_FEATURES = previousRelayFeatures;
        await remoteServer?.close();
        await relay.close();
      }
    });

    test('executes member invitation submitMessage through exact grant authorization', async () => {
      await server.close();
      serverClosed = true;

      const relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
      await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
      const registration = relay.registerNode({ displayName: 'integration' });
      const remoteKookrDir = join(tempDir, 'remote-member-input-kookr');
      mkdirSync(remoteKookrDir, { recursive: true });
      writeFileSync(join(remoteKookrDir, 'node-id'), `${registration.nodeId}\n`);

      const previousRelayUrl = process.env.KOOKR_RELAY_URL;
      const previousRelayToken = process.env.KOOKR_RELAY_TOKEN;
      const previousRelayTrusted = process.env[RELAY_TRUSTED_ENV];
      const previousRelayFeatures = process.env.KOOKR_RELAY_FEATURES;
      process.env.KOOKR_RELAY_URL = relay.url();
      process.env.KOOKR_RELAY_TOKEN = registration.nodeToken;
      process.env[RELAY_TRUSTED_ENV] = 'true';
      delete process.env.KOOKR_RELAY_FEATURES;

      let remoteServer: KookrServerInternal | null = null;
      const remoteBackend = new FakeTerminalBackend();
      let clientWs: WebSocket | null = null;
      try {
        remoteServer = await createKookrServerInternal({
          port: 0,
          host: '127.0.0.1',
          kookrDir: remoteKookrDir,
          tasksFile: join(remoteKookrDir, 'tasks.json'),
          hooksDir: join(remoteKookrDir, 'hooks'),
          settingsDir: join(remoteKookrDir, 'settings'),
          serverCwd: '/test/cwd',
          frontendDir: join(tempDir, 'frontend'),
          saveIntervalMs: 600_000,
          livenessIntervalMs: 600_000,
          terminalBackend: remoteBackend,
          claudeDir: join(tempDir, 'claude'),
        });

        await waitForCondition(() => relay.nodeStatuses().some((node) => node.nodeId === registration.nodeId && node.connected));

        await remoteBackend.createSession('member-session', 'bash');
        const task = remoteServer.taskStore.createTask('member remote input task', '/repo');
        remoteServer.taskStore.addSession(task.id, {
          tmuxSession: 'member-session',
          agentType: 'claude-code',
          cwd: '/repo',
          createdAt: new Date('2026-05-15T19:00:00.000Z'),
        });
        remoteServer.monitor.registerAgent('member-session');

        const invitation = relay.createInvitation({
          nodeId: registration.nodeId,
          subject: { kind: 'session', nodeId: registration.nodeId, sessionId: 'member-session' },
          grants: ['terminalInput'],
        });
        const accepted = relay.acceptInvitation(invitation.token, 'alice');
        expect(accepted.ok).toBe(true);
        if (!accepted.ok) throw new Error('expected invitation accept');
        const clientUrl = new URL('/relay/client', relay.url());
        clientUrl.protocol = 'ws:';
        clientUrl.searchParams.set('nodeId', registration.nodeId);
        clientUrl.searchParams.set('wsNonce', await memberWebSocketNonce(
          relay.url(),
          accepted.accepted.memberToken,
          accepted.accepted.deviceId,
        ));
        clientWs = new WebSocket(clientUrl, {
          headers: {
            origin: relay.url(),
            cookie: [
              `kookr_relay_member_token=${accepted.accepted.memberToken}`,
              `kookr_relay_device_id=${accepted.accepted.deviceId}`,
            ].join('; '),
          },
        });
        const messages: unknown[] = [];
        clientWs.on('message', (data) => messages.push(JSON.parse(data.toString()) as unknown));
        await new Promise<void>((resolve) => clientWs!.once('open', () => resolve()));
        await acquireRelayControllerLease(
          relay.url(),
          registration.nodeId,
          accepted.accepted.memberToken,
          accepted.accepted.deviceId,
        );
        clientWs.send(JSON.stringify({
          type: 'remote.command',
          commandId: 'cmd-member-lease',
          nodeId: registration.nodeId,
          nodeEpoch: '1',
          sessionId: 'member-session',
          sessionEpoch: '1',
          idempotencyKey: 'idem-member-lease',
          action: 'leaseAcquire',
          baseRevision: 1,
          payload: { leaseId: 'lease-member' },
        }));
        await waitForCondition(() => messages.some((msg) => (msg as { commandId?: string }).commandId === 'cmd-member-lease'));
        expect(messages).toContainEqual(expect.objectContaining({
          commandId: 'cmd-member-lease',
          outcome: 'accepted',
        }));

        clientWs.send(JSON.stringify({
          type: 'remote.command',
          commandId: 'cmd-member-submit',
          nodeId: registration.nodeId,
          nodeEpoch: '1',
          sessionId: 'member-session',
          sessionEpoch: '1',
          idempotencyKey: 'idem-member-submit',
          action: 'submitMessage',
          leaseId: 'lease-member',
          baseRevision: 1,
          lastSeenSeq: 0,
          payload: {
            type: 'submit-message',
            sessionId: 'member-session',
            sessionEpoch: '1',
            leaseId: 'lease-member',
            commandId: 'cmd-member-submit',
            idempotencyKey: 'idem-member-submit',
            text: 'hello member',
            appendNewline: true,
            baseRevision: 1,
            lastSeenSeq: 0,
            maxAgeMs: 10_000,
          },
        }));

        await waitForCondition(() => messages.some((msg) => (msg as { commandId?: string }).commandId === 'cmd-member-submit'));
        expect(messages).toContainEqual(expect.objectContaining({
          commandId: 'cmd-member-submit',
          action: 'submitMessage',
          outcome: 'accepted',
        }));
        expect(remoteBackend.getWrittenText('member-session')).toBe('hello member\r');
        expect(readFileSync(join(remoteKookrDir, 'audit.jsonl'), 'utf8')).toContain(`"grantId":"${invitation.invitation.grantId}"`);
      } finally {
        clientWs?.close();
        if (previousRelayUrl === undefined) delete process.env.KOOKR_RELAY_URL;
        else process.env.KOOKR_RELAY_URL = previousRelayUrl;
        if (previousRelayToken === undefined) delete process.env.KOOKR_RELAY_TOKEN;
        else process.env.KOOKR_RELAY_TOKEN = previousRelayToken;
        if (previousRelayTrusted === undefined) delete process.env[RELAY_TRUSTED_ENV];
        else process.env[RELAY_TRUSTED_ENV] = previousRelayTrusted;
        if (previousRelayFeatures === undefined) delete process.env.KOOKR_RELAY_FEATURES;
        else process.env.KOOKR_RELAY_FEATURES = previousRelayFeatures;
        await remoteServer?.close();
        await relay.close();
      }
    });

    test('blocks member permission approval in bypass-all-permissions mode despite an approved grant', async () => {
      await server.close();
      serverClosed = true;

      const relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
      await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
      const registration = relay.registerNode({ displayName: 'integration' });
      const remoteKookrDir = join(tempDir, 'remote-bypass-permission-kookr');
      mkdirSync(remoteKookrDir, { recursive: true });
      writeFileSync(join(remoteKookrDir, 'node-id'), `${registration.nodeId}\n`);

      const previousRelayUrl = process.env.KOOKR_RELAY_URL;
      const previousRelayToken = process.env.KOOKR_RELAY_TOKEN;
      const previousRelayTrusted = process.env[RELAY_TRUSTED_ENV];
      process.env.KOOKR_RELAY_URL = relay.url();
      process.env.KOOKR_RELAY_TOKEN = registration.nodeToken;
      process.env[RELAY_TRUSTED_ENV] = 'true';

      let remoteServer: KookrServerInternal | null = null;
      const remoteBackend = new FakeTerminalBackend();
      let clientWs: WebSocket | null = null;
      try {
        remoteServer = await createKookrServerInternal({
          port: 0,
          host: '127.0.0.1',
          kookrDir: remoteKookrDir,
          tasksFile: join(remoteKookrDir, 'tasks.json'),
          hooksDir: join(remoteKookrDir, 'hooks'),
          settingsDir: join(remoteKookrDir, 'settings'),
          serverCwd: '/test/cwd',
          frontendDir: join(tempDir, 'frontend'),
          saveIntervalMs: 600_000,
          livenessIntervalMs: 600_000,
          terminalBackend: remoteBackend,
          claudeDir: join(tempDir, 'claude'),
          bypassAllPermissions: true,
        });

        await waitForCondition(() => relay.nodeStatuses().some((node) => node.nodeId === registration.nodeId && node.connected));

        await remoteBackend.createSession('permission-session', 'bash');
        const task = remoteServer.taskStore.createTask('permission task', '/repo');
        remoteServer.taskStore.addSession(task.id, {
          tmuxSession: 'permission-session',
          agentType: 'claude-code',
          cwd: '/repo',
          createdAt: new Date('2026-05-15T19:00:00.000Z'),
        });
        remoteServer.monitor.registerAgent('permission-session');

        const invitation = relay.createInvitation({
          nodeId: registration.nodeId,
          subject: { kind: 'session', nodeId: registration.nodeId, sessionId: 'permission-session' },
          grants: ['permissionApprove'],
        });
        const accepted = relay.acceptInvitation(invitation.token, 'alice');
        expect(accepted.ok).toBe(true);
        if (!accepted.ok) throw new Error('expected invitation accept');

        const clientUrl = new URL('/relay/client', relay.url());
        clientUrl.protocol = 'ws:';
        clientUrl.searchParams.set('nodeId', registration.nodeId);
        clientUrl.searchParams.set('wsNonce', await memberWebSocketNonce(
          relay.url(),
          accepted.accepted.memberToken,
          accepted.accepted.deviceId,
        ));
        clientWs = new WebSocket(clientUrl, {
          headers: {
            origin: relay.url(),
            cookie: [
              `kookr_relay_member_token=${accepted.accepted.memberToken}`,
              `kookr_relay_device_id=${accepted.accepted.deviceId}`,
            ].join('; '),
          },
        });
        const messages: unknown[] = [];
        clientWs.on('message', (data) => messages.push(JSON.parse(data.toString()) as unknown));
        await new Promise<void>((resolve) => clientWs!.once('open', () => resolve()));
        clientWs.send(JSON.stringify({
          type: 'remote.command',
          commandId: 'cmd-member-permission-approve',
          nodeId: registration.nodeId,
          nodeEpoch: '1',
          sessionId: 'permission-session',
          sessionEpoch: '1',
          idempotencyKey: 'idem-member-permission',
          action: 'permissionApprove',
          baseRevision: 1,
          payload: { keystroke: '1' },
        }));

        await waitForCondition(() => messages.some((msg) => (msg as { commandId?: string }).commandId === 'cmd-member-permission-approve'));
        expect(messages).toContainEqual(expect.objectContaining({
          commandId: 'cmd-member-permission-approve',
          action: 'permissionApprove',
          outcome: 'rejected-pre-audit',
          reason: 'unsafe local permission mode requires local owner confirmation',
        }));
      } finally {
        clientWs?.close();
        if (previousRelayUrl === undefined) delete process.env.KOOKR_RELAY_URL;
        else process.env.KOOKR_RELAY_URL = previousRelayUrl;
        if (previousRelayToken === undefined) delete process.env.KOOKR_RELAY_TOKEN;
        else process.env.KOOKR_RELAY_TOKEN = previousRelayToken;
        if (previousRelayTrusted === undefined) delete process.env[RELAY_TRUSTED_ENV];
        else process.env[RELAY_TRUSTED_ENV] = previousRelayTrusted;
        await remoteServer?.close();
        await relay.close();
      }
    });

    test('KOOKR_RELAY_FEATURES=terminal-input disables the remote input adapter only', async () => {
      await server.close();
      serverClosed = true;

      const relay = createRelayServer({ allowInsecureClients: true });
      await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
      const registration = relay.registerNode({ displayName: 'integration' });
      const remoteKookrDir = join(tempDir, 'remote-input-disabled-kookr');
      mkdirSync(remoteKookrDir, { recursive: true });
      writeFileSync(join(remoteKookrDir, 'node-id'), `${registration.nodeId}\n`);

      const previousRelayUrl = process.env.KOOKR_RELAY_URL;
      const previousRelayToken = process.env.KOOKR_RELAY_TOKEN;
      const previousRelayTrusted = process.env[RELAY_TRUSTED_ENV];
      const previousRelayFeatures = process.env.KOOKR_RELAY_FEATURES;
      process.env.KOOKR_RELAY_URL = relay.url();
      process.env.KOOKR_RELAY_TOKEN = registration.nodeToken;
      process.env[RELAY_TRUSTED_ENV] = 'true';
      process.env.KOOKR_RELAY_FEATURES = 'terminal-input';

      let remoteServer: KookrServerInternal | null = null;
      const remoteBackend = new FakeTerminalBackend();
      let clientWs: WebSocket | null = null;
      try {
        remoteServer = await createKookrServerInternal({
          port: 0,
          host: '127.0.0.1',
          kookrDir: remoteKookrDir,
          tasksFile: join(remoteKookrDir, 'tasks.json'),
          hooksDir: join(remoteKookrDir, 'hooks'),
          settingsDir: join(remoteKookrDir, 'settings'),
          serverCwd: '/test/cwd',
          frontendDir: join(tempDir, 'frontend'),
          saveIntervalMs: 600_000,
          livenessIntervalMs: 600_000,
          terminalBackend: remoteBackend,
          claudeDir: join(tempDir, 'claude'),
        });

        expect(remoteServer.controllerLeaseManager).toBeDefined();
        expect(remoteServer.remoteInputAdapter).toBeNull();
        await waitForCondition(() => relay.nodeStatuses().some((node) => node.nodeId === registration.nodeId && node.connected));
        await remoteBackend.createSession('remote-session', 'bash');

        const clientUrl = new URL('/relay/client', relay.url());
        clientUrl.protocol = 'ws:';
        clientUrl.searchParams.set('nodeId', registration.nodeId);
        clientWs = new WebSocket(clientUrl);
        const messages: unknown[] = [];
        clientWs.on('message', (data) => messages.push(JSON.parse(data.toString()) as unknown));
        await new Promise<void>((resolve) => clientWs!.once('open', () => resolve()));
        clientWs.send(JSON.stringify({
          type: 'remote.command',
          commandId: 'cmd-disabled-submit',
          actorId: 'spoofed-client-value',
          clientId: 'spoofed-client-id',
          nodeId: registration.nodeId,
          nodeEpoch: '1',
          sessionId: 'remote-session',
          sessionEpoch: '1',
          grantId: 'spoofed-grant',
          idempotencyKey: 'idem-disabled-submit',
          action: 'submitMessage',
          leaseId: 'lease-disabled',
          baseRevision: 1,
          lastSeenSeq: 0,
          payload: {
            type: 'submit-message',
            sessionId: 'remote-session',
            sessionEpoch: '1',
            leaseId: 'lease-disabled',
            commandId: 'cmd-disabled-submit',
            idempotencyKey: 'idem-disabled-submit',
            text: 'must not write',
            appendNewline: true,
            baseRevision: 1,
            lastSeenSeq: 0,
            maxAgeMs: 10_000,
          },
        }));

        await waitForCondition(() => messages.some((msg) => (msg as { commandId?: string }).commandId === 'cmd-disabled-submit'));
        expect(messages).toContainEqual(expect.objectContaining({
          commandId: 'cmd-disabled-submit',
          action: 'submitMessage',
          outcome: 'rejected-pre-audit',
          reason: 'terminal input feature disabled',
        }));
        expect(remoteBackend.getWrittenText('remote-session')).toBe('');
      } finally {
        clientWs?.close();
        if (previousRelayUrl === undefined) delete process.env.KOOKR_RELAY_URL;
        else process.env.KOOKR_RELAY_URL = previousRelayUrl;
        if (previousRelayToken === undefined) delete process.env.KOOKR_RELAY_TOKEN;
        else process.env.KOOKR_RELAY_TOKEN = previousRelayToken;
        if (previousRelayTrusted === undefined) delete process.env[RELAY_TRUSTED_ENV];
        else process.env[RELAY_TRUSTED_ENV] = previousRelayTrusted;
        if (previousRelayFeatures === undefined) delete process.env.KOOKR_RELAY_FEATURES;
        else process.env.KOOKR_RELAY_FEATURES = previousRelayFeatures;
        await remoteServer?.close();
        await relay.close();
      }
    });

    test('GET /api/health returns status ok', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.agents).toBe(0);
      expect(data.build).toEqual(expect.any(Object));
      expect(typeof data.serverStartedAt).toBe('string');
    });

    test('GET /api/tasks returns empty array initially', async () => {
      const res = await fetch(`${baseUrl}/api/tasks`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual([]);
    });

    test('GET /api/projects returns empty summaries initially', async () => {
      const res = await fetch(`${baseUrl}/api/projects`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual([]);
    });

    test('GET /api/schedules returns empty list initially', async () => {
      const res = await fetch(`${baseUrl}/api/schedules`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual(expect.objectContaining({
        revision: expect.any(Number),
        schedules: [],
        status: expect.objectContaining({
          catchUpMode: 'manual',
          catchUpEnabled: false,
          schedulerHealthy: expect.any(Boolean),
          timezone: expect.any(String),
        }),
      }));
    });

    test('GET /api/snapshot returns empty array initially', async () => {
      const res = await fetch(`${baseUrl}/api/snapshot`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual([]);
    });

    test('GET /api/queue returns empty array initially', async () => {
      const res = await fetch(`${baseUrl}/api/queue`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual([]);
    });

    test('GET /api/reflect/recommendation suggests reflection for a high-friction session', async () => {
      const timestamps = [
        '2026-04-06T09:00:00.000Z',
        '2026-04-06T09:03:00.000Z',
        '2026-04-06T09:06:00.000Z',
        '2026-04-06T09:09:00.000Z',
      ];

      for (const timestamp of timestamps) {
        await server.interactionLog.append({
          type: 'user_input',
          agentId: 'agent-1',
          content: 'did you run the tests?',
          timestamp,
        });
      }

      const res = await fetch(`${baseUrl}/api/reflect/recommendation`);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.sessionId).toEqual(expect.any(String));
      expect(data.report.totalInterventions).toBe(4);
      expect(data.recommendation.shouldSuggest).toBe(true);
      expect(data.recommendation.summary).toContain('4 interventions');
    });

    test('GET /api/capture/:sessionId returns 404 with {error, sessionId} body for unknown session', async () => {
      const res = await fetch(`${baseUrl}/api/capture/nonexistent`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(typeof body.error).toBe('string');
      expect(body.sessionId).toBe('nonexistent');
    });

    test('GET /api/github/:taskId returns 404 for unknown task', async () => {
      const res = await fetch(`${baseUrl}/api/github/nonexistent-task-id`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ error: 'Task not found' });
    });

    test('GET /api/github/:taskId returns 200 with empty state for known task without references', async () => {
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'No GitHub refs yet', cwd: CWD }),
      });
      const task = await createRes.json();

      const res = await fetch(`${baseUrl}/api/github/${task.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.taskId).toBe(task.id);
      expect(body.prs).toEqual([]);
      expect(body.issues).toEqual([]);
      expect(body.changes).toEqual([]);
      expect(body.lastScanAt).toBeNull();
    });

    test('DELETE /api/tasks/:id returns 500 with {error} body when cleanup throws', async () => {
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Boom on delete', cwd: CWD }),
      });
      expect(createRes.status).toBe(201);
      const task = await createRes.json();

      // Force adapter.stop to throw — propagates up through cleanupSessionResources → deleteTask
      // and exercises the catch block in routes/task-routes.ts.
      const originalStop = server.adapter.stop.bind(server.adapter);
      (server.adapter as { stop: (n: string) => Promise<void> }).stop = async () => {
        throw new Error('forced stop failure');
      };

      const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: 'DELETE' });

      // Restore so afterEach close() doesn't re-trigger the throw.
      (server.adapter as { stop: (n: string) => Promise<void> }).stop = originalStop;

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain('forced stop failure');
    });

    test('POST /api/tasks creates and launches a task', async () => {
      const res = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Fix the auth bug',
          cwd: PROJECT_DIR,
          criteria: 'Tests pass',
        }),
      });

      expect(res.status).toBe(201);
      const task = await res.json();
      expect(task.id).toBeDefined();
      expect(task.prompt).toBe('Fix the auth bug');
      expect(task.cwd).toBe(PROJECT_DIR);
      expect(task.criteria).toBe('Tests pass');
      expect(task.status).toBe('inProgress');
      expect(task.sessions).toHaveLength(1);

      // Verify it shows up in task list
      const listRes = await fetch(`${baseUrl}/api/tasks`);
      const tasks = await listRes.json();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(task.id);
    });

    test('POST /api/tasks accepts a 500 KB prompt without putting it in launch argv', async () => {
      const prompt = 'x'.repeat(500_000);
      const res = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          cwd: PROJECT_DIR,
        }),
      });

      expect(res.status).toBe(201);
      const task = await res.json();
      expect(task.prompt).toHaveLength(prompt.length);
      const sessionId = task.sessions[0].tmuxSession;
      const spec = terminalBackend.sessions.get(sessionId)!.spec;
      expect(spec.args.some((arg) => arg.includes(prompt))).toBe(false);
      expect(terminalBackend.getWrittenText(sessionId)).toBe(`${prompt}\r`);
    });

    test('POST /api/tasks with parentTaskId links child to parent', async () => {
      // Create parent task first
      const parentRes = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Parent task', cwd: CWD }),
      });
      const parent = await parentRes.json();

      // Create child task
      const childRes = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Child task',
          cwd: CWD,
          parentTaskId: parent.id,
        }),
      });

      expect(childRes.status).toBe(201);
      const child = await childRes.json();
      expect(child.parentTaskId).toBe(parent.id);

      // Verify parent now has childTaskIds
      const updatedParent = server.taskStore.getTask(parent.id)!;
      expect(updatedParent.childTaskIds).toContain(child.id);
    });

    test('POST /api/tasks returns 400 when prompt missing', async () => {
      const res = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: CWD }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('prompt');
    });

    test('POST /api/tasks returns 400 when cwd missing', async () => {
      const res = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Do something' }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('cwd');
    });

    test('POST /api/tasks returns 404 for non-existent parentTaskId', async () => {
      const res = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Child task',
          cwd: CWD,
          parentTaskId: 'nonexistent-id',
        }),
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain('Parent task not found');
    });

    test('POST /api/agents/:id/message returns 404 for unknown agent', async () => {
      const res = await fetch(`${baseUrl}/api/agents/missing-agent/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'hello' }),
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain('Agent not found');
    });

    test('POST /api/tasks returns idempotent 200 for duplicate active prompt', async () => {
      // First submission — creates task
      const res1 = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Deduplicate me', cwd: CWD }),
      });
      expect(res1.status).toBe(201);
      const first = await res1.json();

      // Second submission with same prompt — should be deduplicated
      const res2 = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Deduplicate me', cwd: CWD }),
      });
      expect(res2.status).toBe(200);
      const second = await res2.json();
      expect(second.duplicate).toBe(true);
      expect(second.task.id).toBe(first.id);

      // Only one task should exist
      const listRes = await fetch(`${baseUrl}/api/tasks`);
      const tasks = await listRes.json();
      const matchingTasks = tasks.filter((t: any) => t.prompt === 'Deduplicate me');
      expect(matchingTasks).toHaveLength(1);
    });

    test('POST /api/tasks can bypass duplicate dedup with explicit duplicate intent', async () => {
      const res1 = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kookr-Launch-Source': 'cli' },
        body: JSON.stringify({ prompt: 'Keep duplicate', cwd: CWD }),
      });
      expect(res1.status).toBe(201);
      const first = await res1.json();

      const res2 = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kookr-Launch-Source': 'cli' },
        body: JSON.stringify({
          prompt: 'Keep duplicate',
          cwd: CWD,
          disableDedup: true,
          metadata: { intent: 'keep_as_duplicate' },
        }),
      });
      expect(res2.status).toBe(201);
      const second = await res2.json();
      expect(second.id).not.toBe(first.id);
      expect(second.metadata).toEqual({ intent: 'keep_as_duplicate' });

      const listRes = await fetch(`${baseUrl}/api/tasks`);
      const tasks = await listRes.json();
      const matchingTasks = tasks.filter((t: any) => t.prompt === 'Keep duplicate');
      expect(matchingTasks).toHaveLength(2);
    });

    test('POST /api/tasks rejects unmarked duplicate bypass requests', async () => {
      const res = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kookr-Launch-Source': 'cli' },
        body: JSON.stringify({
          prompt: 'Unmarked duplicate bypass',
          cwd: CWD,
          disableDedup: true,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('disableDedup requires metadata.intent');
    });

    test.each([
      {
        name: 'non-boolean disableDedup',
        payload: { disableDedup: 'true' },
        expectedError: 'disableDedup must be a boolean',
      },
      {
        name: 'non-object metadata',
        payload: { metadata: 'keep_as_duplicate' },
        expectedError: 'metadata must be an object',
      },
      {
        name: 'array metadata',
        payload: { metadata: [] },
        expectedError: 'metadata must be an object',
      },
      {
        name: 'invalid metadata intent',
        payload: { metadata: { intent: 'other_intent' } },
        expectedError: 'metadata.intent must be "keep_as_duplicate"',
      },
      {
        name: 'duplicate intent without disableDedup',
        payload: { metadata: { intent: 'keep_as_duplicate' } },
        expectedError: 'metadata.intent "keep_as_duplicate" requires disableDedup true',
      },
    ])('POST /api/tasks rejects invalid duplicate metadata: $name', async ({ payload, expectedError }) => {
      const res = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kookr-Launch-Source': 'cli' },
        body: JSON.stringify({
          prompt: `Invalid duplicate metadata: ${expectedError}`,
          cwd: CWD,
          ...payload,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain(expectedError);
    });

    test('POST /api/tasks allows re-submission after task is completed', async () => {
      // Create and complete a task
      const res1 = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Complete me first', cwd: CWD }),
      });
      const first = await res1.json();
      server.taskStore.completeTask(first.id);

      // Same prompt should now create a new task
      const res2 = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Complete me first', cwd: CWD }),
      });
      expect(res2.status).toBe(201);
      const second = await res2.json();
      expect(second.id).not.toBe(first.id);
    });

    test('POST /api/tasks does NOT dedup the same prompt across different cwds', async () => {
      const res1 = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'review the diff', cwd: REPO_A }),
      });
      expect(res1.status).toBe(201);
      const first = await res1.json();

      const res2 = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'review the diff', cwd: REPO_B }),
      });
      expect(res2.status).toBe(201);
      const second = await res2.json();
      expect(second.id).not.toBe(first.id);
      expect(second.duplicate).toBeUndefined();
    });

    test('POST /api/tasks accepts X-Kookr-Launch-Source header without breaking', async () => {
      const res = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Kookr-Launch-Source': 'cli',
        },
        body: JSON.stringify({ prompt: 'launched via cli', cwd: CLI_CWD }),
      });
      expect(res.status).toBe(201);
      const task = await res.json();
      expect(task.id).toBeDefined();
      expect(task.cwd).toBe(CLI_CWD);
    });

    test('SPA fallback returns 404 when frontend not built', async () => {
      const res = await fetch(`${baseUrl}/nonexistent-page`);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain('Frontend not built');
    });

    test('GET /api/health reflects task count', async () => {
      server.taskStore.createTask('Task 1', CWD);
      server.taskStore.createTask('Task 2', CWD);
      const res = await fetch(`${baseUrl}/api/health`);
      const data = await res.json();
      expect(data.agents).toBe(2);
    });

    test('POST /api/projects/track normalizes owner/repo and adds to sidebar immediately', async () => {
      // Before tracking, projects list is empty
      const before = await fetch(`${baseUrl}/api/projects`);
      expect(await before.json()).toEqual([]);

      const res = await fetch(`${baseUrl}/api/projects/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'Grafana/Grafana' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.project).toBe('github.com/grafana/grafana');
      expect(body.config?.tracked).toBe(true);

      const after = await fetch(`${baseUrl}/api/projects`);
      const summaries = await after.json();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].project).toBe('github.com/grafana/grafana');
      expect(summaries[0].displayName).toBe('grafana/grafana');
    });

    test('POST /api/projects/track rejects malformed input with 400', async () => {
      const res = await fetch(`${baseUrl}/api/projects/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'just-one-segment' }),
      });
      expect(res.status).toBe(400);

      const res2 = await fetch(`${baseUrl}/api/projects/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'https://github.com/owner/repo' }),
      });
      expect(res2.status).toBe(400);
    });

    test('POST /api/projects/track rejects non-string repo fields with 400 (no crash)', async () => {
      const cases: unknown[] = [null, 42, true, {}, []];
      for (const bad of cases) {
        const res = await fetch(`${baseUrl}/api/projects/track`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: bad }),
        });
        expect(res.status).toBe(400);
      }

      // Missing `repo` field
      const res = await fetch(`${baseUrl}/api/projects/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    test('POST /api/projects/untrack clears tracked and removes bare config row', async () => {
      // Track, then untrack — project should disappear from sidebar and from configs.
      await fetch(`${baseUrl}/api/projects/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'grafana/grafana' }),
      });
      const beforeSummaries = await (await fetch(`${baseUrl}/api/projects`)).json();
      expect(beforeSummaries).toHaveLength(1);
      expect(beforeSummaries[0].tracked).toBe(true);

      const res = await fetch(`${baseUrl}/api/projects/untrack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'Grafana/Grafana' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.project).toBe('github.com/grafana/grafana');
      expect(body.removed).toBe(true);
      expect(body.config).toBeNull();

      // Project should be gone from summaries and configs.
      const summaries = await (await fetch(`${baseUrl}/api/projects`)).json();
      expect(summaries).toHaveLength(0);
      const configs = await (await fetch(`${baseUrl}/api/projects/configs`)).json();
      expect(configs).toHaveLength(0);
    });

    test('POST /api/projects/untrack preserves config row when notes/limits remain', async () => {
      // Seed a config row with BOTH tracked:true and notes.
      await fetch(`${baseUrl}/api/projects/configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: 'github.com/grafana/grafana',
          tracked: true,
          notes: 'keep changes small',
        }),
      });

      const res = await fetch(`${baseUrl}/api/projects/untrack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'grafana/grafana' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.removed).toBe(false);
      expect(body.config?.tracked).toBe(false);
      expect(body.config?.notes).toBe('keep changes small');

      // Project should still be in the sidebar (notes seeds membership) but
      // no longer flagged as manually tracked.
      const summaries = await (await fetch(`${baseUrl}/api/projects`)).json();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].project).toBe('github.com/grafana/grafana');
      expect(summaries[0].tracked).toBe(false);
      expect(summaries[0].notes).toBe('keep changes small');
    });

    test('GET /api/projects exposes contribution-attempt count without legacy openPrs', async () => {
      server.ossAttemptStore.upsertPr({
        repo: 'grafana/grafana',
        prNumber: 42,
        prUrl: 'https://github.com/grafana/grafana/pull/42',
        prTitle: 'Fix issue 907',
        source: 'posttool_hook',
      });

      const summaries = await (await fetch(`${baseUrl}/api/projects`)).json();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].project).toBe('github.com/grafana/grafana');
      expect(summaries[0].openContributionAttempts).toBe(1);
      expect(summaries[0]).not.toHaveProperty('openPrs');
    });

    test('POST /api/projects/untrack preserves config row when PR limits remain', async () => {
      // Seed a config row with tracked:true AND a daily PR limit, no notes.
      await fetch(`${baseUrl}/api/projects/configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: 'github.com/grafana/grafana',
          tracked: true,
          dailyPrLimit: 2,
        }),
      });

      const res = await fetch(`${baseUrl}/api/projects/untrack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'grafana/grafana' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.removed).toBe(false);
      expect(body.config?.tracked).toBe(false);
      expect(body.config?.dailyPrLimit).toBe(2);

      // Project should still be in the sidebar (the limit seeds membership)
      // but no longer flagged as manually tracked.
      const summaries = await (await fetch(`${baseUrl}/api/projects`)).json();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].tracked).toBe(false);
      expect(summaries[0].dailyLimit).toBe(2);
    });

    test('POST /api/projects/untrack is idempotent for unconfigured projects', async () => {
      const res = await fetch(`${baseUrl}/api/projects/untrack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'foo/bar' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.project).toBe('github.com/foo/bar');
      expect(body.removed).toBe(false);
      expect(body.config).toBeNull();
    });

    test('POST /api/projects/untrack keeps skill-discovered project in sidebar', async () => {
      // Set up skill discovery for a repo.
      const claudeDir = join(tempDir, 'claude');
      mkdirSync(join(claudeDir, 'grafana-grafana-recon'), { recursive: true });
      writeFileSync(
        join(claudeDir, 'grafana-grafana-recon', 'recon-report.md'),
        '# Recon Report: grafana/grafana\n',
      );
      await fetch(`${baseUrl}/api/projects/rescan-skills`, { method: 'POST' });

      // Manually track the same repo (GUI "Add").
      await fetch(`${baseUrl}/api/projects/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'grafana/grafana' }),
      });

      // Untrack — since the repo is also skill-discovered, the project
      // should STAY in the sidebar but the config row should be removed.
      const res = await fetch(`${baseUrl}/api/projects/untrack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'grafana/grafana' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.removed).toBe(true);

      const summaries = await (await fetch(`${baseUrl}/api/projects`)).json();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].project).toBe('github.com/grafana/grafana');
      expect(summaries[0].tracked).toBe(false);

      const configs = await (await fetch(`${baseUrl}/api/projects/configs`)).json();
      expect(configs).toHaveLength(0);
    });

    test('POST /api/projects/untrack rejects malformed input with 400', async () => {
      const res = await fetch(`${baseUrl}/api/projects/untrack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'just-one-segment' }),
      });
      expect(res.status).toBe(400);

      const res2 = await fetch(`${baseUrl}/api/projects/untrack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 42 }),
      });
      expect(res2.status).toBe(400);
    });

    test('POST /api/projects/rescan-skills reflects new recon reports', async () => {
      const claudeDir = join(tempDir, 'claude');
      mkdirSync(join(claudeDir, 'grafana-grafana-recon'), { recursive: true });
      writeFileSync(
        join(claudeDir, 'grafana-grafana-recon', 'recon-report.md'),
        '# Recon Report: grafana/grafana\n',
      );
      mkdirSync(join(claudeDir, 'bad-recon'), { recursive: true });
      writeFileSync(
        join(claudeDir, 'bad-recon', 'recon-report.md'),
        '# Not a recon\n',
      );

      const res = await fetch(`${baseUrl}/api/projects/rescan-skills`, { method: 'POST' });
      expect(res.status).toBe(200);
      const snap = await res.json();
      expect(snap.projects).toEqual(['github.com/grafana/grafana']);
      expect(snap.warnings.length).toBe(1);
      expect(snap.warnings[0]).toContain('bad-recon');
      expect(snap.lastError).toBeUndefined();
      expect(snap.cacheStatus).toBe('scanned');
      expect(snap.staleReasons).toEqual(['recon manifest changed']);
      expect(snap.projectStatuses).toEqual([
        {
          project: 'github.com/grafana/grafana',
          status: 'scanned',
          reason: 'recon manifest changed',
          source: 'grafana-grafana-recon',
        },
      ]);

      const unchangedRes = await fetch(`${baseUrl}/api/projects/rescan-skills`, { method: 'POST' });
      expect(unchangedRes.status).toBe(200);
      const unchangedSnap = await unchangedRes.json();
      expect(unchangedSnap.projects).toEqual(['github.com/grafana/grafana']);
      expect(unchangedSnap.warnings).toEqual(snap.warnings);
      expect(unchangedSnap.cacheStatus).toBe('skipped');
      expect(unchangedSnap.projectStatuses[0]).toMatchObject({
        project: 'github.com/grafana/grafana',
        status: 'skipped',
        reason: 'recon manifest unchanged',
        source: 'grafana-grafana-recon',
      });

      writeFileSync(
        join(claudeDir, 'grafana-grafana-recon', 'recon-report.md'),
        '# Recon Report: grafana/loki\nextra bytes\n',
      );
      const changedRes = await fetch(`${baseUrl}/api/projects/rescan-skills`, { method: 'POST' });
      expect(changedRes.status).toBe(200);
      const changedSnap = await changedRes.json();
      expect(changedSnap.projects).toEqual(['github.com/grafana/loki']);
      expect(changedSnap.cacheStatus).toBe('scanned');
      expect(changedSnap.staleReasons).toEqual(['recon manifest changed']);

      const summaries = await (await fetch(`${baseUrl}/api/projects`)).json();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].project).toBe('github.com/grafana/loki');
    });

    test('GET /api/projects/discovery-status returns the snapshot written by the last rescan', async () => {
      const claudeDir = join(tempDir, 'claude');
      mkdirSync(join(claudeDir, 'foo-bar-recon'), { recursive: true });
      writeFileSync(
        join(claudeDir, 'foo-bar-recon', 'recon-report.md'),
        '# Recon Report: foo/bar\n',
      );

      const rescanRes = await fetch(`${baseUrl}/api/projects/rescan-skills`, { method: 'POST' });
      const rescanSnap = await rescanRes.json();

      const statusRes = await fetch(`${baseUrl}/api/projects/discovery-status`);
      expect(statusRes.status).toBe(200);
      const statusSnap = await statusRes.json();
      expect(statusSnap.projects).toEqual(['github.com/foo/bar']);
      expect(statusSnap.scannedAt).toBe(rescanSnap.scannedAt);
      expect(statusSnap.cacheStatus).toBe(rescanSnap.cacheStatus);
      expect(statusSnap.staleReasons).toEqual(rescanSnap.staleReasons);
      expect(statusSnap.projectStatuses).toEqual(rescanSnap.projectStatuses);
    });

    test('self-diagnostics stay empty until requested on demand', async () => {
      await server.close();
      serverClosed = true;

      const localTempDir = mkdtempSync(join(tmpdir(), 'kookr-diagnostic-on-demand-'));
      let localServer: KookrServerInternal | null = null;
      let localWs: WebSocket | null = null;
      try {
        localServer = await createKookrServerInternal({
          port: 0,
          host: '127.0.0.1',
          kookrDir: localTempDir,
          tasksFile: join(localTempDir, 'tasks.json'),
          hooksDir: join(localTempDir, 'hooks'),
          settingsDir: join(localTempDir, 'settings'),
          serverCwd: '/test/cwd',
          frontendDir: join(localTempDir, 'frontend'),
          saveIntervalMs: 600_000,
          livenessIntervalMs: 600_000,
          terminalBackend: new FakeTerminalBackend(),
          claudeDir: join(localTempDir, 'claude'),
        });
        const localPort = getActualPort(localServer);
        const localBaseUrl = `http://127.0.0.1:${localPort}`;
        const wsMessages: Array<{ type?: string }> = [];
        localWs = new WebSocket(`ws://127.0.0.1:${localPort}/ws`);

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('WS timeout')), 3000);
          localWs!.on('message', (data) => {
            const parsed = JSON.parse(data.toString()) as { type?: string };
            wsMessages.push(parsed);
            if (parsed.type === 'snapshot') {
              clearTimeout(timer);
              resolve();
            }
          });
          localWs!.on('error', reject);
        });

        const initialStatus = await (await fetch(`${localBaseUrl}/api/diagnostic`)).json();
        expect(initialStatus).toEqual({ report: null, lastError: null });
        expect(wsMessages.some((msg) => msg.type === 'diagnosticReport')).toBe(false);

        const runRes = await fetch(`${localBaseUrl}/api/diagnostic/run`, { method: 'POST' });
        expect(runRes.status).toBe(200);
        const runBody = await runRes.json();
        expect(runBody.report).toEqual(expect.objectContaining({ findings: [] }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(wsMessages.some((msg) => msg.type === 'diagnosticReport')).toBe(false);

        const statusAfterRun = await (await fetch(`${localBaseUrl}/api/diagnostic`)).json();
        expect(statusAfterRun.report).toEqual(expect.objectContaining({ findings: [] }));
      } finally {
        if (localWs) {
          localWs.close();
          await new Promise<void>((resolve) => {
            if (!localWs || localWs.readyState === WebSocket.CLOSED) return resolve();
            localWs.once('close', () => resolve());
            setTimeout(resolve, 100);
          });
        }
        if (localServer) await localServer.close();
        rmSync(localTempDir, { recursive: true, force: true });
      }
    });

    test('POST /api/projects/configs persists a project config', async () => {
      const res = await fetch(`${baseUrl}/api/projects/configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: 'kookr-ai/kookr',
          dailyPrLimit: 2,
          weeklyPrLimit: 5,
          notes: 'Keep changes small',
        }),
      });

      expect(res.status).toBe(200);
      const config = await res.json();
      expect(config.project).toBe('kookr-ai/kookr');
      expect(config.dailyPrLimit).toBe(2);
      expect(config.weeklyPrLimit).toBe(5);
      expect(config.notes).toBe('Keep changes small');

      const configsRes = await fetch(`${baseUrl}/api/projects/configs`);
      const configs = await configsRes.json();
      expect(configs).toEqual([expect.objectContaining({ project: 'kookr-ai/kookr' })]);
    });

    test('PUT /api/projects/sidebar persists pinned projects across server restart', async () => {
      const putRes = await fetch(`${baseUrl}/api/projects/sidebar`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          ordered: ['github.com/example/repo'],
          pinned: ['github.com/example/repo'],
          hidden: [],
          catalog: {
            'github.com/example/repo': {
              project: 'github.com/example/repo',
              displayName: 'example/repo',
              color: 2,
              lastSeenAt: '2026-05-09T00:00:00.000Z',
            },
          },
        }),
      });
      expect(putRes.status).toBe(200);

      const summariesBefore = await (await fetch(`${baseUrl}/api/projects`)).json();
      expect(summariesBefore).toEqual([
        expect.objectContaining({ project: 'github.com/example/repo' }),
      ]);

      await server.close();
      serverClosed = true;
      server = await createKookrServerInternal({
        port: 0,
        host: '127.0.0.1',
        kookrDir: tempDir,
        tasksFile: join(tempDir, 'tasks.json'),
        hooksDir: join(tempDir, 'hooks'),
        settingsDir: join(tempDir, 'settings'),
        serverCwd: '/test/cwd',
        frontendDir: join(tempDir, 'frontend'),
        saveIntervalMs: 600_000,
        livenessIntervalMs: 600_000,
        terminalBackend: new FakeTerminalBackend(),
        claudeDir: join(tempDir, 'claude'),
      });
      serverClosed = false;
      port = getActualPort(server);
      baseUrl = `http://127.0.0.1:${port}`;

      const state = await (await fetch(`${baseUrl}/api/projects/sidebar`)).json();
      expect(state).toEqual(expect.objectContaining({
        ordered: ['github.com/example/repo'],
        pinned: ['github.com/example/repo'],
      }));

      const summariesAfter = await (await fetch(`${baseUrl}/api/projects`)).json();
      expect(summariesAfter).toEqual([
        expect.objectContaining({ project: 'github.com/example/repo' }),
      ]);
    });

    test('POST /api/schedules creates a schedule', async () => {
      const projectDir = join(tempDir, 'project');
      mkdirSync(join(projectDir, '.kookr', 'playbooks'), { recursive: true });
      writeFileSync(join(projectDir, '.kookr', 'playbooks', 'daily.md'), `---
name: Daily review
parameters: []
checklist:
  - Review the queue
---
Review daily work.
`);

      const res = await fetch(`${baseUrl}/api/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Daily review',
          cron: '0 9 * * *',
          cwd: projectDir,
          maxTriggers: 3,
          playbook: {
            path: 'daily.md',
            parameters: {},
          },
        }),
      });

      expect(res.status).toBe(201);
      const schedule = await res.json();
      expect(schedule.name).toBe('Daily review');
      expect(schedule.cron).toBe('0 9 * * *');
      expect(schedule.playbook.path).toBe('daily.md');
      expect(schedule.nextRunAt).toEqual(expect.any(String));
      expect(schedule.cronDescription).toEqual(expect.any(String));
      expect(schedule.maxTriggers).toBe(3);
      expect(schedule.remainingTriggers).toBe(3);
      expect(schedule.stopReason).toBeUndefined();

      const schedulesRes = await fetch(`${baseUrl}/api/schedules`);
      const schedules = await schedulesRes.json();
      expect(schedules.schedules).toHaveLength(1);
      expect(schedules.schedules[0].id).toBe(schedule.id);
      expect(schedules.schedules[0].maxTriggers).toBe(3);
      expect(schedules.schedules[0].remainingTriggers).toBe(3);
    });

    test('PATCH /api/schedules updates and clears a finite cron trigger limit', async () => {
      const projectDir = join(tempDir, 'project-patch');
      mkdirSync(join(projectDir, '.kookr', 'playbooks'), { recursive: true });
      writeFileSync(join(projectDir, '.kookr', 'playbooks', 'daily.md'), `---
name: Daily review
parameters: []
---
Review daily work.
`);

      const createRes = await fetch(`${baseUrl}/api/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Daily review',
          cron: '0 9 * * *',
          cwd: projectDir,
          playbook: {
            path: 'daily.md',
            parameters: {},
          },
        }),
      });
      const created = await createRes.json();

      const patchRes = await fetch(`${baseUrl}/api/schedules/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxTriggers: 5 }),
      });

      expect(patchRes.status).toBe(200);
      const updated = await patchRes.json();
      expect(updated.maxTriggers).toBe(5);
      expect(updated.remainingTriggers).toBe(5);
      expect(updated.stopReason).toBeUndefined();

      const clearRes = await fetch(`${baseUrl}/api/schedules/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxTriggers: null }),
      });

      expect(clearRes.status).toBe(200);
      const cleared = await clearRes.json();
      expect(cleared.maxTriggers).toBeUndefined();
      expect(cleared.remainingTriggers).toBeUndefined();
      expect(cleared.stopReason).toBeUndefined();
    });
  });

  describe('WebSocket', () => {
    test('connects and receives initial snapshot', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      const msg = await new Promise<string>((resolve, reject) => {
        ws.on('message', (data) => resolve(data.toString()));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('WS timeout')), 3000);
      });

      const parsed = JSON.parse(msg);
      expect(parsed.type).toBe('snapshot');
      expect(parsed.serverCwd).toBe('/test/cwd');
      expect(parsed.agents).toEqual([]);

      ws.close();
      await new Promise<void>((r) => ws.on('close', () => r()));
    });

    test('recovers corrupt tasks.json at startup and replays a dashboard alert', async () => {
      await server.close();
      serverClosed = true;

      const recoveryDir = join(tempDir, 'recovery');
      mkdirSync(recoveryDir, { recursive: true });
      const recoveredTasksFile = join(recoveryDir, 'tasks.json');
      const restoredTask = {
        id: 'restored-task',
        prompt: 'Recovered task',
        cwd: '/restored',
        agentType: 'claude-code',
        status: 'open',
        sessions: [],
        createdAt: '2026-06-10T00:00:00.000Z',
        updatedAt: '2026-06-10T00:00:00.000Z',
      };
      writeFileSync(recoveredTasksFile, '{"tasks": [');
      writeFileSync(`${recoveredTasksFile}.daily.20260611`, JSON.stringify({
        version: 2,
        lifetimeSpendUsd: 4.25,
        tasks: [restoredTask],
      }));

      const recoveredServer = await createKookrServerInternal({
        port: 0,
        host: '127.0.0.1',
        kookrDir: recoveryDir,
        tasksFile: recoveredTasksFile,
        hooksDir: join(recoveryDir, 'hooks'),
        settingsDir: join(recoveryDir, 'settings'),
        serverCwd: '/test/cwd',
        frontendDir: join(recoveryDir, 'frontend'),
        saveIntervalMs: 600_000,
        livenessIntervalMs: 600_000,
        terminalBackend: new FakeTerminalBackend(),
        claudeDir: join(recoveryDir, 'claude'),
      });

      try {
        expect(recoveredServer.taskStore.listTasks()).toHaveLength(1);
        expect(recoveredServer.taskStore.getTask('restored-task')?.prompt).toBe('Recovered task');
        expect(JSON.parse(readFileSync(recoveredTasksFile, 'utf-8')).tasks[0].id).toBe('restored-task');

        const recoveredPort = getActualPort(recoveredServer);
        const ws = new WebSocket(`ws://127.0.0.1:${recoveredPort}/ws`);
        const messages = await new Promise<Array<{ type: string; summary?: string; details?: string; severity?: string }>>((resolve, reject) => {
          const seen: Array<{ type: string; summary?: string; details?: string; severity?: string }> = [];
          const timer = setTimeout(() => reject(new Error('WS timeout')), 3000);
          ws.on('message', (data) => {
            const parsed = JSON.parse(data.toString());
            seen.push(parsed);
            if (seen.some((msg) => msg.type === 'snapshot') && seen.some((msg) => msg.summary === 'Recovered from corrupt tasks.json')) {
              clearTimeout(timer);
              resolve(seen);
            }
          });
          ws.on('error', reject);
        });
        const recoveryAlert = messages.find((msg) => msg.summary === 'Recovered from corrupt tasks.json');
        expect(recoveryAlert).toMatchObject({
          type: 'alert',
          severity: 'critical',
        });
        expect(recoveryAlert?.details).toContain('Quarantined corrupt file');
        expect(recoveryAlert?.details).toContain(`${recoveredTasksFile}.daily.20260611`);

        ws.close();
        await new Promise<void>((r) => ws.on('close', () => r()));
      } finally {
        await recoveredServer.close();
      }
    });

    test('sends cached resource status after the initial snapshot', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      const messages = await new Promise<Array<{ type: string; status?: unknown }>>((resolve, reject) => {
        const seen: Array<{ type: string; status?: unknown }> = [];
        const timer = setTimeout(() => reject(new Error('WS timeout')), 3000);
        ws.on('message', (data) => {
          const parsed = JSON.parse(data.toString());
          seen.push(parsed);
          if (seen.some((msg) => msg.type === 'snapshot') && seen.some((msg) => msg.type === 'resourceStatus')) {
            clearTimeout(timer);
            resolve(seen);
          }
        });
        ws.on('error', reject);
      });

      expect(messages[0].type).toBe('snapshot');
      const resource = messages.find((msg) => msg.type === 'resourceStatus');
      expect(resource?.status).toEqual(expect.objectContaining({
        source: { kind: 'server-host' },
        host: expect.objectContaining({
          memoryUsedPercent: expect.any(Number),
        }),
      }));

      ws.close();
      await new Promise<void>((r) => ws.on('close', () => r()));
    });

    test('launch creates task and broadcasts snapshot', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      // Wait for initial snapshot
      await new Promise<void>((resolve) => {
        ws.on('open', () => {
          ws.once('message', () => resolve());
        });
      });

      // Send launch
      ws.send(JSON.stringify({
        type: 'launch',
        prompt: 'Fix the bug',
        cwd: PROJECT_DIR,
      }));

      // Wait for broadcast snapshot after launch (may be preceded by achievement messages)
      const parsed = await new Promise<{ type: string }>((resolve) => {
        const handler = (data: unknown) => {
          const p = JSON.parse(data!.toString());
          if (p.type === 'snapshot') {
            ws.off('message', handler);
            resolve(p);
          }
        };
        ws.on('message', handler);
      });
      expect(parsed.type).toBe('snapshot');

      const tasks = server.taskStore.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].prompt).toBe('Fix the bug');

      ws.close();
      await new Promise<void>((r) => ws.on('close', () => r()));
    });

    test('unknown upgrade path rejects connection', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/unknown`);

      await new Promise<void>((resolve) => {
        ws.on('error', () => resolve());
        ws.on('close', () => resolve());
        setTimeout(() => resolve(), 2000);
      });

      expect(ws.readyState).not.toBe(WebSocket.OPEN);
    });

    test('multiple clients receive broadcasts', async () => {
      const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      // Wait for both to get initial snapshots
      await Promise.all([
        new Promise<void>((r) => ws1.once('message', () => r())),
        new Promise<void>((r) => ws2.once('message', () => r())),
      ]);

      // Launch from ws1
      ws1.send(JSON.stringify({
        type: 'launch',
        prompt: 'Test broadcast',
        cwd: CWD,
      }));

      // Both should receive a snapshot broadcast (may be preceded by achievement messages)
      function waitForSnapshot(ws: WebSocket): Promise<{ type: string }> {
        return new Promise((resolve) => {
          const handler = (data: unknown) => {
            const p = JSON.parse(data!.toString());
            if (p.type === 'snapshot') {
              ws.off('message', handler);
              resolve(p);
            }
          };
          ws.on('message', handler);
        });
      }

      const [msg1, msg2] = await Promise.all([
        waitForSnapshot(ws1),
        waitForSnapshot(ws2),
      ]);

      expect(msg1.type).toBe('snapshot');
      expect(msg2.type).toBe('snapshot');

      ws1.close();
      ws2.close();
      await Promise.all([
        new Promise<void>((r) => ws1.on('close', () => r())),
        new Promise<void>((r) => ws2.on('close', () => r())),
      ]);
    });

    test('malformed payloads receive a single critical alert and the connection stays open', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      // Register the snapshot listener BEFORE 'open' so we don't miss the burst
      // emitted in the same tick the server accepts the handshake.
      const sawSnapshot = new Promise<void>((resolve) => {
        const handler = (data: unknown) => {
          const parsed = JSON.parse((data as Buffer).toString());
          if (parsed.type === 'snapshot') {
            ws.off('message', handler);
            resolve();
          }
        };
        ws.on('message', handler);
      });

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      await sawSnapshot;

      // Each payload should be rejected by the runtime guard in ws-connection-handler.ts:
      //   - non-object scalars (string/null/number)
      //   - object missing `type`
      //   - object with non-string `type`
      const cases: Array<{ label: string; payload: string }> = [
        { label: 'string scalar', payload: '"foo"' },
        { label: 'null', payload: 'null' },
        { label: 'number', payload: '42' },
        { label: 'object missing type', payload: '{}' },
        { label: 'object with non-string type', payload: '{"type":42}' },
        { label: 'object with null type', payload: '{"type":null}' },
      ];

      for (const { label, payload } of cases) {
        const next = waitForMalformedAlert(ws, `malformed payload (${label})`);
        ws.send(payload);
        const alert = await next;

        expect(alert.type, `case: ${label}`).toBe('alert');
        expect(alert.severity, `case: ${label}`).toBe('critical');
        expect(alert.agentId, `case: ${label}`).toBe('');
        expect(alert.summary, `case: ${label}`).toContain('Malformed WebSocket message');
        expect(ws.readyState, `case: ${label}`).toBe(WebSocket.OPEN);
      }

      ws.close();
      await new Promise<void>((r) => ws.on('close', () => r()));
    });

    test('ClientMessage payloads failing schema validation receive a critical alert naming the bad field', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      // Absorb the initial snapshot burst before we start asserting.
      const sawSnapshot = new Promise<void>((resolve) => {
        const handler = (data: unknown) => {
          const parsed = JSON.parse((data as Buffer).toString());
          if (parsed.type === 'snapshot') {
            ws.off('message', handler);
            resolve();
          }
        };
        ws.on('message', handler);
      });

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      await sawSnapshot;

      // One case per message family plus an unknown-type case. Each payload has
      // a valid `type` string (so Gate 1 lets it through) but a shape that
      // Gate 2 — the discriminated-union schema — must reject.
      type Case = { label: string; payload: object; expectDetailSubstring: string; expectRejectedValue?: string };
      const cases: Case[] = [
        { label: 'launch with non-string cwd', payload: { type: 'launch', prompt: 'x', cwd: 42 }, expectDetailSubstring: 'cwd' },
        { label: 'respond missing input', payload: { type: 'respond', agentId: 'a1' }, expectDetailSubstring: 'input' },
        { label: 'respondAll with non-array agentIds', payload: { type: 'respondAll', agentIds: 'a1,a2', input: 'x' }, expectDetailSubstring: 'agentIds' },
        { label: 'snooze with non-numeric durationMs', payload: { type: 'snooze', agentId: 'a1', durationMs: '5000' }, expectDetailSubstring: 'durationMs' },
        { label: 'renameTask missing name', payload: { type: 'renameTask', taskId: 't1' }, expectDetailSubstring: 'name' },
        { label: 'telemetry with non-array events', payload: { type: 'telemetry', events: 'nope' }, expectDetailSubstring: 'events' },
        { label: 'launchPlaybook with non-object parameterValues', payload: { type: 'launchPlaybook', playbookPath: 'p', cwd: '/c', parameterValues: 'x' }, expectDetailSubstring: 'parameterValues' },
        { label: 'achievement:setEnabled with non-boolean enabled', payload: { type: 'achievement:setEnabled', enabled: 'yes' }, expectDetailSubstring: 'enabled' },
        { label: 'findingFeedback with wrong verdict', payload: { type: 'findingFeedback', agentId: 'a', anomalyType: 'api_error', explanation: 'e', verdict: 'true_positive' }, expectDetailSubstring: 'verdict' },
        { label: 'workspace:getView missing projectId', payload: { type: 'workspace:getView' }, expectDetailSubstring: 'projectId' },
        { label: 'workspace:cleanupCandidate with wrong riskAccepted type', payload: { type: 'workspace:cleanupCandidate', projectId: 'p', worktreePath: '/w', riskAccepted: 1 }, expectDetailSubstring: 'riskAccepted' },
        { label: 'unknown type string', payload: { type: 'doesNotExist', foo: 'bar' }, expectDetailSubstring: 'type', expectRejectedValue: 'doesNotExist' },
      ];

      for (const { label, payload, expectDetailSubstring, expectRejectedValue } of cases) {
        const next = waitForMalformedAlert(ws, label);
        ws.send(JSON.stringify(payload));
        const alert = await next;

        expect(alert.type, `case: ${label}`).toBe('alert');
        expect(alert.severity, `case: ${label}`).toBe('critical');
        expect(alert.agentId, `case: ${label}`).toBe('');
        expect(alert.summary, `case: ${label}`).toContain('Malformed WebSocket message');
        // details should name the offending field or path
        expect(alert.details ?? '', `case: ${label} — details should mention ${expectDetailSubstring}`).toContain(expectDetailSubstring);
        if (expectRejectedValue) {
          expect(alert.details ?? '', `case: ${label} — details should include rejected value`).toContain(expectRejectedValue);
        }
        expect(ws.readyState, `case: ${label}`).toBe(WebSocket.OPEN);
      }

      ws.close();
      await new Promise<void>((r) => ws.on('close', () => r()));
    });
  });

  describe('Lifecycle', () => {
    test('close() shuts down server cleanly', async () => {
      await server.close();
      serverClosed = true;

      // Server should reject new connections
      await expect(
        fetch(`${baseUrl}/api/health`),
      ).rejects.toThrow();
    });

    test('close() is idempotent', async () => {
      await server.close();
      serverClosed = true;

      // Second close should not throw
      await expect(server.close()).resolves.toBeUndefined();
    });

    test('close() disconnects connected WebSocket clients', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      // Wait for connection and initial snapshot
      await new Promise<void>((resolve) => {
        ws.on('open', () => {
          ws.once('message', () => resolve());
        });
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);

      await server.close();
      serverClosed = true;

      // Client should have been disconnected
      await new Promise<void>((r) => {
        if (ws.readyState !== WebSocket.OPEN) return r();
        ws.on('close', () => r());
        setTimeout(() => r(), 2000);
      });

      expect(ws.readyState).not.toBe(WebSocket.OPEN);
    });
  });

  describe('Task persistence and reconciliation', () => {
    test('loads persisted tasks and reconciles dead sessions', async () => {
      // Close the default server first
      await server.close();
      serverClosed = true;

      // Pre-populate a tasks.json with a task that has a dead session
      const newTempDir = mkdtempSync(join(tmpdir(), 'kookr-persist-'));
      mkdirSync(join(newTempDir, 'hooks'), { recursive: true });
      mkdirSync(join(newTempDir, 'settings'), { recursive: true });
      const tasksFile = join(newTempDir, 'tasks.json');
      // Deliberately nonexistent cwd: crash recovery skips (and reconcile
      // terminates) a dead-session task whose cwd is gone. With an existing
      // cwd, startup crash recovery would *relaunch* this task instead and
      // it would stay inProgress.
      const goneCwd = '/nonexistent/kookr-persist-cwd';
      writeFileSync(tasksFile, JSON.stringify([
        {
          id: 'persisted-task-1',
          prompt: 'Pre-existing task',
          cwd: goneCwd,
          status: 'inProgress',
          sessions: [{
            tmuxSession: 'kookr-dead-session',
            agentType: 'claude-code',
            cwd: goneCwd,
            createdAt: '2026-03-25T00:00:00.000Z',
          }],
          createdAt: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z',
        },
      ]));

      server = await createKookrServerInternal({
        port: 0,
        host: '127.0.0.1',
        kookrDir: newTempDir,
        tasksFile,
        hooksDir: join(newTempDir, 'hooks'),
        settingsDir: join(newTempDir, 'settings'),
        serverCwd: '/test/cwd',
        frontendDir: join(newTempDir, 'frontend'),
        saveIntervalMs: 600_000,
        livenessIntervalMs: 600_000,
        terminalBackend: new FakeTerminalBackend(),
        claudeDir: join(newTempDir, 'claude'),
      });
      serverClosed = false;
      port = getActualPort(server);
      baseUrl = `http://127.0.0.1:${port}`;

      // Task should have been loaded and reconciled
      const tasks = server.taskStore.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].prompt).toBe('Pre-existing task');
      // Session was dead → task auto-transitioned to 'terminated' (not 'completed')
      // per rfc-task-loss-prevention D1.
      expect(tasks[0].status).toBe('terminated');
      expect(tasks[0].sessions[0].lastStatus).toBe('completed');

      await server.close();
      serverClosed = true;
      rmSync(newTempDir, { recursive: true, force: true });
    });
  });

  describe('Adapter event wiring', () => {
    test('adapter events trigger broadcast to connected clients', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      // Wait for initial snapshot
      await new Promise<void>((resolve) => {
        ws.on('open', () => {
          ws.once('message', () => resolve());
        });
      });

      // Launch a task first
      ws.send(JSON.stringify({
        type: 'launch',
        prompt: 'Test event wiring',
        cwd: CWD,
      }));

      // Wait for launch snapshot; resourceStatus messages may be interleaved.
      await new Promise<void>((resolve) => {
        const handler = (data: unknown) => {
          const parsed = JSON.parse(data!.toString());
          if (parsed.type === 'snapshot') {
            ws.off('message', handler);
            resolve();
          }
        };
        ws.on('message', handler);
      });

      // Get the tmux session name from the task
      const tasks = server.taskStore.listTasks({ status: 'inProgress' });
      expect(tasks.length).toBeGreaterThan(0);
      const tmuxName = tasks[0].sessions[0].tmuxSession;

      // Inject a hook event — should trigger adapter event handler → broadcast
      server.adapter.injectHookEvent(tmuxName, JSON.stringify({
        session_id: 'sess-1',
        transcript_path: '/path/to/transcript.jsonl',
        cwd: CWD,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        permission_mode: 'acceptEdits',
      }));

      // Wait for the broadcast triggered by the event
      const msg = await new Promise<string>((resolve) => {
        const handler = (data: unknown) => {
          const parsed = JSON.parse(data!.toString());
          if (parsed.type === 'snapshot') {
            ws.off('message', handler);
            resolve(data!.toString());
          }
        };
        ws.on('message', handler);
      });

      const parsed = JSON.parse(msg);
      expect(parsed.type).toBe('snapshot');

      ws.close();
      await new Promise<void>((r) => ws.on('close', () => r()));
    });
  });
});
