import type {
  ContactShareEnvelope,
  ContactShareInboxItem,
  ContactShareLifecycle,
  ContactShareGrant,
  DecryptedContactShareInvite,
  KookrContact,
  SharedTask,
} from '../shared/contracts/contact-share.js';
import {
  isContactShareEnvelope,
  sharedTaskIdForShare,
} from '../shared/contracts/contact-share.js';

type DecisionKind = 'share.accept' | 'share.refuse' | 'share.revoke';

interface ShareDecision {
  kind: DecisionKind;
  decisionVersion: number;
  envelopeId: string;
  createdAt: string;
}

const TERMINAL_DECISIONS = new Set<DecisionKind>(['share.refuse', 'share.revoke']);

function cloneContact(contact: KookrContact): KookrContact {
  return {
    ...contact,
    devices: contact.devices.map((device) => ({ ...device })),
  };
}

function cloneSharedTask(task: SharedTask): SharedTask {
  return {
    ...task,
    grants: [...task.grants],
    ...(task.terminalSubject ? { terminalSubject: { ...task.terminalSubject } } : {}),
  };
}

function lifecycleForDecision(decision: ShareDecision | undefined, expiresAt: string | undefined, now: Date): ContactShareLifecycle {
  if (expiresAt && Date.parse(expiresAt) <= now.getTime()) return 'expired';
  if (!decision) return 'pending';
  switch (decision.kind) {
    case 'share.accept':
      return 'accepted';
    case 'share.refuse':
      return 'refused';
    case 'share.revoke':
      return 'revoked';
  }
}

function isDecisionEnvelope(envelope: ContactShareEnvelope): envelope is ContactShareEnvelope & { kind: DecisionKind } {
  return envelope.kind === 'share.accept' || envelope.kind === 'share.refuse' || envelope.kind === 'share.revoke';
}

function decisionWins(previous: ShareDecision | undefined, next: ShareDecision): boolean {
  if (!previous) return true;
  if (TERMINAL_DECISIONS.has(previous.kind) && next.kind === 'share.accept') return false;
  if (next.decisionVersion > previous.decisionVersion) return true;
  if (next.decisionVersion < previous.decisionVersion) return false;
  if (TERMINAL_DECISIONS.has(next.kind) && previous.kind === 'share.accept') return true;
  return false;
}

export class ContactShareReadModel {
  private readonly contacts = new Map<string, KookrContact>();
  private readonly envelopes = new Map<string, ContactShareEnvelope>();
  private readonly decisionsByDeviceShare = new Map<string, ShareDecision>();
  private readonly decryptedInvites = new Map<string, DecryptedContactShareInvite>();
  private readonly sharedTasks = new Map<string, SharedTask>();

  upsertContact(contact: KookrContact): KookrContact {
    if (contact.trustState === 'verified' && contact.devices.length === 0) {
      throw new Error('verified contacts require at least one device key');
    }
    this.contacts.set(contact.contactId, cloneContact(contact));
    return cloneContact(contact);
  }

  listContacts(): KookrContact[] {
    return [...this.contacts.values()].map(cloneContact);
  }

  verifiedContacts(): KookrContact[] {
    return this.listContacts().filter((contact) => contact.trustState === 'verified');
  }

  ingestEncryptedEnvelope(envelope: ContactShareEnvelope): ContactShareEnvelope {
    if (!isContactShareEnvelope(envelope)) {
      throw new Error('invalid contact share envelope');
    }
    const previous = this.envelopes.get(envelope.envelopeId);
    if (previous) return { ...previous };
    const stored = { ...envelope };
    this.envelopes.set(envelope.envelopeId, stored);
    if (isDecisionEnvelope(stored)) {
      const key = this.decisionKey(stored.shareId, stored.recipientDeviceId);
      const next: ShareDecision = {
        kind: stored.kind,
        decisionVersion: stored.decisionVersion,
        envelopeId: stored.envelopeId,
        createdAt: stored.createdAt,
      };
      const previousDecision = this.decisionsByDeviceShare.get(key);
      if (decisionWins(previousDecision, next)) {
        this.decisionsByDeviceShare.set(key, next);
        if (stored.kind === 'share.refuse' || stored.kind === 'share.revoke') {
          this.sharedTasks.delete(sharedTaskIdForShare(stored.shareId));
        }
      }
    }
    return { ...stored };
  }

  recordDecryptedInvite(invite: DecryptedContactShareInvite): ContactShareInboxItem {
    this.decryptedInvites.set(invite.shareId, {
      ...invite,
      grants: [...invite.grants],
      ...(invite.terminalSubject ? { terminalSubject: { ...invite.terminalSubject } } : {}),
    });
    return this.inboxItemForInvite(invite);
  }

