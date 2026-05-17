import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { RelayConnectionManager } from '../relay-connection-manager.js';
import { recoveryAuditPath } from '../session-sharing-recovery.js';
import { SESSION_SHARING_TERMINAL_TRUST_ENV_NAME } from '../../shared/contracts/session-sharing-recovery.js';
import type { RouteDeps, RemoteShareDeps } from './shared.js';
import { registerSessionSharingRecoveryRoutes } from './session-sharing-recovery-routes.js';
import { SHARE_CSRF_HEADER } from './share-routes.js';

const CSRF = 'csrf-recovery';
const ORIGIN = 'http://127.0.0.1';

function manager(overrides: Partial<RelayConnectionManager> = {}): RelayConnectionManager {
  return {
    status: vi.fn(),
    startConfigured: vi.fn(),
    connect: vi.fn(),
    pair: vi.fn(),
    pairHosted: vi.fn(),
    rotate: vi.fn(async () => ({ configured: true, source: 'stored', connectionState: 'connected', relayConnected: true }) as never),
    disconnect: vi.fn(async () => ({ configured: true, source: 'stored', connectionState: 'stopped', relayConnected: false }) as never),
    forget: vi.fn(),
    ...overrides,
  } as RelayConnectionManager;
}

function shareService(overrides: Record<string, unknown> = {}) {
  return {
    listTaskShares: vi.fn(async () => [
      {
        invitationId: 'inv-1',
        taskId: 'task-1',
        createdAt: 'c',
        expiresAt: 'e',
        state: 'waiting',
        connectedViewerCount: 0,
        grants: ['view'],
        grantRequests: [],
      },
      {
        invitationId: 'inv-2',
        taskId: 'task-2',
        createdAt: 'c',
        expiresAt: 'e',
        state: 'revoked',
        connectedViewerCount: 0,
        grants: ['view'],
        grantRequests: [],
      },
    ]),
    revokeTaskShare: vi.fn(async (invitationId: string) => ({
      share: {
        invitationId,
        taskId: 'task-1',
        createdAt: 'c',
        expiresAt: 'e',
        state: 'revoked',
        connectedViewerCount: 0,
        grants: ['view'],
        grantRequests: [],
      },
      alreadyRevoked: false,
    })),
    ...overrides,
  };
}

async function app(opts: {
  remoteShare?: RemoteShareDeps;
  relayConnection?: RelayConnectionManager;
  kookrDir?: string;
  serverCwd?: string;
} = {}): Promise<Hono> {
  const kookrDir = opts.kookrDir ?? await mkdtemp(join(tmpdir(), 'kookr-recovery-state-'));
  const serverCwd = opts.serverCwd ?? await mkdtemp(join(tmpdir(), 'kookr-recovery-cwd-'));
  const hono = new Hono();
  registerSessionSharingRecoveryRoutes(hono, {
    kookrDir,
    serverCwd,
    remoteShare: opts.remoteShare ?? { csrfToken: CSRF, client: null },
    relayConnection: opts.relayConnection ?? manager(),
  } as unknown as RouteDeps);
  return hono;
}

