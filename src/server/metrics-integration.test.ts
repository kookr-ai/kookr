import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { createKookrServerInternal } from './index.js';
import type { KookrServerInternal } from './server-test-helpers.js';

function getActualPort(server: KookrServerInternal): number {
  const addr = server.httpServer.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('Server not listening');
}

describe('metrics integration', () => {
  let tempDir: string;
  let server: KookrServerInternal;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-metrics-integration-'));
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
  });

  afterEach(async () => {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('GET /metrics includes the production collaboration audit sink snapshot', async () => {
    const res = await fetch(`${baseUrl}/metrics`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('kookr_audit_sink_writable{sink="private_network_collaboration"} 1');
    expect(body).toContain('kookr_audit_append_failures_total{sink="private_network_collaboration"} 0');
    expect(body).not.toContain('lastFailure');
  });
});