  listInbox(): ContactShareInboxItem[] {
    return [...this.decryptedInvites.values()]
      .map((invite) => this.inboxItemForInvite(invite))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  acceptShare(shareId: string, recipientDeviceId: string, now = new Date()): SharedTask | null {
    const invite = this.decryptedInvites.get(shareId);
    if (!invite) return null;
    const latestDecision = this.latestDecisionForShare(shareId);
    if (latestDecision && TERMINAL_DECISIONS.has(latestDecision.kind)) return null;
    if (this.inboxItemForInvite(invite, now).lifecycle === 'expired') return null;
    const decision: ShareDecision = {
      kind: 'share.accept',
      decisionVersion: this.nextDecisionVersion(shareId, recipientDeviceId),
      envelopeId: `local-accept-${shareId}-${now.getTime()}`,
      createdAt: now.toISOString(),
    };
    const key = this.decisionKey(shareId, recipientDeviceId);
    if (!decisionWins(this.decisionsByDeviceShare.get(key), decision)) return null;
    this.decisionsByDeviceShare.set(key, decision);

    const task: SharedTask = {
      kind: 'shared-task',
      sharedTaskId: sharedTaskIdForShare(invite.shareId),
      ownerContactId: invite.ownerContactId,
      ownerDisplayName: invite.ownerDisplayName,
      ...(invite.ownerNodeLabel ? { ownerNodeLabel: invite.ownerNodeLabel } : {}),
      originNodeId: invite.originNodeId,
      remoteTaskId: invite.remoteTaskId,
      shareId: invite.shareId,
      ...(invite.terminalSubject ? { terminalSubject: { ...invite.terminalSubject } } : {}),
      localDisplayLabel: invite.taskLabel,
      lifecycle: 'accepted',
      grants: normalizeContactShareGrants(invite.grants),
      source: 'contact-share',
      remoteStatus: invite.remoteStatus,
      updatedAt: now.toISOString(),
    };
    this.sharedTasks.set(task.sharedTaskId, task);
    return cloneSharedTask(task);
  }

  refuseShare(shareId: string, recipientDeviceId: string, now = new Date()): void {
    const decision: ShareDecision = {
      kind: 'share.refuse',
      decisionVersion: this.nextDecisionVersion(shareId, recipientDeviceId),
      envelopeId: `local-refuse-${shareId}-${now.getTime()}`,
      createdAt: now.toISOString(),
    };
    this.decisionsByDeviceShare.set(this.decisionKey(shareId, recipientDeviceId), decision);
    this.sharedTasks.delete(sharedTaskIdForShare(shareId));
  }

  listSharedTasks(): SharedTask[] {
    return [...this.sharedTasks.values()].map(cloneSharedTask);
  }

  private decisionKey(shareId: string, recipientDeviceId: string): string {
    return `${shareId}\0${recipientDeviceId}`;
  }

  private latestDecisionForShare(shareId: string): ShareDecision | undefined {
    let latest: ShareDecision | undefined;
    for (const [key, decision] of this.decisionsByDeviceShare) {
      if (!key.startsWith(`${shareId}\0`)) continue;
      if (!latest || decisionWins(latest, decision)) latest = decision;
    }
    return latest;
  }

  private nextDecisionVersion(shareId: string, recipientDeviceId: string): number {
    return (this.decisionsByDeviceShare.get(this.decisionKey(shareId, recipientDeviceId))?.decisionVersion ?? 0) + 1;
  }

  private inboxItemForInvite(invite: DecryptedContactShareInvite, now = new Date()): ContactShareInboxItem {
    const inviteEnvelope = [...this.envelopes.values()]
      .filter((envelope) => envelope.shareId === invite.shareId && envelope.kind === 'share.invite')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const decision = this.latestDecisionForShare(invite.shareId);
    const updatedAt = decision?.createdAt ?? inviteEnvelope?.createdAt ?? new Date(0).toISOString();
    return {
      shareId: invite.shareId,
      envelopeId: inviteEnvelope?.envelopeId ?? `decrypted-${invite.shareId}`,
      senderContactId: invite.ownerContactId,
      senderDisplayName: invite.ownerDisplayName,
      recipientDeviceId: inviteEnvelope?.recipientDeviceId ?? '',
      lifecycle: lifecycleForDecision(decision, inviteEnvelope?.expiresAt, now),
      notificationTitle: 'Kookr task shared',
      notificationBody: `${invite.ownerDisplayName} shared a task with you`,
      redacted: true,
      createdAt: inviteEnvelope?.createdAt ?? updatedAt,
      updatedAt,
      ...(inviteEnvelope?.expiresAt ? { expiresAt: inviteEnvelope.expiresAt } : {}),
    };
  }
}

function normalizeContactShareGrants(grants: ContactShareGrant[]): ContactShareGrant[] {
  const allowed: ContactShareGrant[] = [];
  if (grants.includes('view')) allowed.push('view');
  if (grants.includes('terminalView')) allowed.push('terminalView');
  return allowed.length > 0 ? allowed : ['view'];
}
