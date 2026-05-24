import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import type { Monitor } from '../core/monitor.js';
import type { Watchdog } from '../core/watchdog.js';
import type { TaskStore } from '../core/tasks.js';
import type { executeWithPipeline } from '../remote/command-pipeline.js';
import type { CommandJournal } from '../remote/command-journal.js';
import type { ControllerLeaseManager } from '../remote/controller-lease.js';
import type { grantForRemoteCommandAction } from '../remote/grants.js';
import type { RemoteLaunchBroker } from '../remote/launch-broker.js';
import type { RemoteNodeClient } from '../remote/node-client.js';
import type { RemotePermissionBroker } from '../remote/permission-broker.js';
import type { RemotePolicyCache } from '../remote/policy-cache.js';
import type { ShareSubject } from '../remote/policy-sync.js';
import type { evaluateGrantById } from '../remote/share-policy.js';
import type { isPresetReplyId, sendPresetReply } from '../remote/preset-reply.js';
import type { NodeId } from '../remote/ids.js';
import { isOwnerLocal } from './auth.js';
import { isSubmitMessageCommand, type RemoteInputAdapter } from './remote-input-adapter.js';

export interface RemoteCommandHandlerRuntime {
  executeWithPipeline: typeof executeWithPipeline;
  grantForRemoteCommandAction: typeof grantForRemoteCommandAction;
  RemotePermissionBroker: typeof RemotePermissionBroker;
  evaluateGrantById: typeof evaluateGrantById;
  isPresetReplyId: typeof isPresetReplyId;
  sendPresetReply: typeof sendPresetReply;
}

export interface RemoteCommandHandlerDeps {
  runtime: RemoteCommandHandlerRuntime;
  remoteNodeClient: RemoteNodeClient | null;
  commandJournal: CommandJournal | null;
  adapter: AgentAdapter;
  monitor: Monitor;
  watchdog?: Pick<Watchdog, 'recordInputReceived'>;
  queue: AttentionQueue;
  interactionLog: DeferredInteractionLogWriter;
  abortPendingSuggestion: (agentId: string, outcome?: 'used' | 'cleared') => void;
  taskStore: TaskStore;
  remotePolicyCache: RemotePolicyCache | null;
  bypassAllPermissions?: boolean;
  remoteLaunchBroker?: RemoteLaunchBroker;
  markDone: (taskId: string) => Promise<void>;
  remoteInputAdapter: RemoteInputAdapter | null;
  controllerLeaseManager: ControllerLeaseManager | null;
  now?: () => Date;
}