function post(hono: Hono, action: string, body: unknown = {}, headers: Record<string, string> = {
  Origin: ORIGIN,
  [SHARE_CSRF_HEADER]: CSRF,
}): Promise<Response> {
  return hono.request(`${ORIGIN}/api/session-sharing/recovery/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('session sharing recovery routes', () => {
  it('lists recovery actions with executor, credential, and impact copy', async () => {
    const res = await (await app()).request(`${ORIGIN}/api/session-sharing/recovery`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      auditPath: expect.stringContaining('session-sharing-recovery-audit.jsonl'),
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: 'revokeAllShares',
          executor: 'share-scoped-owner',
          credential: 'current-node-token',
          destructive: true,
          confirmation: 'revoke all shares',
          affects: expect.arrayContaining([expect.stringContaining('Every non-expired')]),
        }),
        expect.objectContaining({ id: 'openRelayLogs', destructive: false }),
      ]),
    });
  });

  it('requires confirmation before revoking every active share and writes an audit result', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-recovery-audit-'));
    const service = shareService();
    const hono = await app({
      kookrDir,
      remoteShare: { csrfToken: CSRF, client: null, service: service as never },
    });

    const missing = await post(hono, 'revokeAllShares');
    expect(missing.status).toBe(400);

    const res = await post(hono, 'revokeAllShares', { confirmation: 'revoke all shares' });
    expect(res.status).toBe(200);
    expect(service.revokeTaskShare).toHaveBeenCalledTimes(1);
    expect(service.revokeTaskShare).toHaveBeenCalledWith('inv-1');
    await expect(res.json()).resolves.toEqual({
      result: expect.objectContaining({
        action: 'revokeAllShares',
        state: 'succeeded',
        revokedCount: 1,
        failedCount: 0,
        auditPath: recoveryAuditPath(kookrDir),
      }),
    });
    const audit = await readFile(recoveryAuditPath(kookrDir), 'utf8');
    expect(audit).toContain('"action":"revokeAllShares"');
    expect(audit).toContain('"state":"succeeded"');
  });

  it('disables terminal sharing through .env, disconnects runtime, and records a restart result', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-disable-terminal-state-'));
    const serverCwd = await mkdtemp(join(tmpdir(), 'kookr-disable-terminal-cwd-'));
    await writeFile(join(serverCwd, '.env'), `${SESSION_SHARING_TERMINAL_TRUST_ENV_NAME}=true\nOTHER=1\n`, 'utf8');
    const relayConnection = manager();
    const hono = await app({ kookrDir, serverCwd, relayConnection });

    const res = await post(hono, 'disableTerminalSharing', { confirmation: 'disable terminal sharing' });

    expect(res.status).toBe(200);
    expect(relayConnection.disconnect).toHaveBeenCalledTimes(1);
    await expect(readFile(join(serverCwd, '.env'), 'utf8')).resolves.toContain(`${SESSION_SHARING_TERMINAL_TRUST_ENV_NAME}=false`);
    const body = await res.json();
    expect(body).toEqual({
      result: expect.objectContaining({
        action: 'disableTerminalSharing',
        state: 'requiresRestart',
        command: 'pnpm prod:restart',
        backupPath: expect.stringContaining('.session-sharing-disable.'),
      }),
    });
    expect(existsSync(body.result.backupPath)).toBe(true);
    const audit = await readFile(recoveryAuditPath(kookrDir), 'utf8');
    expect(audit).toContain('"action":"disableTerminalSharing"');
    expect(audit).toContain('"state":"requiresRestart"');
  });

  it('returns and audits credential rotation failure without exposing the submitted admin token', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-rotate-failure-'));
    const relayConnection = manager({
      rotate: vi.fn(async () => {
        throw new Error('Relay rejected super-secret-admin-token.');
      }),
    });
    const hono = await app({ kookrDir, relayConnection });

    const res = await post(hono, 'rotateNodeCredential', {
      confirmation: 'rotate node credential',
      relayAdminToken: 'super-secret-admin-token',
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"state":"failed"');
    expect(text).not.toContain('super-secret-admin-token');
    expect(text).toContain('[redacted]');
    const audit = await readFile(recoveryAuditPath(kookrDir), 'utf8');
    expect(audit).toContain('"action":"rotateNodeCredential"');
    expect(audit).toContain('"state":"failed"');
    expect(audit).not.toContain('super-secret-admin-token');
    expect(audit).toContain('[redacted]');
  });

  it('backs up and removes relay SQLite state during reset', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-reset-state-'));
    const serverCwd = await mkdtemp(join(tmpdir(), 'kookr-reset-cwd-'));
    await writeFile(join(serverCwd, '.env'), `KOOKR_RELAY_PORT=${61000 + Math.floor(Math.random() * 1000)}\n`, 'utf8');
    await writeFile(join(kookrDir, 'relay.sqlite'), 'sqlite bytes', 'utf8');
    await writeFile(join(kookrDir, 'relay.sqlite-wal'), 'wal bytes', 'utf8');
    const hono = await app({ kookrDir, serverCwd });

    const res = await post(hono, 'resetRelayState', { confirmation: 'reset local relay state' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      result: expect.objectContaining({
        action: 'resetRelayState',
        state: 'succeeded',
        backupPath: expect.stringContaining(join(kookrDir, 'relay-state-backups')),
        verification: 'Backed up 2 files and removed 2 relay state files.',
      }),
    });
    expect(existsSync(join(kookrDir, 'relay.sqlite'))).toBe(false);
    expect(existsSync(join(kookrDir, 'relay.sqlite-wal'))).toBe(false);
    expect(existsSync(join(body.result.backupPath, 'relay.sqlite'))).toBe(true);
    expect(existsSync(join(body.result.backupPath, 'relay.sqlite-wal'))).toBe(true);
    const audit = await readFile(recoveryAuditPath(kookrDir), 'utf8');
    expect(audit).toContain('"action":"resetRelayState"');
    expect(audit).toContain('"state":"succeeded"');
  });

  it('audits reset failures as structured recovery results', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-reset-failure-'));
    const serverCwd = await mkdtemp(join(tmpdir(), 'kookr-reset-failure-cwd-'));
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('test blocker did not bind to a TCP port');
    try {
      await writeFile(join(serverCwd, '.env'), `KOOKR_RELAY_PORT=${address.port}\n`, 'utf8');
      const hono = await app({ kookrDir, serverCwd });

      const res = await post(hono, 'resetRelayState', { confirmation: 'reset local relay state' });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        result: expect.objectContaining({
          action: 'resetRelayState',
          state: 'failed',
          verification: 'Reset did not complete; existing relay state was left for manual inspection or retry.',
        }),
      });
      const audit = await readFile(recoveryAuditPath(kookrDir), 'utf8');
      expect(audit).toContain('"action":"resetRelayState"');
      expect(audit).toContain('"state":"failed"');
    } finally {
      await new Promise<void>((resolve, reject) => blocker.close((err) => err ? reject(err) : resolve()));
    }
  });
});
