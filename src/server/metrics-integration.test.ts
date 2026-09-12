import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { createKookrServerInternal } from './index.js';
import type { KookrServerInternal } from './server-test-helpers.js';
import { buildAuditRecord, type ResourceWatchdogAuditSink } from '../core/resource-watchdog-audit.js';
import * as watchdogService from './resource-watchdog-service.js';

function getActualPort(server: KookrServerInternal): number {
  const addr = server.httpServer.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('Server not listening');
}

describe('metrics integration', () => {
  let tempDir: string;
  let server: KookrServerInternal;
  let baseUrl: string;
  let watchdogAuditSink: ResourceWatchdogAuditSink;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-metrics-integration-'));
    const createWatchdog = vi.spyOn(watchdogService, 'createResourceWatchdogService');
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
    baseUrl = `http://127.0.0.1:${getActualPort(server)}`;
    watchdogAuditSink = createWatchdog.mock.calls[0]![0].auditSink;
  });

  afterEach(async () => {
    await server.close();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('GET /metrics includes both production audit sink snapshots', async () => {
    const res = await fetch(`${baseUrl}/metrics`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('kookr_audit_sink_writable{sink="private_network_collaboration"} 1');
    expect(body).toContain('kookr_audit_append_failures_total{sink="private_network_collaboration"} 0');
    expect(body).toContain('kookr_audit_sink_writable{sink="resource_watchdog"} 1');
    expect(body).toContain('kookr_audit_append_failures_total{sink="resource_watchdog"} 0');
    expect(body).not.toContain('lastFailure');
  });

  test('GET /metrics observes failure and recovery of the sink supplied to the watchdog service', async () => {
    const path = join(tempDir, 'resource-watchdog-audit.jsonl');
    mkdirSync(path);
    const record = buildAuditRecord({ action: 'trigger', timestamp: '2026-07-31T12:00:00.000Z' });
    watchdogAuditSink.append(record);
    await vi.waitFor(async () => {
      const body = await (await fetch(`${baseUrl}/metrics`)).text();
      expect(body).toContain('kookr_audit_sink_writable{sink="resource_watchdog"} 0');
      expect(body).toContain('kookr_audit_append_failures_total{sink="resource_watchdog"} 1');
      expect(body).not.toContain(tempDir);
    });
    rmSync(path, { recursive: true });
    watchdogAuditSink.append(record);
    await vi.waitFor(async () => {
      const body = await (await fetch(`${baseUrl}/metrics`)).text();
      expect(body).toContain('kookr_audit_sink_writable{sink="resource_watchdog"} 1');
      expect(body).toContain('kookr_audit_append_failures_total{sink="resource_watchdog"} 1');
    });
  });
});
