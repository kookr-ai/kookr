import type { AttentionQueue } from '../core/attention-queue.js';
import type { TaskStore } from '../core/tasks.js';
import type { RemoteControlEvent } from '../remote/control-events.js';
import type { NodeEpoch, NodeId, PolicyVersion, ServerRevision, SessionId } from '../remote/ids.js';
import type { ShareSubject } from '../remote/policy-sync.js';
import type { RemotePolicyCache } from '../remote/policy-cache.js';
import type {
  RemoteTaskProjectionEnvelopeV1,
  RemoteTaskProjectionV1,
  ShareSessionProjectionEnvelopeV1,
  TaskShareTicket,
  TaskShareOwnerState,
  TaskShareSummary,
} from '../remote/share-contract.js';
import type { RelayShareClient } from './relay-share-client.js';
import { projectTaskForRemoteShare } from './share-projection.js';

type ShareProjectionEnvelope = RemoteTaskProjectionEnvelopeV1 | ShareSessionProjectionEnvelopeV1;
type PublishRemoteEvent = (event: RemoteControlEvent<ShareProjectionEnvelope>) => boolean;
type PublishProjectionOptions = { dedupe?: boolean };

export interface TaskShareServiceOptions {
  client: RelayShareClient;
  taskStore: TaskStore;
  queue?: AttentionQueue;
  remotePolicyCache?: RemotePolicyCache | null;
  getNodeIdentity: () => { nodeId: NodeId; nodeEpoch: NodeEpoch } | null;
  nextServerRevision: () => ServerRevision;
  publish: PublishRemoteEvent;
  diagnoseTerminalSharing?: (share: TaskShareSummary) => TaskShareSummary['terminalSharing'];
}

export class TaskShareService {
  private readonly client: RelayShareClient;
  private readonly taskStore: TaskStore;
  private readonly queue?: AttentionQueue;
  private readonly remotePolicyCache?: RemotePolicyCache | null;
  private readonly getNodeIdentity: TaskShareServiceOptions['getNodeIdentity'];
  private readonly nextServerRevision: TaskShareServiceOptions['nextServerRevision'];
  private readonly publish: PublishRemoteEvent;
  private readonly diagnoseTerminalSharing?: TaskShareServiceOptions['diagnoseTerminalSharing'];
  private readonly shares = new Map<string, TaskShareSummary>();
  private readonly pendingRevokeInvitationIds = new Set<string>();
  private readonly lastPublishedProjectionKeys = new Map<string, string>();

  constructor(opts: TaskShareServiceOptions) {
    this.client = opts.client;
    this.taskStore = opts.taskStore;
    this.queue = opts.queue;
    this.remotePolicyCache = opts.remotePolicyCache;
    this.getNodeIdentity = opts.getNodeIdentity;
    this.nextServerRevision = opts.nextServerRevision;
    this.publish = opts.publish;
    this.diagnoseTerminalSharing = opts.diagnoseTerminalSharing;
  }

  async createTaskShare(input: { taskId: string; ttlMs: number; displayLabel?: string }): Promise<{ share: TaskShareSummary; joinUrl: string; shareTicket?: TaskShareTicket }> {
    const created = await this.client.createTaskShare(input);
    const share = this.remember(created.share);
    this.publishProjectionForShare(share);
    return { ...created, share };
  }

  async listTaskShares(): Promise<TaskShareSummary[]> {
    const relayShares = await this.client.listTaskShares();
    for (const share of relayShares) this.remember(share);
    return [...this.shares.values()].map((share) => this.withLocalState(share));
  }

  async revokeTaskShare(invitationId: string): Promise<{ share: TaskShareSummary; alreadyRevoked: boolean }> {
    const existing = this.shares.get(invitationId);
    const localRevokedAt = new Date().toISOString();
    this.pendingRevokeInvitationIds.add(invitationId);
    if (existing) {
      this.shares.set(invitationId, {
        ...existing,
        state: 'revokePending',
        revokedAt: existing.revokedAt ?? localRevokedAt,
        revokePendingAt: localRevokedAt,
      });
    }

    try {
      const revoked = await this.client.revokeTaskShare(invitationId);
      this.pendingRevokeInvitationIds.delete(invitationId);
      const share = this.remember({ ...revoked.share, state: 'revoked', revokePendingAt: undefined });
      return { ...revoked, share };
    } catch (err) {
      if (existing) {
        this.shares.set(invitationId, {
          ...existing,
          state: 'revokePending',
          revokedAt: existing.revokedAt ?? localRevokedAt,
          revokePendingAt: localRevokedAt,
        });
      }
      throw err;
    }
  }

  async approveGrantRequest(invitationId: string, requestId: string): Promise<{ share: TaskShareSummary; request: NonNullable<TaskShareSummary['grantRequests']>[number] }> {
    const approved = await this.client.approveGrantRequest(invitationId, requestId);
    const share = this.remember(approved.share);
    this.publishProjectionForShare(share);
    return { ...approved, share };
  }

  async denyGrantRequest(invitationId: string, requestId: string): Promise<{ share: TaskShareSummary; request: NonNullable<TaskShareSummary['grantRequests']>[number] }> {
    const denied = await this.client.denyGrantRequest(invitationId, requestId);
    const share = this.remember(denied.share);
    return { ...denied, share };
  }

  publishActiveTaskProjections(): void {
    for (const share of this.shares.values()) {
      this.publishProjectionForShare(share);
    }
  }

