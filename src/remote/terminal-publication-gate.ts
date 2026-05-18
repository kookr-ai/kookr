import type { PolicyVersion, Seq, SessionEpoch, SessionId } from './ids.js';
import type { TerminalBytesEvent, TerminalPublicationMetadata, TerminalPublicationPrincipal } from './stream-events.js';

export type TerminalDemandProof =
  | { kind: 'recipient-signed-heartbeat'; heartbeatKeyId: string; expiresAt: string }
  | { kind: 'guest-relay-presence'; expiresAt: string };

export interface TerminalPublicationRule {
  publicationScopeId: string;
  principal: TerminalPublicationPrincipal;
  sessionId: SessionId;
  sessionEpoch: SessionEpoch;
  approvedAt: string;
  policyVersion: PolicyVersion;
  minSeqExclusive: Seq;
  streamEncryption?:
    | { kind: 'contact-e2ee'; recipientDeviceId: string; recipientPublicKey: string; streamKeyId: string }
    | { kind: 'guest-transport'; memberSessionId: string };
  demandProof?: TerminalDemandProof;
  expiresAt?: string;
}

export type TerminalPublicationInstallResult =
  | { ok: true; rule: TerminalPublicationRule }
  | { ok: false; reason: 'session-changed' | 'invalid-scope' };

type TerminalPublicationCandidate = Omit<TerminalPublicationMetadata, 'streamEncryption'> & {
  streamEncryption?: TerminalPublicationRule['streamEncryption'];
};

export class TerminalPublicationGate {
  private readonly rules = new Map<string, TerminalPublicationRule>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  installRule(input: TerminalPublicationRule, currentSession: { sessionEpoch: SessionEpoch; lastSeq: Seq } | null): TerminalPublicationInstallResult {
    if (!input.publicationScopeId.trim()) return { ok: false, reason: 'invalid-scope' };
    if (!currentSession || currentSession.sessionEpoch !== input.sessionEpoch) {
      return { ok: false, reason: 'session-changed' };
    }
    const rule: TerminalPublicationRule = {
      ...input,
      minSeqExclusive: currentSession.lastSeq,
    };
    this.rules.set(rule.publicationScopeId, rule);
    return { ok: true, rule };
  }

  revokeScope(publicationScopeId: string): void {
    this.rules.delete(publicationScopeId);
  }

  recordDemandProof(input: {
    principal: TerminalPublicationPrincipal;
    sessionId: SessionId;
    sessionEpoch: SessionEpoch;
    proof: TerminalDemandProof;
  }): boolean {
    if (!Number.isFinite(Date.parse(input.proof.expiresAt))) return false;
    let updated = false;
    for (const [scopeId, rule] of this.rules) {
      if (
        rule.sessionId !== input.sessionId
        || rule.sessionEpoch !== input.sessionEpoch
        || !samePrincipal(rule.principal, input.principal)
      ) {
        continue;
      }
      this.rules.set(scopeId, { ...rule, demandProof: input.proof });
      updated = true;
    }
    return updated;
  }

  metadataForEvent(event: TerminalBytesEvent): TerminalPublicationCandidate[] {
    const nowMs = this.now().getTime();
    const out: TerminalPublicationCandidate[] = [];
    for (const rule of this.rules.values()) {
      if (rule.sessionId !== event.sessionId || rule.sessionEpoch !== event.sessionEpoch) continue;
      if (Number(event.seq) <= Number(rule.minSeqExclusive)) continue;
      const ruleExpiresAtMs = rule.expiresAt ? Date.parse(rule.expiresAt) : null;
      if (ruleExpiresAtMs !== null && (!Number.isFinite(ruleExpiresAtMs) || ruleExpiresAtMs <= nowMs)) continue;
      const demandExpiresAtMs = rule.demandProof ? Date.parse(rule.demandProof.expiresAt) : null;
      if (demandExpiresAtMs === null || !Number.isFinite(demandExpiresAtMs) || demandExpiresAtMs <= nowMs) continue;
      out.push({
        publicationScopeId: rule.publicationScopeId,
        principal: rule.principal,
        policyVersion: rule.policyVersion,
        ...(rule.streamEncryption ? { streamEncryption: rule.streamEncryption } : {}),
      });
    }
    return out;
  }

}

function samePrincipal(a: TerminalPublicationPrincipal, b: TerminalPublicationPrincipal): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'contact-device') {
    return b.kind === 'contact-device'
      && a.contactId === b.contactId
      && a.deviceId === b.deviceId;
  }
  return b.kind === 'guest-member'
    && a.invitationId === b.invitationId
    && a.memberSessionId === b.memberSessionId
    && a.deviceId === b.deviceId;
}
