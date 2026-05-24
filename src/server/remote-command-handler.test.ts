import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildPermissionRequestBinding } from '../shared/contracts/permission-request-binding.js';
import type { AgentEvent } from '../core/types.js';
import { executeWithPipeline } from '../remote/command-pipeline.js';
import { CommandJournal, type CommandEnvelope, type CommandResult } from '../remote/command-journal.js';
import { grantForRemoteCommandAction } from '../remote/grants.js';
import { RemotePermissionBroker } from '../remote/permission-broker.js';
import { LOCAL_OWNER_ID } from './auth.js';
import { configureRemoteCommandHandler, type RemoteCommandHandlerDeps } from './remote-command-handler.js';

const permissionEvent: AgentEvent = {
  type: 'permission_request',
  sessionId: 'session-1',
  toolName: 'Bash',
  toolInput: { command: 'git status' },
  eventSeq: 1,
};
const detectedAt = new Date('2026-05-15T19:00:00.000Z');

function makePermissionApproveCommand(payload: unknown): CommandEnvelope {
  return {
    commandId: 'cmd-1',
    actorId: LOCAL_OWNER_ID,
    clientId: 'client-1',
    nodeId: 'node-1',
    nodeEpoch: '1',
    sessionId: 'session-1',
    sessionEpoch: '1',
    grantId: 'owner-local:node-1',
    idempotencyKey: 'idem-1',
    action: 'permissionApprove',
    baseRevision: 1,
    payload,
  } as unknown as CommandEnvelope;
}