  publishTaskProjectionForTask(taskId: string): void {
    for (const share of this.shares.values()) {
      if (share.taskId === taskId) {
        this.publishProjectionForShare(share, { dedupe: true });
      }
    }
  }

  private remember(share: TaskShareSummary): TaskShareSummary {
    const local = this.shares.get(share.invitationId);
    const remembered = this.withLocalState({
      ...local,
      ...share,
      revokePendingAt: this.pendingRevokeInvitationIds.has(share.invitationId)
        ? local?.revokePendingAt ?? new Date().toISOString()
        : share.revokePendingAt,
    });
    this.shares.set(share.invitationId, remembered);
    return remembered;
  }

  private withLocalState(share: TaskShareSummary): TaskShareSummary {
    const withState = this.pendingRevokeInvitationIds.has(share.invitationId)
      ? { ...share, state: 'revokePending' as const }
      : { ...share, state: computeOwnerState(share) };
    if (!this.diagnoseTerminalSharing) return withState;
    return {
      ...withState,
      terminalSharing: this.diagnoseTerminalSharing(withState),
    };
  }

  private shareWithoutDiagnostics(share: TaskShareSummary): TaskShareSummary {
    const { terminalSharing: _terminalSharing, ...rest } = share;
    return rest;
  }

  private publishProjectionForShare(share: TaskShareSummary, options: PublishProjectionOptions = {}): boolean {
    const effective = this.withLocalState(this.shareWithoutDiagnostics(share));
    if (this.pendingRevokeInvitationIds.has(share.invitationId)) {
      this.lastPublishedProjectionKeys.delete(effective.invitationId);
      return false;
    }
    if (effective.state === 'revoked' || effective.state === 'expired' || effective.state === 'revokePending') {
      this.lastPublishedProjectionKeys.delete(effective.invitationId);
      return false;
    }
    const identity = this.getNodeIdentity();
    if (!identity) return false;
    const task = this.taskStore.getTask(effective.taskId);
    if (!task) return false;
    if (!this.grantAllowsProjection(identity.nodeId, effective.taskId)) return false;

    const projection = projectTaskForRemoteShare(task, { nodeId: identity.nodeId, queue: this.queue });
    const projectionKey = projectionDedupeKey(projection);
    if (options.dedupe && this.lastPublishedProjectionKeys.get(effective.invitationId) === projectionKey) {
      return false;
    }

    const published = this.publish({
      nodeId: identity.nodeId,
      nodeEpoch: identity.nodeEpoch,
      serverRevision: this.nextServerRevision(),
      ts: new Date().toISOString(),
      kind: 'snapshot',
      payload: {
        type: 'remote.taskProjection.v1',
        invitationId: effective.invitationId,
        projection,
      },
    });
    if (published) {
      this.lastPublishedProjectionKeys.set(effective.invitationId, projectionKey);
      this.publishSessionProjectionForShare(effective, identity, task);
    }
    return published;
  }

  private publishSessionProjectionForShare(
    share: TaskShareSummary,
    identity: { nodeId: NodeId; nodeEpoch: NodeEpoch },
    task: NonNullable<ReturnType<TaskStore['getTask']>>,
  ): boolean {
    if (!share.grants.includes('terminalView')) return false;
    const session = task.sessions[0];
    if (!session) return false;
    return this.publish({
      nodeId: identity.nodeId,
      nodeEpoch: identity.nodeEpoch,
      serverRevision: this.nextServerRevision(),
      ts: new Date().toISOString(),
      kind: 'snapshot',
      payload: {
        type: 'remote.shareSessionProjection.v1',
        invitationId: share.invitationId,
        projection: {
          schemaVersion: 'share-session-projection.v1',
          nodeId: identity.nodeId,
          nodeInstanceId: String(identity.nodeEpoch),
          projectionId: `proj-${share.invitationId}`,
          projectionVersion: 1,
          policyVersion: share.policyVersion ?? (0 as PolicyVersion),
          generatedAt: new Date().toISOString(),
          expiresAt: share.expiresAt,
          primarySharedSession: {
            sessionAlias: 'primary',
            sessionId: session.tmuxSession as SessionId,
            lastActivityAt: task.updatedAt.toISOString(),
          },
        },
      },
    });
  }

  private grantAllowsProjection(nodeId: NodeId, taskId: string): boolean {
    if (!this.remotePolicyCache) return true;
    const subject: ShareSubject = { kind: 'task', nodeId, taskId };
    const snapshot = this.remotePolicyCache.snapshot();
    return snapshot.grants.some((grant) => (
      grant.subject.kind === 'task'
      && grant.subject.nodeId === subject.nodeId
      && grant.subject.taskId === subject.taskId
      && grant.grants.includes('view')
      && !this.remotePolicyCache?.hasTombstone(grant.grantId)
      && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now())
    ));
  }
}

function projectionDedupeKey(projection: RemoteTaskProjectionV1): string {
  return JSON.stringify({
    schemaVersion: projection.schemaVersion,
    nodeId: projection.nodeId,
    taskId: projection.taskId,
    taskLabel: projection.taskLabel,
    status: projection.status,
    hasFinding: projection.hasFinding,
    needsInput: projection.needsInput,
    updatedAt: projection.updatedAt,
  });
}

function computeOwnerState(share: TaskShareSummary): TaskShareOwnerState {
  if (share.revokedAt) return 'revoked';
  if (Date.parse(share.expiresAt) <= Date.now()) return 'expired';
  if (share.connectedViewerCount > 0) return 'viewerConnected';
  return 'waiting';
}
