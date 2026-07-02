import { randomBytes } from 'node:crypto';

import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import type { TerminalInputWriterPort } from '../core/ports/terminal-input-writer-port.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { BuildInfo } from '../core/build-info.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import type { Monitor } from '../core/monitor.js';
import type { TaskStore } from '../core/tasks.js';
import type { Watchdog } from '../core/watchdog.js';
import { createRelayConnectionManager, type RelayConnectionManager, type RelayRuntimeHandle } from './relay-connection-manager.js';
import type { RelayConnectionCredentials } from './relay-connection-store.js';
import { createRelayShareClient } from './relay-share-client.js';
import { configureRemoteCommandHandler } from './remote-command-handler.js';
import type { RemoteInputAdapter } from './remote-input-adapter.js';
import type { RemoteShareDeps } from './remote-share-deps.js';
import { ShareDiagnosticsService, terminalAdapterAvailableFromStats } from './share-diagnostics-service.js';
import { TaskShareService } from './task-share-service.js';
import type { CommandJournal } from '../remote/command-journal.js';
import type { ControllerLeaseManager } from '../remote/controller-lease.js';
import type { ServerRevision, SessionEpoch, SessionId } from '../remote/ids.js';
import type { RemoteLaunchBroker } from '../remote/launch-broker.js';
import type { RemoteNodeClient } from '../remote/node-client.js';
import type { RemotePolicyCache } from '../remote/policy-cache.js';
import type { PushAlertOutbox } from '../remote/push.js';
import type { SessionStreamPublisher } from '../remote/session-stream-publisher.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface RemoteRelayRuntimeDeps {
  kookrDir: string;
  serverCwd: string;
  serverStartedAt: string;
  buildInfo: BuildInfo;
  terminalBackend: TerminalBackend;
  terminalInputWriter?: TerminalInputWriterPort;
  taskStore: TaskStore;
  queue: AttentionQueue;
  monitor: Monitor;
  adapter: AgentAdapter;
  watchdog: Watchdog;
  interactionLog: DeferredInteractionLogWriter;
  abortPendingSuggestion: (agentId: string, outcome?: 'used' | 'cleared') => void;
  bypassAllPermissions?: boolean;
  remoteLaunchBroker?: RemoteLaunchBroker;
  markDone: (taskId: string) => Promise<void>;
}

export interface RemoteCommandAuditArchiveRetentionConfig {
  maxArchiveCount?: number;
  maxArchiveAgeMs?: number;
}

export interface RemoteRelayRuntime {
  readonly remoteShare: RemoteShareDeps;
  readonly relayConnection: RelayConnectionManager;
  readonly controllerLeaseManager: ControllerLeaseManager | null;
  readonly remoteInputAdapter: RemoteInputAdapter | null;
  startConfigured(): Promise<void>;
  stop(): Promise<void>;
  recordLocalTerminalActivity(sessionId: string): void;
  publishTaskProjectionForTask(taskId: string): void;
  publishPermissionBlocked(taskId: string): void;
}

export async function publishPermissionBlockedPushAlert(opts: {
  taskId: string;
  taskStore: Pick<TaskStore, 'getTask'>;
  remoteNodeClient: RemoteNodeClient | null;
  outbox: PushAlertOutbox;
  env?: Partial<Pick<NodeJS.ProcessEnv, 'KOOKR_PUSH_DISABLED' | 'KOOKR_RELAY_DISPLAY_NAME'>>;
  now?: () => Date;
}): Promise<boolean> {
  const {
    isPushDisabled,
    makePermissionBlockedPushPayload,
    publishPushAlertDelta,
  } = await import('../remote/push.js');
  const env = opts.env ?? process.env;
  if (!opts.remoteNodeClient || isPushDisabled(env)) return false;
  const task = opts.taskStore.getTask(opts.taskId);
  if (!task) return false;

  const payload = makePermissionBlockedPushPayload({
    nodeDisplayName: env.KOOKR_RELAY_DISPLAY_NAME,
    task,
    alertId: `permission-${opts.taskId}-${Date.now()}`,
  });
  const sent = publishPushAlertDelta(opts.remoteNodeClient, payload, {
    env,
    ...(opts.now ? { now: opts.now } : {}),
  });
  if (!sent) opts.outbox.enqueue(payload);
  return sent;
}