export async function configureRemoteCommandHandler(deps: RemoteCommandHandlerDeps): Promise<void> {
  const {
    runtime,
    remoteNodeClient,
    commandJournal,
    adapter,
    monitor,
    watchdog,
    queue,
    interactionLog,
    abortPendingSuggestion,
    taskStore,
    remotePolicyCache,
    bypassAllPermissions,
    remoteLaunchBroker,
    markDone,
    remoteInputAdapter,
    controllerLeaseManager,
    now,
  } = deps;

  if (!remoteNodeClient || !commandJournal) return;

  const subjectsForCommand = (command: { action: string; nodeId: string; sessionId: string }): ShareSubject[] => {
    const nodeSubject: ShareSubject = { kind: 'node', nodeId: command.nodeId as NodeId };
    const sessionSubject: ShareSubject = {
      kind: 'session',
      nodeId: command.nodeId as NodeId,
      sessionId: command.sessionId,
    };
    const task = taskStore.findTaskBySession(command.sessionId);
    const taskSubject: ShareSubject | null = task
      ? { kind: 'task', nodeId: command.nodeId as NodeId, taskId: task.id }
      : null;
    return command.action === 'launch'
      ? [nodeSubject, ...(taskSubject ? [taskSubject] : [])]
      : [sessionSubject, ...(taskSubject ? [taskSubject] : [])];
  };

  const permissionBroker = new runtime.RemotePermissionBroker({
    adapter,
    monitor,
    watchdog,
    queue,
    interactionLog,
    onRespond: abortPendingSuggestion,
    now,
  });

  remoteNodeClient.setCommandHandler(async (command) => {
    const authorize = () => {
      if (command.grantId === `owner-local:${command.nodeId}`) {
        if (!isOwnerLocal({ actorId: command.actorId })) {
          return { ok: false as const, reason: 'owner identity required' };
        }
      } else {
        const requiredGrant = runtime.grantForRemoteCommandAction(command.action);
        if (!remotePolicyCache || !requiredGrant) return { ok: false as const, reason: 'invalid grant' };
        const decisions = subjectsForCommand(command)
          .map((subject) => runtime.evaluateGrantById(remotePolicyCache, command.grantId, subject, requiredGrant));
        const decision = decisions.find((candidate) => candidate.allowed) ?? decisions[0];
        if (!decision.allowed) {
          return { ok: false as const, reason: `grant ${decision.reason}` };
        }
        if (
          bypassAllPermissions
          && (command.action === 'permissionApprove' || command.action === 'launch')
        ) {
          return {
            ok: false as const,
            reason: 'unsafe local permission mode requires local owner confirmation',
          };
        }
      }
      const task = taskStore.findTaskBySession(command.sessionId);
      if (!task) return { ok: false as const, reason: 'unknown session' };
      const session = task.sessions.find((candidate) => candidate.tmuxSession === command.sessionId);
      const liveSession = session && session.lastStatus !== 'completed' && session.lastStatus !== 'aborted';
      if (!liveSession) return { ok: false as const, reason: 'session is not live' };
      if (command.action === 'mark-done') {
        const taskId = (command.payload as { taskId?: unknown } | undefined)?.taskId;
        if (taskId !== task.id) return { ok: false as const, reason: 'task/session mismatch' };
      }
      return { ok: true as const };
    };

    const baseValidate = () => {
      if (command.baseRevision !== undefined && command.baseRevision < 0) {
        return { ok: false as const, reason: 'stale baseRevision' };
      }
      return { ok: true as const };
    };

    switch (command.action) {
      case 'presetReply':
        return await runtime.executeWithPipeline({
          journal: commandJournal,
          request: command,
          isOwnerLocal,
          handler: {
            action: 'presetReply',
            authorize,
            validate: () => {
              const valid = baseValidate();
              if (!valid.ok) return valid;
              const presetId = (command.payload as { presetId?: unknown } | undefined)?.presetId;
              return runtime.isPresetReplyId(presetId)
                ? { ok: true as const }
                : { ok: false as const, reason: 'invalid presetId' };
            },
            execute: async () => {
              const presetId = (command.payload as { presetId: Parameters<typeof sendPresetReply>[2] }).presetId;
              const result = await runtime.sendPresetReply(adapter, command.sessionId, presetId);
              const preAnomaly = queue.getAnomaly(command.sessionId);
              if (monitor.markInputReceived(command.sessionId)) {
                watchdog?.recordInputReceived(command.sessionId);
              }
              queue.respondAndAdvance(command.sessionId);
              abortPendingSuggestion(command.sessionId, 'used');
              const timestamp = (now?.() ?? new Date()).toISOString();
              await interactionLog.append({
                type: 'user_input',
                agentId: command.sessionId,
                content: result.text,
                timestamp,
              });
              if (preAnomaly) {
                await interactionLog.append({
                  type: 'finding_resolved',
                  agentId: command.sessionId,
                  anomalyType: preAnomaly.type,
                  method: 'input',
                  durationMs: new Date(timestamp).getTime() - preAnomaly.detectedAt.getTime(),
                  timestamp,
                });
              }
              return result;
            },
          },
        });
      case 'permissionApprove':
        return await runtime.executeWithPipeline({
          journal: commandJournal,
          request: command,
          isOwnerLocal,
          handler: {
            action: 'permissionApprove',
            authorize,
            validate: () => {
              const valid = baseValidate();
              if (!valid.ok) return valid;
              const keystroke = (command.payload as { keystroke?: unknown } | undefined)?.keystroke;
              return keystroke === undefined || typeof keystroke === 'string'
                ? { ok: true as const }
                : { ok: false as const, reason: 'invalid keystroke' };
            },
            execute: async () => await permissionBroker.approve(
              command.sessionId,
              (command.payload as { keystroke?: string } | undefined)?.keystroke ?? '1',
              command.actorId,
              command.payload as { keystroke?: unknown; permissionRequest?: unknown } | undefined,
            ),
          },
        });
      case 'skip':
        return await runtime.executeWithPipeline({
          journal: commandJournal,
          request: command,
          isOwnerLocal,
          handler: {
            action: 'skip',
            authorize,
            validate: baseValidate,
            execute: async () => {
              const anomaly = queue.getAnomaly(command.sessionId);
              const anomalyType = anomaly?.type ?? 'needs_input';
              queue.skip(command.sessionId);
              await interactionLog.append({
                type: 'finding_skipped',
                agentId: command.sessionId,
                anomalyType,
                timestamp: new Date().toISOString(),
              });
              return { skipped: true };
            },
          },
        });
      case 'snooze':
        return await runtime.executeWithPipeline({
          journal: commandJournal,
          request: command,
          isOwnerLocal,
          handler: {
            action: 'snooze',
            authorize,
            validate: () => {
              const valid = baseValidate();
              if (!valid.ok) return valid;
              const durationMs = (command.payload as { durationMs?: unknown } | undefined)?.durationMs;
              return typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
                ? { ok: true as const }
                : { ok: false as const, reason: 'invalid durationMs' };
            },
            execute: async () => {
              const anomaly = queue.getAnomaly(command.sessionId);
              const durationMs = (command.payload as { durationMs: number }).durationMs;
              const snooze = queue.snooze(command.sessionId, durationMs, 'remote', anomaly ?? undefined);
              if (!snooze) throw new Error('nothing to snooze');
              await interactionLog.append({
                type: 'finding_snoozed',
                agentId: command.sessionId,
                durationMs,
                anomalyType: anomaly?.type,
                timestamp: new Date().toISOString(),
              });
              return { snoozedUntil: snooze.expiresAt };
            },
          },
        });
      case 'mark-done':
        return await runtime.executeWithPipeline({
          journal: commandJournal,
          request: command,
          isOwnerLocal,
          handler: {
            action: 'mark-done',
            authorize,
            validate: () => {
              const valid = baseValidate();
              if (!valid.ok) return valid;
              const taskId = (command.payload as { taskId?: unknown } | undefined)?.taskId;
              return typeof taskId === 'string' && taskStore.getTask(taskId)
                ? { ok: true as const }
                : { ok: false as const, reason: 'unknown taskId' };
            },
            execute: async () => {
              const taskId = (command.payload as { taskId: string }).taskId;
              await markDone(taskId);
              return { taskId };
            },
          },
        });
      case 'launch': {
        if (!remoteLaunchBroker) {
          return await commandJournal.appendPreAuditReject(command, 'launch feature disabled');
        }
        const launchCommand = {
          ...command,
          grantsChecked: ['launch' as const],
        } as Parameters<typeof remoteLaunchBroker.handle>[0];
        return await runtime.executeWithPipeline({
          journal: commandJournal,
          request: launchCommand,
          isOwnerLocal,
          handler: remoteLaunchBroker,
        });
      }
      case 'leaseAcquire': {
        if (!remoteInputAdapter || !controllerLeaseManager) {
          return await commandJournal.appendPreAuditReject(command, 'terminal input feature disabled');
        }
        return await runtime.executeWithPipeline({
          journal: commandJournal,
          request: command,
          isOwnerLocal,
          handler: {
            action: 'leaseAcquire',
            authorize,
            validate: baseValidate,
            execute: async () => {
              const requestedLeaseId = (command.payload as { leaseId?: unknown } | undefined)?.leaseId;
              const acquired = controllerLeaseManager.acquireRemote({
                sessionId: command.sessionId,
                sessionEpoch: command.sessionEpoch,
                actorId: command.actorId,
                clientId: command.clientId,
                ...(typeof requestedLeaseId === 'string'
                  ? { leaseId: requestedLeaseId as NonNullable<typeof command.leaseId> }
                  : {}),
              });
              if (!acquired.ok) throw new Error(acquired.reason);
              return { leaseId: acquired.lease.leaseId };
            },
          },
        });
      }
      case 'leaseHeartbeat': {
        if (!remoteInputAdapter || !controllerLeaseManager) {
          return await commandJournal.appendPreAuditReject(command, 'terminal input feature disabled');
        }
        return await runtime.executeWithPipeline({
          journal: commandJournal,
          request: command,
          isOwnerLocal,
          handler: {
            action: 'leaseHeartbeat',
            authorize,
            validate: () => {
              const valid = baseValidate();
              if (!valid.ok) return valid;
              return typeof command.leaseId === 'string'
                ? { ok: true as const }
                : { ok: false as const, reason: 'missing leaseId' };
            },
            execute: async () => {
              const missed = (command.payload as { missed?: unknown } | undefined)?.missed === true;
              const result = missed
                ? controllerLeaseManager.recordHeartbeatMiss({
                  sessionId: command.sessionId,
                  leaseId: command.leaseId!,
                  actorId: command.actorId,
                  clientId: command.clientId,
                })
                : controllerLeaseManager.recordHeartbeatAck({
                  sessionId: command.sessionId,
                  leaseId: command.leaseId!,
                  actorId: command.actorId,
                  clientId: command.clientId,
                });
              if (!result.ok) throw new Error(result.reason);
              return {
                leaseId: result.lease.leaseId,
                state: result.lease.state,
                heartbeatMisses: result.lease.heartbeatMisses,
              };
            },
          },
        });
      }
      case 'leaseOverride': {
        if (!remoteInputAdapter || !controllerLeaseManager) {
          return await commandJournal.appendPreAuditReject(command, 'terminal input feature disabled');
        }
        return await runtime.executeWithPipeline({
          journal: commandJournal,
          request: command,
          isOwnerLocal,
          handler: {
            action: 'leaseOverride',
            authorize,
            validate: baseValidate,
            execute: async () => {
              controllerLeaseManager.revoke(command.sessionId, 'owner-override');
              return { revoked: true };
            },
          },
        });
      }
      case 'submitMessage': {
        if (!remoteInputAdapter) {
          return await commandJournal.appendPreAuditReject(command, 'terminal input feature disabled');
        }
        return await runtime.executeWithPipeline({
          journal: commandJournal,
          request: command,
          isOwnerLocal,
          handler: {
            action: 'submitMessage',
            authorize,
            validate: () => {
              const valid = baseValidate();
              if (!valid.ok) return valid;
              if (!isSubmitMessageCommand(command)) {
                return { ok: false as const, reason: 'invalid submit message' };
              }
              return { ok: true as const };
            },
            execute: async () => {
              if (!isSubmitMessageCommand(command)) throw new Error('invalid submit message');
              const result = await remoteInputAdapter.submit(command);
              const preAnomaly = queue.getAnomaly(command.sessionId);
              if (monitor.markInputReceived(command.sessionId)) {
                watchdog?.recordInputReceived(command.sessionId);
              }
              queue.respondAndAdvance(command.sessionId);
              abortPendingSuggestion(command.sessionId, 'used');
              const timestamp = (now?.() ?? new Date()).toISOString();
              await interactionLog.append({
                type: 'user_input',
                agentId: command.sessionId,
                content: command.payload.text,
                timestamp,
              });
              if (preAnomaly) {
                await interactionLog.append({
                  type: 'finding_resolved',
                  agentId: command.sessionId,
                  anomalyType: preAnomaly.type,
                  method: 'input',
                  durationMs: new Date(timestamp).getTime() - preAnomaly.detectedAt.getTime(),
                  timestamp,
                });
              }
              return result;
            },
          },
        });
      }
    }
  });
}
