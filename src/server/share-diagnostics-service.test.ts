import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RemoteNodeStatus } from '../remote/node-client.js';
import type { TaskShareSummary } from '../remote/share-contract.js';
import { asNodeEpoch, asNodeId } from '../remote/ids.js';
import { RELAY_TRUSTED_ENV_NAME } from '../remote/handshake.js';
import { ShareDiagnosticsService, terminalAdapterAvailableFromStats } from './share-diagnostics-service.js';

function share(overrides: Partial<TaskShareSummary> = {}): TaskShareSummary {
  return {
    invitationId: 'inv-1',
    taskId: 'task-1',
    createdAt: '2026-05-17T00:00:00.000Z',
    expiresAt: '2026-05-17T01:00:00.000Z',
    state: 'waiting',
    connectedViewerCount: 0,
    grants: ['view'],
    grantRequests: [],
    ...overrides,
  };
}

function remoteStatus(overrides: Partial<RemoteNodeStatus> = {}): RemoteNodeStatus {
  return {
    relayConnected: true,
    protocolVersion: 1,
    nodeId: asNodeId('node-1'),
    nodeEpoch: asNodeEpoch('1'),
    nodeMode: 'active',
    connectionState: 'connected',
    features: { enabled: ['terminal-stream', 'terminal-input'], disabled: [] },
    ...overrides,
  };
}

const diagnosticTrustDeps = {
  relayTrustedEnvName: RELAY_TRUSTED_ENV_NAME,
  relayTrustedProcessValue: (env: NodeJS.ProcessEnv): string | null => env[RELAY_TRUSTED_ENV_NAME] ?? null,
  parseTerminalInputKillSwitch: (raw: string | undefined): { disabled: boolean } => ({
    disabled: (raw ?? '').split(',').some((token) => token.trim() === 'terminal-input'),
  }),
};

describe('ShareDiagnosticsService', () => {
  it('returns exact owner remediation when relay trust is missing', () => {
    const dir = join(tmpdir(), `kookr-share-diag-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.env'), `${RELAY_TRUSTED_ENV_NAME}=true\n`);
    const service = new ShareDiagnosticsService({
      serverCwd: dir,
      processStartedAt: '2026-05-17T00:00:00.000Z',
      getRemoteNodeStatus: () => remoteStatus(),
      getRelayConfigured: () => true,
      getTerminalAdapterAvailable: () => true,
      getPolicySynced: () => true,
      ...diagnosticTrustDeps,
      env: {},
    });

    expect(service.diagnoseTerminalSharing(share())).toEqual(expect.objectContaining({
      state: 'blocked',
      reason: 'nodeUntrusted',
      message: `Terminal sharing is disabled for this node. Set ${RELAY_TRUSTED_ENV_NAME}=true in ${join(dir, '.env')} and restart with pnpm prod:restart.`,
      remediation: expect.objectContaining({
        kind: 'setEnvAndRestart',
        envName: RELAY_TRUSTED_ENV_NAME,
        expectedValue: 'true',
        requiresRestart: true,
        command: 'pnpm prod:restart',
      }),
    }));
  });

  it('reports an approved grant with unavailable advertised node features', () => {
    const service = new ShareDiagnosticsService({
      serverCwd: '/tmp/kookr',
      processStartedAt: '2026-05-17T00:00:00.000Z',
      getRemoteNodeStatus: () => remoteStatus({ features: { enabled: ['policy-sync'], disabled: [] } }),
      getRelayConfigured: () => true,
      getTerminalAdapterAvailable: () => true,
      getPolicySynced: () => true,
      ...diagnosticTrustDeps,
      env: { [RELAY_TRUSTED_ENV_NAME]: 'true' },
    });

    expect(service.diagnoseTerminalSharing(share({ grants: ['view', 'terminalInput'] }))).toEqual(expect.objectContaining({
      state: 'blocked',
      reason: 'nodeFeatureUnavailable',
    }));
  });

  it('derives terminal adapter availability from backend error state', () => {
    expect(terminalAdapterAvailableFromStats({
      attachedSessions: 0,
      reattachCounts: {},
      pendingWriters: 0,
      lastError: { kind: 'dtach-unavailable', binary: 'dtach' },
      errorCount: 1,
    })).toBe(false);
    expect(terminalAdapterAvailableFromStats({
      attachedSessions: 0,
      reattachCounts: {},
      pendingWriters: 1,
      lastError: { kind: 'write-timed-out', id: 'session-1', durationMs: 2000 },
      errorCount: 1,
    })).toBe(true);
  });
});
