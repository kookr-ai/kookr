import { randomUUID } from 'node:crypto';

import type {
  ClientVisibleLeaseState,
  LeaseChangedEvent,
  LeaseChangedPayload,
  LeaseRevocationReason,
} from './control-events.js';
import type {
  ActorId,
  ClientId,
  LeaseId,
  NodeEpoch,
  NodeId,
  ServerRevision,
  SessionEpoch,
  SessionId,
} from './ids.js';

export type ControllerLeaseState = ClientVisibleLeaseState | 'releasing';

export interface ControllerLease {
  leaseId: LeaseId;
  sessionId: SessionId;
  sessionEpoch: SessionEpoch;
  state: ControllerLeaseState;
  actorId?: ActorId;
  clientId?: ClientId;
  heartbeatMisses: number;
  updatedAtMs: number;
}

export interface ControllerLeaseManagerOptions {
  nodeId: NodeId;
  nodeEpoch: NodeEpoch;
  nextServerRevision: () => ServerRevision;
  publish: (event: LeaseChangedEvent) => void;
  heartbeatIntervalMs?: number;
  presumedLostGraceMs?: number;
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export type LeaseValidationResult =
  | { ok: true; lease: ControllerLease }
  | { ok: false; reason: 'error.leaseMissing' | 'error.leaseRevoked' | 'error.leaseMismatch' | 'error.staleSessionEpoch' };

interface SessionLeaseRecord {
  lease: ControllerLease | null;
  presumedLostTimer?: ReturnType<typeof setTimeout>;
}

const TERMINAL_STATES = new Set<ControllerLeaseState>(['none', 'revoked']);

function isClientVisibleState(state: ControllerLeaseState): state is ClientVisibleLeaseState {
  return state !== 'releasing';
}

export class ControllerLeaseManager {
  private readonly sessions = new Map<SessionId, SessionLeaseRecord>();
  private readonly heartbeatIntervalMs: number;
  private readonly presumedLostDelayMs: number;
  private readonly now: () => number;
  private readonly setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private sweepTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: ControllerLeaseManagerOptions) {
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 15_000;
    this.presumedLostDelayMs = (2 * this.heartbeatIntervalMs) + (opts.presumedLostGraceMs ?? 5_000);
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  acquireRemote(input: {
    sessionId: SessionId;
    sessionEpoch: SessionEpoch;
    actorId: ActorId;
    clientId: ClientId;
    leaseId?: LeaseId;
  }): LeaseValidationResult {
    const record = this.record(input.sessionId);
    const current = record.lease;
    if (current && !TERMINAL_STATES.has(current.state)) {
      if (
        current.state === 'held-remote'
        && current.actorId === input.actorId
        && current.clientId === input.clientId
        && current.sessionEpoch === input.sessionEpoch
      ) {
        current.updatedAtMs = this.now();
        current.heartbeatMisses = 0;
        this.scheduleSweep();
        return { ok: true, lease: current };
      }
      return { ok: false, reason: 'error.leaseMismatch' };
    }

    const previous = current && isClientVisibleState(current.state) ? current.state : 'none';
    const lease: ControllerLease = {
      leaseId: input.leaseId ?? (`lease-${randomUUID()}` as LeaseId),
      sessionId: input.sessionId,
      sessionEpoch: input.sessionEpoch,
      state: 'held-remote',
      actorId: input.actorId,
      clientId: input.clientId,
      heartbeatMisses: 0,
      updatedAtMs: this.now(),
    };
    record.lease = lease;
    this.cancelPresumedLost(record);
    this.scheduleSweep();
    this.emit(lease, previous, 'held-remote');
    return { ok: true, lease };
  }

  acquireLocal(input: { sessionId: SessionId; sessionEpoch: SessionEpoch }): void {
    const record = this.record(input.sessionId);
    const current = record.lease;
    if (current && current.state === 'held-local' && current.sessionEpoch === input.sessionEpoch) {
      current.updatedAtMs = this.now();
      return;
    }
    if (current && current.state === 'held-remote') {
      this.revoke(input.sessionId, 'owner-override');
    }
    const lease: ControllerLease = {
      leaseId: `local-${randomUUID()}` as LeaseId,
      sessionId: input.sessionId,
      sessionEpoch: input.sessionEpoch,
      state: 'held-local',
      heartbeatMisses: 0,
      updatedAtMs: this.now(),
    };
    record.lease = lease;
    this.emit(lease, current && isClientVisibleState(current.state) ? current.state : 'none', 'held-local');
  }

  validateRemoteSubmit(input: {
    sessionId: SessionId;
    sessionEpoch: SessionEpoch;
    actorId: ActorId;
    clientId: ClientId;
    leaseId: LeaseId;
  }): LeaseValidationResult {
    const lease = this.sessions.get(input.sessionId)?.lease;
    if (!lease) return { ok: false, reason: 'error.leaseMissing' };
    if (lease.sessionEpoch !== input.sessionEpoch) return { ok: false, reason: 'error.staleSessionEpoch' };
    if (lease.state === 'revoked' || lease.state === 'none') return { ok: false, reason: 'error.leaseRevoked' };
    if (lease.state === 'held-local') return { ok: false, reason: 'error.leaseRevoked' };
    if (
      lease.state !== 'held-remote'
      || lease.leaseId !== input.leaseId
      || lease.actorId !== input.actorId
      || lease.clientId !== input.clientId
    ) {
      return { ok: false, reason: 'error.leaseMismatch' };
    }
    lease.updatedAtMs = this.now();
    this.scheduleSweep();
    return { ok: true, lease };
  }

  recordHeartbeatAck(input: {
    sessionId: SessionId;
    leaseId: LeaseId;
    actorId: ActorId;
    clientId: ClientId;
  }): LeaseValidationResult {
    const { sessionId, leaseId, actorId, clientId } = input;
    const lease = this.sessions.get(sessionId)?.lease;
    if (!lease || lease.leaseId !== leaseId) return { ok: false, reason: 'error.leaseMissing' };
    if (lease.actorId !== actorId || lease.clientId !== clientId) return { ok: false, reason: 'error.leaseMismatch' };
    if (lease.state === 'revoked' || lease.state === 'none') return { ok: false, reason: 'error.leaseRevoked' };
    lease.heartbeatMisses = 0;
    lease.updatedAtMs = this.now();
    this.cancelPresumedLost(this.record(sessionId));
    if (lease.state === 'held-uncertain' || lease.state === 'held-presumed-lost') {
      const previous = lease.state;
      lease.state = 'held-remote';
      this.emit(lease, previous, 'held-remote');
    }
    if (lease.state === 'held-remote') this.scheduleSweep();
    return { ok: true, lease };
  }

  recordHeartbeatMiss(input: {
    sessionId: SessionId;
    leaseId: LeaseId;
    actorId: ActorId;
    clientId: ClientId;
  }): LeaseValidationResult {
    const { sessionId, leaseId, actorId, clientId } = input;
    const lease = this.sessions.get(sessionId)?.lease;
    if (!lease || lease.leaseId !== leaseId) return { ok: false, reason: 'error.leaseMissing' };
    if (lease.actorId !== actorId || lease.clientId !== clientId) return { ok: false, reason: 'error.leaseMismatch' };
    if (lease.state === 'revoked' || lease.state === 'none') return { ok: false, reason: 'error.leaseRevoked' };
    lease.heartbeatMisses += 1;
    lease.updatedAtMs = this.now();
    if (lease.heartbeatMisses === 1) {
      this.transitionClientVisible(lease, 'held-uncertain');
      return { ok: true, lease };
    }
    this.revoke(sessionId, 'heartbeat-timeout');
    return { ok: false, reason: 'error.leaseRevoked' };
  }

  handleRelayDisconnect(reason: LeaseRevocationReason = 'node-disconnect'): void {
    for (const record of this.sessions.values()) {
      const lease = record.lease;
      if (!lease || lease.state !== 'held-remote') continue;
      this.transitionClientVisible(lease, 'held-uncertain');
      lease.state = 'revoked';
      lease.updatedAtMs = this.now();
      this.schedulePresumedLost(record, lease, reason);
    }
  }

  handleRelayReconnect(): void {
    for (const record of this.sessions.values()) {
      const lease = record.lease;
      if (!lease || lease.state !== 'revoked') continue;
      this.cancelPresumedLost(record);
      this.emit(lease, 'held-presumed-lost', 'revoked', 'node-disconnect');
    }
  }

  revoke(sessionId: SessionId, reason: LeaseRevocationReason): void {
    const record = this.sessions.get(sessionId);
    const lease = record?.lease;
    if (!record || !lease || lease.state === 'revoked') return;
    const previous = isClientVisibleState(lease.state) ? lease.state : 'held-remote';
    lease.state = 'revoked';
    lease.updatedAtMs = this.now();
    this.cancelPresumedLost(record);
    this.emit(lease, previous, 'revoked', reason);
  }

  current(sessionId: SessionId): ControllerLease | null {
    return this.sessions.get(sessionId)?.lease ?? null;
  }

  dispose(): void {
    this.cancelSweep();
    for (const record of this.sessions.values()) this.cancelPresumedLost(record);
  }

  private record(sessionId: SessionId): SessionLeaseRecord {
    let record = this.sessions.get(sessionId);
    if (!record) {
      record = { lease: null };
      this.sessions.set(sessionId, record);
    }
    return record;
  }

  private transitionClientVisible(lease: ControllerLease, next: ClientVisibleLeaseState): void {
    const previous = isClientVisibleState(lease.state) ? lease.state : 'held-remote';
    lease.state = next;
    this.emit(lease, previous, next);
  }

  private schedulePresumedLost(record: SessionLeaseRecord, lease: ControllerLease, reason: LeaseRevocationReason): void {
    this.cancelPresumedLost(record);
    record.presumedLostTimer = this.setTimer(() => {
      this.emit(lease, 'held-uncertain', 'held-presumed-lost', reason);
    }, this.presumedLostDelayMs);
  }

  private cancelPresumedLost(record: SessionLeaseRecord): void {
    if (!record.presumedLostTimer) return;
    this.clearTimer(record.presumedLostTimer);
    record.presumedLostTimer = undefined;
  }

  private scheduleSweep(): void {
    if (this.sweepTimer) return;
    const delayMs = this.nextSweepDelayMs();
    if (delayMs === null) return;
    this.sweepTimer = this.setTimer(() => this.sweepStaleRemoteLeases(), delayMs);
  }

  private cancelSweep(): void {
    if (!this.sweepTimer) return;
    this.clearTimer(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private sweepStaleRemoteLeases(): void {
    this.sweepTimer = undefined;
    const now = this.now();
    for (const record of this.sessions.values()) {
      const lease = record.lease;
      if (!lease || lease.state !== 'held-remote') continue;
      if (now - lease.updatedAtMs >= this.presumedLostDelayMs) {
        this.revoke(lease.sessionId, 'heartbeat-timeout');
      }
    }
    this.scheduleSweep();
  }

  private nextSweepDelayMs(): number | null {
    let nextDelayMs: number | null = null;
    const now = this.now();
    for (const record of this.sessions.values()) {
      const lease = record.lease;
      if (lease?.state !== 'held-remote') continue;
      const delayMs = Math.max(0, Math.min(
        this.heartbeatIntervalMs,
        lease.updatedAtMs + this.presumedLostDelayMs - now,
      ));
      nextDelayMs = nextDelayMs === null ? delayMs : Math.min(nextDelayMs, delayMs);
    }
    return nextDelayMs;
  }

  private emit(
    lease: ControllerLease,
    previousState: ClientVisibleLeaseState,
    newState: ClientVisibleLeaseState,
    reason?: LeaseRevocationReason,
  ): void {
    const payload: LeaseChangedPayload = {
      sessionId: lease.sessionId,
      sessionEpoch: lease.sessionEpoch,
      leaseId: lease.leaseId,
      previousState,
      newState,
      ...(lease.actorId ? { actorId: lease.actorId } : {}),
      ...(lease.clientId ? { clientId: lease.clientId } : {}),
      ...(reason ? { reason } : {}),
    };
    this.opts.publish({
      nodeId: this.opts.nodeId,
      nodeEpoch: this.opts.nodeEpoch,
      serverRevision: this.opts.nextServerRevision(),
      ts: new Date(this.now()).toISOString(),
      kind: 'lease.changed',
      payload,
    });
  }
}
