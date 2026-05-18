import type { AttentionQueue } from '../core/attention-queue.js';
import type { TaskStore } from '../core/tasks.js';
import type { RemoteControlEvent } from '../remote/control-events.js';
import type { NodeEpoch, NodeId, PolicyVersion, ServerRevision, SessionEpoch, SessionId } from '../remote/ids.js';
import type { TerminalDemandProof } from '../remote/terminal-publication-gate.js';
import type { ShareSubject } from '../remote/policy-sync.js';
import type { RemotePolicyCache } from '../remote/policy-cache.js';
import type { SessionStreamPublisher } from '../remote/session-stream-publisher.js';
import type { TerminalPublicationPrincipal } from '../remote/stream-events.js';
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
  terminalPublisher?: Pick<SessionStreamPublisher, 'currentCursor' | 'installPublicationRule' | 'recordDemandProof' | 'revokePublicationScope'>;
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
  private readonly terminalPublisher?: TaskShareServiceOptions['terminalPublisher'];
  private readonly shares = new Map<string, TaskShareSummary>();
  private readonly pendingRevokeInvitationIds = new Set<string>();
  private readonly lastPublishedProjectionKeys = new Map<string, string>();
  private readonly terminalPublicationScopesByInvitation = new Map<string, Set<string>>();

  constructor(opts: TaskShareServiceOptions) {
    this.client = opts.client;
    this.taskStore = opts.taskStore;
    this.queue = opts.queue;
    this.remotePolicyCache = opts.remotePolicyCache;
    this.getNodeIdentity = opts.getNodeIdentity;
    this.nextServerRevision = opts.nextServerRevision;
    this.publish = opts.publish;
    this.diagnoseTerminalSharing = opts.diagnoseTerminalSharing;
    this.terminalPublisher = opts.terminalPublisher;
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
    if (existing) this.revokeTerminalPublicationForShare(existing);
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

  recordTerminalPublicationDemand(input: {
    principal: TerminalPublicationPrincipal;
    sessionId: SessionId;
    sessionEpoch: SessionEpoch;
    proof: TerminalDemandProof;
  }): boolean {
    if (!this.terminalPublisher || input.principal.kind !== 'guest-member') return false;
    const remembered = this.shares.get(input.principal.invitationId);
    if (!remembered) return false;
    const share = this.withLocalState(this.shareWithoutDiagnostics(remembered));
    if (!this.shareAllowsTerminalPublicationDemand(share, input.principal)) return false;
    const task = this.taskStore.getTask(share.taskId);
    const session = task?.sessions[0];
    if (!session || session.tmuxSession !== input.sessionId) return false;
    const cursor = this.terminalPublisher.currentCursor(input.sessionId);
    if (!cursor || cursor.sessionEpoch !== input.sessionEpoch) return false;

    const publicationScopeId = this.publicationScopeId(
      share.invitationId,
      input.principal,
      input.sessionId,
      input.sessionEpoch,
    );
    const installed = this.terminalPublisher.installPublicationRule({
      publicationScopeId,
      principal: input.principal,
      sessionId: input.sessionId,
      sessionEpoch: input.sessionEpoch,
      approvedAt: new Date().toISOString(),
      policyVersion: share.policyVersion ?? (0 as PolicyVersion),
      streamEncryption: { kind: 'guest-transport', memberSessionId: input.principal.memberSessionId },
      expiresAt: share.expiresAt,
    });
    if (!installed.ok) return false;
    const scopes = this.terminalPublicationScopesByInvitation.get(share.invitationId) ?? new Set<string>();
    scopes.add(publicationScopeId);
    this.terminalPublicationScopesByInvitation.set(share.invitationId, scopes);
    return this.terminalPublisher.recordDemandProof(input);
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
      this.revokeTerminalPublicationForShare(effective);
      return false;
    }
    if (effective.state === 'revoked' || effective.state === 'expired' || effective.state === 'revokePending') {
      this.lastPublishedProjectionKeys.delete(effective.invitationId);
      this.revokeTerminalPublicationForShare(effective);
      return false;
    }
    const identity = this.getNodeIdentity();
    if (!identity) {
      this.revokeTerminalPublicationForShare(effective);
      return false;
    }
    const task = this.taskStore.getTask(effective.taskId);
    if (!task) {
      this.revokeTerminalPublicationForShare(effective);
      return false;
    }
    if (!this.grantAllowsProjection(identity.nodeId, effective.taskId)) {
      this.revokeTerminalPublicationForShare(effective);
      return false;
    }

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
    if (!grantsAllowTerminalView(share.grants)) {
      this.revokeTerminalPublicationForShare(share);
      return false;
    }
    const session = task.sessions[0];
    if (!session) {
      this.revokeTerminalPublicationForShare(share);
      return false;
    }
    // Fail closed: do not advertise a live terminal session unless the node
    // has an active publisher cursor bound to the immutable session epoch.
    if (!this.terminalPublisher) {
      this.revokeTerminalPublicationForShare(share);
      return false;
    }
    const cursor = this.terminalPublisher.currentCursor(session.tmuxSession);
    if (!cursor) {
      this.revokeTerminalPublicationForShare(share);
      return false;
    }
    const sessionEpoch = cursor.sessionEpoch;
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
            sessionEpoch,
            lastActivityAt: task.updatedAt.toISOString(),
          },
        },
      },
    });
  }

  private revokeTerminalPublicationForShare(share: TaskShareSummary): void {
    this.revokeTerminalPublicationScopes(share.invitationId);
  }

  private revokeTerminalPublicationScopes(invitationId: string): void {
    if (!this.terminalPublisher) return;
    const scopes = this.terminalPublicationScopesByInvitation.get(invitationId);
    if (!scopes) return;
    for (const scopeId of scopes) this.terminalPublisher.revokePublicationScope(scopeId);
    this.terminalPublicationScopesByInvitation.delete(invitationId);
  }

  private publicationScopeId(
    invitationId: string,
    principal: Extract<TerminalPublicationPrincipal, { kind: 'guest-member' }>,
    sessionId: SessionId,
    sessionEpoch: SessionEpoch,
  ): string {
    return `guest-member:${invitationId}:${principal.memberSessionId}:${principal.deviceId}:${sessionId}:${sessionEpoch}`;
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

  private shareAllowsTerminalPublicationDemand(share: TaskShareSummary, principal: TerminalPublicationPrincipal): boolean {
    if (principal.kind !== 'guest-member') return false;
    if (share.invitationId !== principal.invitationId) return false;
    if (share.state === 'revoked' || share.state === 'expired' || share.state === 'revokePending') return false;
    if (!grantsAllowTerminalView(share.grants)) return false;
    const sessions = share.memberSessions ?? [];
    if (sessions.length === 0) {
      return share.memberId === principal.memberSessionId
        && share.memberDeviceId === principal.deviceId;
    }
    const matchingSession = sessions.some((session) => (
      session.memberId === principal.memberSessionId
      && session.deviceId === principal.deviceId
    ));
    if (!matchingSession) return false;
    const approvedTerminalRequest = share.grantRequests.some((request) => (
      request.status === 'approved'
      && request.requestedBy === principal.memberSessionId
      && request.requestedGrants.some((grant) => grant === 'terminalView' || grant === 'terminalInput')
    ));
    return approvedTerminalRequest;
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

function grantsAllowTerminalView(grants: readonly string[]): boolean {
  return grants.includes('terminalView') || grants.includes('terminalInput');
}

function computeOwnerState(share: TaskShareSummary): TaskShareOwnerState {
  if (share.revokedAt) return 'revoked';
  if (Date.parse(share.expiresAt) <= Date.now()) return 'expired';
  if (share.connectedViewerCount > 0) return 'viewerConnected';
  return 'waiting';
}
