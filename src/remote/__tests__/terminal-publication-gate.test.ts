import { describe, expect, it } from 'vitest';

import { asPolicyVersion, asSeq, type SessionEpoch, type SessionId } from '../ids.js';
import { TerminalPublicationGate } from '../terminal-publication-gate.js';
import type { TerminalBytesEvent } from '../stream-events.js';

const sessionId = 'session-1' as SessionId;
const sessionEpoch = '7' as SessionEpoch;

function bytes(seq: number): TerminalBytesEvent {
  return {
    nodeId: 'node-1' as TerminalBytesEvent['nodeId'],
    nodeEpoch: '1' as TerminalBytesEvent['nodeEpoch'],
    sessionId,
    sessionEpoch,
    seq: asSeq(seq),
    ts: '2026-05-18T00:00:00.000Z',
    kind: 'terminal.bytes',
    payload: {
      encoding: 'base64',
      data: 'eA==',
      byteLength: 1,
    },
  };
}

describe('TerminalPublicationGate', () => {
  it('fails closed without an installed scoped rule and active demand proof', () => {
    const gate = new TerminalPublicationGate(() => new Date('2026-05-18T00:00:00.000Z'));

    expect(gate.metadataForEvent(bytes(1))).toEqual([]);

    const installed = gate.installRule({
      publicationScopeId: 'scope-a',
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-a' },
      sessionId,
      sessionEpoch,
      approvedAt: '2026-05-18T00:00:00.000Z',
      policyVersion: asPolicyVersion(4),
      minSeqExclusive: asSeq(0),
    }, { sessionEpoch, lastSeq: asSeq(2) });

    expect(installed).toEqual(expect.objectContaining({ ok: true }));
    expect(gate.metadataForEvent(bytes(3))).toEqual([]);

    gate.recordDemandProof({
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-a' },
      sessionId,
      sessionEpoch,
      proof: { kind: 'guest-relay-presence', expiresAt: '2026-05-18T00:00:05.000Z' },
    });

    expect(gate.metadataForEvent(bytes(2))).toEqual([]);
    expect(gate.metadataForEvent(bytes(3))).toEqual([
      {
        publicationScopeId: 'scope-a',
        principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-a' },
        policyVersion: asPolicyVersion(4),
      },
    ]);
  });

  it('binds approvals to the immutable session epoch and scopes demand by member device', () => {
    const gate = new TerminalPublicationGate(() => new Date('2026-05-18T00:00:00.000Z'));

    expect(gate.installRule({
      publicationScopeId: 'scope-stale',
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-a' },
      sessionId,
      sessionEpoch,
      approvedAt: '2026-05-18T00:00:00.000Z',
      policyVersion: asPolicyVersion(4),
      minSeqExclusive: asSeq(0),
    }, { sessionEpoch: '8' as SessionEpoch, lastSeq: asSeq(0) })).toEqual({ ok: false, reason: 'session-changed' });

    gate.installRule({
      publicationScopeId: 'scope-a',
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-a' },
      sessionId,
      sessionEpoch,
      approvedAt: '2026-05-18T00:00:00.000Z',
      policyVersion: asPolicyVersion(4),
      minSeqExclusive: asSeq(0),
    }, { sessionEpoch, lastSeq: asSeq(0) });

    expect(gate.recordDemandProof({
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-2', deviceId: 'device-b' },
      sessionId,
      sessionEpoch,
      proof: { kind: 'guest-relay-presence', expiresAt: '2026-05-18T00:00:05.000Z' },
    })).toBe(false);
    expect(gate.metadataForEvent(bytes(1))).toEqual([]);
  });

  it('does not publish after the installed rule expires', () => {
    const gate = new TerminalPublicationGate(() => new Date('2026-05-18T00:00:06.000Z'));

    gate.installRule({
      publicationScopeId: 'scope-expired-rule',
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-a' },
      sessionId,
      sessionEpoch,
      approvedAt: '2026-05-18T00:00:00.000Z',
      policyVersion: asPolicyVersion(4),
      minSeqExclusive: asSeq(0),
      expiresAt: '2026-05-18T00:00:05.000Z',
    }, { sessionEpoch, lastSeq: asSeq(0) });
    gate.recordDemandProof({
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-a' },
      sessionId,
      sessionEpoch,
      proof: { kind: 'guest-relay-presence', expiresAt: '2026-05-18T00:00:10.000Z' },
    });

    expect(gate.metadataForEvent(bytes(1))).toEqual([]);
  });

  it('does not publish after the demand proof expires', () => {
    const gate = new TerminalPublicationGate(() => new Date('2026-05-18T00:00:06.000Z'));

    gate.installRule({
      publicationScopeId: 'scope-expired-demand',
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-a' },
      sessionId,
      sessionEpoch,
      approvedAt: '2026-05-18T00:00:00.000Z',
      policyVersion: asPolicyVersion(4),
      minSeqExclusive: asSeq(0),
      expiresAt: '2026-05-18T00:00:10.000Z',
    }, { sessionEpoch, lastSeq: asSeq(0) });
    gate.recordDemandProof({
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-a' },
      sessionId,
      sessionEpoch,
      proof: { kind: 'guest-relay-presence', expiresAt: '2026-05-18T00:00:05.000Z' },
    });

    expect(gate.metadataForEvent(bytes(1))).toEqual([]);
  });

  it('rejects malformed demand proof expiry timestamps', () => {
    const gate = new TerminalPublicationGate(() => new Date('2026-05-18T00:00:00.000Z'));

    gate.installRule({
      publicationScopeId: 'scope-malformed-demand',
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-a' },
      sessionId,
      sessionEpoch,
      approvedAt: '2026-05-18T00:00:00.000Z',
      policyVersion: asPolicyVersion(4),
      minSeqExclusive: asSeq(0),
      expiresAt: '2026-05-18T00:00:10.000Z',
    }, { sessionEpoch, lastSeq: asSeq(0) });

    expect(gate.recordDemandProof({
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-a' },
      sessionId,
      sessionEpoch,
      proof: { kind: 'guest-relay-presence', expiresAt: 'not-a-date' },
    })).toBe(false);
    expect(gate.metadataForEvent(bytes(1))).toEqual([]);
  });
});