describe('configureRemoteCommandHandler', () => {
  test('forwards permission request binding payload to the permission broker', async () => {
    let commandHandler: ((command: CommandEnvelope) => Promise<CommandResult>) | null = null;
    const approve = vi.fn(async () => ({ keystroke: '2' }));
    class FakeRemotePermissionBroker {
      approve = approve;
    }
    const permissionRequest = {
      requestId: 'request-1',
      toolName: 'Bash',
      toolInputHash: 'hash-1',
      detectedAt: '2026-05-15T19:00:00.000Z',
      ttlMs: 300000,
    };
    const payload = { keystroke: '2', permissionRequest };

    await configureRemoteCommandHandler({
      runtime: {
        executeWithPipeline: async ({ handler, request }) => {
          const authorization = await handler.authorize(request);
          expect(authorization).toEqual({ ok: true });
          const validation = await handler.validate(request);
          expect(validation).toEqual({ ok: true });
          return {
            commandId: request.commandId,
            action: request.action,
            outcome: 'accepted',
            result: await handler.execute(request),
          };
        },
        grantForRemoteCommandAction: vi.fn(() => 'permissionApprove'),
        RemotePermissionBroker: FakeRemotePermissionBroker,
        evaluateGrantById: vi.fn(),
        isPresetReplyId: vi.fn(),
        sendPresetReply: vi.fn(),
      } as unknown as RemoteCommandHandlerDeps['runtime'],
      remoteNodeClient: {
        setCommandHandler: (handler) => { commandHandler = handler; },
      } as unknown as RemoteCommandHandlerDeps['remoteNodeClient'],
      commandJournal: {} as unknown as RemoteCommandHandlerDeps['commandJournal'],
      adapter: {} as unknown as RemoteCommandHandlerDeps['adapter'],
      monitor: {} as unknown as RemoteCommandHandlerDeps['monitor'],
      queue: {} as unknown as RemoteCommandHandlerDeps['queue'],
      interactionLog: {} as unknown as RemoteCommandHandlerDeps['interactionLog'],
      abortPendingSuggestion: vi.fn(),
      taskStore: {
        findTaskBySession: vi.fn(() => ({
          id: 'task-1',
          sessions: [{ tmuxSession: 'session-1' }],
        })),
      } as unknown as RemoteCommandHandlerDeps['taskStore'],
      remotePolicyCache: null,
      markDone: vi.fn(),
      remoteInputAdapter: null,
      controllerLeaseManager: null,
    });

    expect(commandHandler).toBeTypeOf('function');
    await commandHandler!({
      type: 'remote.command',
      commandId: 'cmd-1',
      actorId: LOCAL_OWNER_ID,
      clientId: 'client-1',
      nodeId: 'node-1',
      nodeEpoch: '1',
      sessionId: 'session-1',
      sessionEpoch: '1',
      grantId: 'owner-local:node-1',
      idempotencyKey: 'idem-1',
      action: 'permissionApprove',
      baseRevision: 1,
      payload,
    } as unknown as CommandEnvelope);

    expect(approve).toHaveBeenCalledWith('session-1', '2', LOCAL_OWNER_ID, payload);
  });

  test('rejects unbound permissionApprove through the real broker and command pipeline', async () => {
    let commandHandler: ((command: CommandEnvelope) => Promise<CommandResult>) | null = null;
    const sendKeystroke = vi.fn(async () => {});
    const recordInputReceived = vi.fn();
    const tempDir = await mkdtemp(join(tmpdir(), 'kookr-remote-command-handler-'));
    const commandJournal = await CommandJournal.open({
      kookrDir: tempDir,
      nodeId: 'node-1' as never,
      nodeEpoch: '1' as never,
      now: () => new Date('2026-05-15T19:01:00.000Z'),
    });

    try {
      await configureRemoteCommandHandler({
        runtime: {
          executeWithPipeline,
          grantForRemoteCommandAction,
          RemotePermissionBroker,
          evaluateGrantById: vi.fn(),
          isPresetReplyId: vi.fn(),
          sendPresetReply: vi.fn(),
        } as unknown as RemoteCommandHandlerDeps['runtime'],
        remoteNodeClient: {
          setCommandHandler: (handler) => { commandHandler = handler; },
        } as unknown as RemoteCommandHandlerDeps['remoteNodeClient'],
        commandJournal,
        adapter: { sendKeystroke } as unknown as RemoteCommandHandlerDeps['adapter'],
        monitor: {
          isPermissionBlocked: vi.fn(() => true),
          markInputReceived: vi.fn(() => true),
          getAgentEvents: vi.fn(() => [permissionEvent]),
        } as unknown as RemoteCommandHandlerDeps['monitor'],
        watchdog: { recordInputReceived },
        queue: {
          getAnomaly: vi.fn(() => ({
            agentId: 'session-1',
            type: 'permission_blocked',
            severity: 'warning',
            explanation: 'permission',
            detectedAt,
          })),
          respondAndAdvance: vi.fn(),
        } as unknown as RemoteCommandHandlerDeps['queue'],
        interactionLog: { append: vi.fn() } as unknown as RemoteCommandHandlerDeps['interactionLog'],
        abortPendingSuggestion: vi.fn(),
        taskStore: {
          findTaskBySession: vi.fn(() => ({
            id: 'task-1',
            sessions: [{ tmuxSession: 'session-1' }],
          })),
        } as unknown as RemoteCommandHandlerDeps['taskStore'],
        remotePolicyCache: null,
        markDone: vi.fn(),
        remoteInputAdapter: null,
        controllerLeaseManager: null,
        now: () => new Date('2026-05-15T19:01:00.000Z'),
      });

      expect(commandHandler).toBeTypeOf('function');
      const missing = await commandHandler!(makePermissionApproveCommand({ keystroke: '1' }));
      expect(missing).toMatchObject({
        outcome: 'rejected',
        reason: 'missing permission request binding',
      });
      expect(sendKeystroke).not.toHaveBeenCalled();

      const permissionRequest = buildPermissionRequestBinding({
        sessionId: 'session-1',
        event: permissionEvent,
        detectedAt,
      });
      const mismatched = await commandHandler!({
        ...makePermissionApproveCommand({
          keystroke: '1',
          permissionRequest: { ...permissionRequest, toolInputHash: 'stale-hash' },
        }),
        commandId: 'cmd-2' as never,
        idempotencyKey: 'idem-2' as never,
      });
      expect(mismatched).toMatchObject({
        outcome: 'rejected',
        reason: 'permission request input mismatch',
      });
      expect(sendKeystroke).not.toHaveBeenCalled();

      const accepted = await commandHandler!({
        ...makePermissionApproveCommand({
          keystroke: '1',
          permissionRequest,
        }),
        commandId: 'cmd-3' as never,
        idempotencyKey: 'idem-3' as never,
      });
      expect(accepted).toMatchObject({
        outcome: 'accepted',
        result: { keystroke: '1', permissionRequest },
      });
      expect(sendKeystroke).toHaveBeenCalledWith('session-1', '1');
      expect(recordInputReceived).toHaveBeenCalledWith('session-1');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('logs finding resolutions for remote preset replies and submitted messages', async () => {
    let commandHandler: ((command: CommandEnvelope) => Promise<CommandResult>) | null = null;
    const append = vi.fn(async () => {});
    const sendPresetReply = vi.fn(async () => ({ text: 'continue' }));
    const submit = vi.fn(async () => ({ accepted: true }));
    const recordInputReceived = vi.fn();
    const anomaly = {
      agentId: 'session-1',
      type: 'needs_input',
      severity: 'info',
      confidence: 'high',
      explanation: 'waiting',
      detectedAt: new Date('2026-05-15T19:00:00.000Z'),
    };

    await configureRemoteCommandHandler({
      runtime: {
        executeWithPipeline: async ({ handler, request }) => {
          const authorization = await handler.authorize(request);
          expect(authorization).toEqual({ ok: true });
          const validation = await handler.validate(request);
          expect(validation).toEqual({ ok: true });
          return {
            commandId: request.commandId,
            action: request.action,
            outcome: 'accepted',
            result: await handler.execute(request),
          };
        },
        grantForRemoteCommandAction: vi.fn(),
        RemotePermissionBroker: vi.fn(),
        evaluateGrantById: vi.fn(),
        isPresetReplyId: vi.fn(() => true),
        sendPresetReply,
      } as unknown as RemoteCommandHandlerDeps['runtime'],
      remoteNodeClient: {
        setCommandHandler: (handler) => { commandHandler = handler; },
      } as unknown as RemoteCommandHandlerDeps['remoteNodeClient'],
      commandJournal: {} as unknown as RemoteCommandHandlerDeps['commandJournal'],
      adapter: {} as unknown as RemoteCommandHandlerDeps['adapter'],
      monitor: {
        markInputReceived: vi.fn(() => true),
      } as unknown as RemoteCommandHandlerDeps['monitor'],
      watchdog: { recordInputReceived },
      queue: {
        getAnomaly: vi.fn(() => anomaly),
        respondAndAdvance: vi.fn(),
      } as unknown as RemoteCommandHandlerDeps['queue'],
      interactionLog: { append } as unknown as RemoteCommandHandlerDeps['interactionLog'],
      abortPendingSuggestion: vi.fn(),
      taskStore: {
        findTaskBySession: vi.fn(() => ({
          id: 'task-1',
          sessions: [{ tmuxSession: 'session-1' }],
        })),
      } as unknown as RemoteCommandHandlerDeps['taskStore'],
      remotePolicyCache: null,
      markDone: vi.fn(),
      remoteInputAdapter: { submit } as unknown as RemoteCommandHandlerDeps['remoteInputAdapter'],
      controllerLeaseManager: null,
      now: () => new Date('2026-05-15T19:01:00.000Z'),
    });

    expect(commandHandler).toBeTypeOf('function');
    await commandHandler!({
      commandId: 'cmd-preset',
      actorId: LOCAL_OWNER_ID,
      clientId: 'client-1',
      nodeId: 'node-1',
      nodeEpoch: '1',
      sessionId: 'session-1',
      sessionEpoch: '1',
      grantId: 'owner-local:node-1',
      idempotencyKey: 'idem-preset',
      action: 'presetReply',
      baseRevision: 1,
      payload: { presetId: 'continue' },
    } as unknown as CommandEnvelope);
    await commandHandler!({
      commandId: 'cmd-submit',
      actorId: LOCAL_OWNER_ID,
      clientId: 'client-1',
      nodeId: 'node-1',
      nodeEpoch: '1',
      sessionId: 'session-1',
      sessionEpoch: '1',
      grantId: 'owner-local:node-1',
      idempotencyKey: 'idem-submit',
      action: 'submitMessage',
      leaseId: 'lease-1',
      baseRevision: 1,
      lastSeenSeq: 0,
      payload: {
        type: 'submit-message',
        sessionId: 'session-1',
        sessionEpoch: '1',
        leaseId: 'lease-1',
        commandId: 'cmd-submit',
        idempotencyKey: 'idem-submit',
        text: 'hello remote',
        appendNewline: true,
        baseRevision: 1,
        lastSeenSeq: 0,
        maxAgeMs: 10_000,
      },
    } as unknown as CommandEnvelope);

    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user_input',
      agentId: 'session-1',
      content: 'continue',
      timestamp: '2026-05-15T19:01:00.000Z',
    }));
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user_input',
      agentId: 'session-1',
      content: 'hello remote',
      timestamp: '2026-05-15T19:01:00.000Z',
    }));
    expect(append).toHaveBeenCalledTimes(4);
    expect(append).toHaveBeenCalledWith({
      type: 'finding_resolved',
      agentId: 'session-1',
      anomalyType: 'needs_input',
      method: 'input',
      durationMs: 60_000,
      timestamp: '2026-05-15T19:01:00.000Z',
    });
    expect(recordInputReceived).toHaveBeenCalledTimes(2);
    expect(recordInputReceived).toHaveBeenCalledWith('session-1');
  });
});