export function readRemoteCommandAuditArchiveRetentionConfig(
  env: Partial<Pick<NodeJS.ProcessEnv,
    'KOOKR_REMOTE_COMMAND_AUDIT_MAX_ARCHIVE_COUNT'
    | 'KOOKR_REMOTE_COMMAND_AUDIT_MAX_ARCHIVE_AGE_DAYS'
  >> = process.env,
): RemoteCommandAuditArchiveRetentionConfig {
  const maxArchiveCount = parseNonNegativeInt(env.KOOKR_REMOTE_COMMAND_AUDIT_MAX_ARCHIVE_COUNT);
  const maxArchiveAgeDays = parseNonNegativeNumber(env.KOOKR_REMOTE_COMMAND_AUDIT_MAX_ARCHIVE_AGE_DAYS);
  return {
    ...(maxArchiveCount !== undefined ? { maxArchiveCount } : {}),
    ...(maxArchiveAgeDays !== undefined ? { maxArchiveAgeMs: maxArchiveAgeDays * MS_PER_DAY } : {}),
  };
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function parseNonNegativeNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export async function createRemoteRelayRuntime(deps: RemoteRelayRuntimeDeps): Promise<RemoteRelayRuntime> {
  let remoteNodeClient: RemoteNodeClient | null = null;
  let sessionStreamPublisher: SessionStreamPublisher | null = null;
  let commandJournal: CommandJournal | null = null;
  let controllerLeaseManager: ControllerLeaseManager | null = null;
  let remoteInputAdapter: RemoteInputAdapter | null = null;
  let remotePolicyCache: RemotePolicyCache | null = null;
  let taskShareService: TaskShareService | null = null;
  let remoteShareRevision = 0;
  let pushAlertOutbox: PushAlertOutbox | null = null;

  const nextRemoteShareRevision = (): ServerRevision => {
    remoteShareRevision += 1;
    return remoteShareRevision as ServerRevision;
  };

  const remoteShare: RemoteShareDeps = {
    csrfToken: randomBytes(16).toString('hex'),
    client: null,
    getShareMaxTtlMs: () => {
      const value = remoteNodeClient?.status.lastRelayHello?.shareMaxTtlMs;
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    },
  };

  const {
    parseTerminalInputKillSwitch,
    RELAY_TRUSTED_ENV_NAME,
    relayTrustedProcessValue,
  } = await import('../remote/handshake.js');
  const { createPushAlertOutbox } = await import('../remote/push.js');
  pushAlertOutbox = createPushAlertOutbox();
  const shareDiagnostics = new ShareDiagnosticsService({
    serverCwd: deps.serverCwd,
    processStartedAt: deps.serverStartedAt,
    getRemoteNodeStatus: () => remoteNodeClient?.status ?? null,
    getRelayConfigured: () => Boolean(remoteShare.client),
    getTerminalAdapterAvailable: () => terminalAdapterAvailableFromStats(deps.terminalBackend.getStats()),
    getPolicySynced: (share) => {
      if (!remotePolicyCache) return false;
      const identity = remoteNodeClient?.status.nodeId;
      if (!identity) return false;
      return remotePolicyCache.snapshot().grants.some((grant) => (
        grant.subject.kind === 'task'
        && grant.subject.nodeId === identity
        && grant.subject.taskId === share.taskId
        && grant.grants.includes('terminalInput')
        && !remotePolicyCache?.hasTombstone(grant.grantId)
        && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now())
      ));
    },
    relayTrustedEnvName: RELAY_TRUSTED_ENV_NAME,
    relayTrustedProcessValue,
    parseTerminalInputKillSwitch,
  });

  const wireRemoteCommandHandler = async (): Promise<void> => {
    if (!remoteNodeClient || !commandJournal) return;
    const [
      { executeWithPipeline },
      { RemotePermissionBroker },
      { grantForRemoteCommandAction },
      { evaluateGrantById },
      { isPresetReplyId, sendPresetReply },
    ] = await Promise.all([
      import('../remote/command-pipeline.js'),
      import('../remote/permission-broker.js'),
      import('../remote/grants.js'),
      import('../remote/share-policy.js'),
      import('../remote/preset-reply.js'),
    ]);
    await configureRemoteCommandHandler({
      runtime: {
        executeWithPipeline,
        RemotePermissionBroker,
        grantForRemoteCommandAction,
        evaluateGrantById,
        isPresetReplyId,
        sendPresetReply,
      },
      remoteNodeClient,
      commandJournal,
      adapter: deps.adapter,
      monitor: deps.monitor,
      watchdog: deps.watchdog,
      queue: deps.queue,
      interactionLog: deps.interactionLog,
      abortPendingSuggestion: deps.abortPendingSuggestion,
      taskStore: deps.taskStore,
      remotePolicyCache,
      bypassAllPermissions: deps.bypassAllPermissions,
      remoteLaunchBroker: deps.remoteLaunchBroker,
      markDone: deps.markDone,
      remoteInputAdapter,
      controllerLeaseManager,
    });
  };

  const stop = async (): Promise<void> => {
    sessionStreamPublisher?.stop();
    sessionStreamPublisher = null;
    remoteNodeClient?.setConnectionObserver(null);
    controllerLeaseManager?.dispose();
    controllerLeaseManager = null;
    remoteInputAdapter = null;
    commandJournal = null;
    await remoteNodeClient?.stop();
    remoteNodeClient = null;
    remotePolicyCache = null;
    taskShareService = null;
    remoteShare.client = null;
    delete remoteShare.service;
    pushAlertOutbox = createPushAlertOutbox();
  };

  const startRuntime = async (credentials: RelayConnectionCredentials): Promise<RelayRuntimeHandle> => {
    await stop();
    const { createRemoteAuditScaffold } = await import('../remote/audit.js');
    const { CommandJournal } = await import('../remote/command-journal.js');
    const { createRemoteNodeClient } = await import('../remote/node-client.js');
    const { ControllerLeaseManager } = await import('../remote/controller-lease.js');
    const { remoteTerminalInputFeatureEnabled } = await import('../remote/handshake.js');
    const { asServerRevision } = await import('../remote/ids.js');
    const { RemotePolicyCache } = await import('../remote/policy-cache.js');

    createRemoteAuditScaffold({ relayUrl: credentials.relayUrl });
    remotePolicyCache = new RemotePolicyCache();
    const nodeClient = await createRemoteNodeClient({
      relayUrl: credentials.relayUrl,
      token: credentials.relayToken,
      kookrDir: deps.kookrDir,
      softwareVersion: deps.buildInfo.version,
      ...(credentials.displayName ? { displayName: credentials.displayName } : {}),
      ...(credentials.publicBaseUrl ? { publicBaseUrl: credentials.publicBaseUrl } : {}),
      onPolicyMessage: async (message) => {
        if (!remotePolicyCache) return;
        if (message.type === 'policy.sync') {
          remotePolicyCache.applySync({
            policyVersion: message.policyVersion,
            grants: message.grants,
            revokedGrantIds: message.revokedGrantIds,
          });
          for (const grantId of message.revokedGrantIds) {
            await commandJournal?.revokeGrant(grantId, message.policyVersion);
          }
          taskShareService?.publishActiveTaskProjections();
          return;
        }
        if (message.type === 'policy.delta') {
          for (const grant of message.upserts) remotePolicyCache.upsert(grant);
          for (const grantId of message.revokes) {
            const grant = remotePolicyCache.get(grantId);
            if (grant?.subject.kind === 'session') {
              controllerLeaseManager?.revoke(grant.subject.sessionId as SessionId, 'policy-revoke');
            }
            remotePolicyCache.revoke(grantId, message.policyVersion);
            await commandJournal?.revokeGrant(grantId, message.policyVersion);
          }
          taskShareService?.publishActiveTaskProjections();
          return;
        }
        if (message.type === 'policy.revoke') {
          const grant = remotePolicyCache.get(message.grantId);
          if (grant?.subject.kind === 'session') {
            controllerLeaseManager?.revoke(grant.subject.sessionId as SessionId, 'policy-revoke');
          }
          remotePolicyCache.revoke(message.grantId, message.policyVersion);
          await commandJournal?.revokeGrant(message.grantId, message.policyVersion);
          taskShareService?.publishActiveTaskProjections();
        }
      },
      onTerminalDemandProof: (message) => {
        const handledByShare = taskShareService?.recordTerminalPublicationDemand(message) ?? false;
        if (handledByShare) return;
        sessionStreamPublisher?.recordDemandProof({
          principal: message.principal,
          sessionId: message.sessionId,
          sessionEpoch: message.sessionEpoch,
          proof: message.proof,
        });
      },
    });
    remoteNodeClient = nodeClient;
    commandJournal = await CommandJournal.open({
      kookrDir: deps.kookrDir,
      nodeId: nodeClient.status.nodeId,
      nodeEpoch: nodeClient.status.nodeEpoch,
      ...readRemoteCommandAuditArchiveRetentionConfig(),
    });
    let leaseRevision = 0;
    controllerLeaseManager = new ControllerLeaseManager({
      nodeId: nodeClient.status.nodeId,
      nodeEpoch: nodeClient.status.nodeEpoch,
      nextServerRevision: () => asServerRevision(++leaseRevision),
      publish: (event) => {
        remoteNodeClient?.publish(event);
      },
    });
    nodeClient.setConnectionObserver((state) => {
      if (state === 'disconnected') controllerLeaseManager?.handleRelayDisconnect();
      else {
        controllerLeaseManager?.handleRelayReconnect();
        const replay = pushAlertOutbox?.flush(nodeClient) ?? { sent: 0, pending: 0 };
        if (replay.sent > 0) {
          console.log(`[remote-push] replayed ${replay.sent} buffered alert(s); pending=${replay.pending}`);
        }
      }
    });
    const { createSessionStreamPublisher } = await import('../remote/session-stream-publisher.js');
    sessionStreamPublisher = createSessionStreamPublisher({
      terminalBackend: deps.terminalBackend,
      remoteNodeClient: nodeClient,
    });
    await sessionStreamPublisher.start();
    if (remoteTerminalInputFeatureEnabled({ ...process.env, KOOKR_RELAY_URL: credentials.relayUrl })) {
      const { createRemoteInputAdapter } = await import('./remote-input-adapter.js');
      remoteInputAdapter = await createRemoteInputAdapter({
        terminalInputWriter: deps.terminalInputWriter,
        terminalBackend: deps.terminalBackend,
        leaseManager: controllerLeaseManager,
        getCurrentSeq: (sessionId, sessionEpoch) => {
          const cursor = sessionStreamPublisher?.currentCursor(sessionId);
          if (!cursor || cursor.sessionEpoch !== sessionEpoch) return null;
          return cursor.lastSeq;
        },
      });
      console.log('[remote] terminal input adapter enabled');
    } else {
      console.log('[remote] terminal input adapter disabled');
    }

    const relayShareClient = createRelayShareClient({
      relayUrl: credentials.relayUrl,
      relayToken: credentials.relayToken,
    });
    taskShareService = new TaskShareService({
      client: relayShareClient,
      taskStore: deps.taskStore,
      queue: deps.queue,
      getAgentEvents: (agentId) => deps.monitor.getAgentEvents(agentId),
      remotePolicyCache,
      getNodeIdentity: () => ({
        nodeId: nodeClient.status.nodeId,
        nodeEpoch: nodeClient.status.nodeEpoch,
      }),
      nextServerRevision: nextRemoteShareRevision,
      publish: (event) => nodeClient.publish(event),
      terminalPublisher: sessionStreamPublisher,
      diagnoseTerminalSharing: (share) => shareDiagnostics.diagnoseTerminalSharing(share),
    });
    remoteShare.client = relayShareClient;
    remoteShare.service = taskShareService;
    await wireRemoteCommandHandler();

    return {
      nodeStatus: nodeClient.status,
      start: () => nodeClient.start(),
      stop,
    };
  };

  const relayConnection = createRelayConnectionManager({
    kookrDir: deps.kookrDir,
    cwd: deps.serverCwd,
    startRuntime,
  });

  return {
    remoteShare,
    relayConnection,
    get controllerLeaseManager() {
      return controllerLeaseManager;
    },
    get remoteInputAdapter() {
      return remoteInputAdapter;
    },
    startConfigured: async () => {
      await relayConnection.startConfigured();
    },
    stop,
    recordLocalTerminalActivity: (sessionId) => {
      if (!controllerLeaseManager) return;
      controllerLeaseManager.acquireLocal({
        sessionId: sessionId as SessionId,
        sessionEpoch: sessionStreamPublisher?.currentCursor(sessionId)?.sessionEpoch ?? ('1' as SessionEpoch),
      });
    },
    publishTaskProjectionForTask: (taskId) => {
      taskShareService?.publishTaskProjectionForTask(taskId);
    },
    publishPermissionBlocked: (taskId) => {
      const outbox = pushAlertOutbox;
      if (!outbox) return;
      try {
        void publishPermissionBlockedPushAlert({
          taskId,
          taskStore: deps.taskStore,
          remoteNodeClient,
          outbox,
        }).catch((err) => {
          console.warn('[remote-push] failed to publish permission alert:', err);
        });
      } catch (err) {
        console.warn('[remote-push] failed to publish permission alert:', err);
      }
    },
  };
}
