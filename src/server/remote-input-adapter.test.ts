import { describe, expect, it } from 'vitest';

import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { ControllerLeaseManager } from '../remote/controller-lease.js';
import {
  asActorId,
  asClientId,
  asCommandId,
  asGrantId,
  asIdempotencyKey,
  asLeaseId,
  asNodeEpoch,
  asNodeId,
  asSeq,
  asServerRevision,
  asSessionEpoch,
  asSessionId,
} from '../remote/ids.js';
import { createRemoteInputAdapter, type SubmitMessageCommand } from './remote-input-adapter.js';

function command(overrides: Partial<SubmitMessageCommand> = {}): SubmitMessageCommand {
  const base = {
    actorId: asActorId('owner-1'),
    clientId: asClientId('client-1'),
    commandId: asCommandId('command-1'),
    nodeId: asNodeId('node-1'),
    nodeEpoch: asNodeEpoch('1'),
    sessionId: asSessionId('s1'),
    sessionEpoch: asSessionEpoch('1'),
    action: 'submitMessage' as const,
    grantId: asGrantId('owner-local:node-1'),
    idempotencyKey: asIdempotencyKey('idem-1'),
    leaseId: asLeaseId('lease-1'),
    baseRevision: 1,
    lastSeenSeq: asSeq(4),
    payload: {
      type: 'submit-message' as const,
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      leaseId: asLeaseId('lease-1'),
      commandId: asCommandId('command-1'),
      idempotencyKey: asIdempotencyKey('idem-1'),
      text: 'hello from relay',
      appendNewline: true,
      baseRevision: 1,
      lastSeenSeq: asSeq(4),
      maxAgeMs: 10_000,
    },
  } satisfies SubmitMessageCommand;
  return { ...base, ...overrides };
}

function leaseManager() {
  let revision = 0;
  return new ControllerLeaseManager({
    nodeId: asNodeId('node-1'),
    nodeEpoch: asNodeEpoch('1'),
    nextServerRevision: () => asServerRevision(++revision),
    publish: () => undefined,
  });
}

describe('remote input adapter', () => {
  it('checks the remote controller lease before writing semantic submitted text', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s1', 'bash');
    const leases = leaseManager();
    leases.acquireRemote({
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
      leaseId: asLeaseId('lease-1'),
    });
    const adapter = await createRemoteInputAdapter({ terminalBackend: backend, leaseManager: leases });

    await expect(adapter.submit(command())).resolves.toEqual({ bytesWritten: 17, appendNewline: true });

    expect(backend.getWrittenText('s1')).toBe('hello from relay\r');
  });

  it('rejects stale holder commands after owner override without writing', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s1', 'bash');
    const leases = leaseManager();
    leases.acquireRemote({
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
      leaseId: asLeaseId('lease-1'),
    });
    leases.acquireLocal({
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
    });
    const adapter = await createRemoteInputAdapter({ terminalBackend: backend, leaseManager: leases });

    await expect(adapter.submit(command())).rejects.toThrow('error.leaseRevoked');

    expect(backend.getWrittenText('s1')).toBe('');
  });

  it('rejects submissions from stale terminal cursors before writing', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s1', 'bash');
    const leases = leaseManager();
    leases.acquireRemote({
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
      leaseId: asLeaseId('lease-1'),
    });
    const adapter = await createRemoteInputAdapter({
      terminalBackend: backend,
      leaseManager: leases,
      getCurrentSeq: () => 5,
    });

    await expect(adapter.submit(command())).rejects.toThrow('error.staleTerminalView');

    expect(backend.getWrittenText('s1')).toBe('');
  });
});
