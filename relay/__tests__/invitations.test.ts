import { describe, expect, it } from 'vitest';

import { asNodeId } from '../../src/remote/ids.js';
import { InvitationStore } from '../src/invitations/store.js';

describe('InvitationStore', () => {
  it('creates single-use hashed invitations, accepts once, and revokes grants', () => {
    let now = new Date('2026-05-15T20:00:00.000Z');
    const store = new InvitationStore({ now: () => now, tokenBytes: 8 });

    const created = store.create({
      nodeId: asNodeId('node-1'),
      grants: ['view', 'comment', 'terminalView', 'terminalInput'],
      ttlMs: 60_000,
    });

    expect(created.token).toMatch(/^kookr_inv_v1_/);
    expect(created.invitation.tokenHash).not.toBe(created.token);
    expect(store.list()[0]).toMatchObject({
      nodeId: 'node-1',
      grants: ['view', 'comment', 'terminalView', 'terminalInput'],
      expiresAt: '2026-05-15T20:01:00.000Z',
    });

    const accepted = store.accept(created.token, 'alice');
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('expected accept');
    expect(accepted.accepted.memberToken).toMatch(/^kookr_member_v1_/);
    expect(accepted.accepted.policyGrant).toMatchObject({
      grantId: created.invitation.grantId,
      grants: ['view', 'comment', 'terminalView', 'terminalInput'],
    });
    expect(store.accept(created.token, 'bob')).toEqual({ ok: false, reason: 'already-used' });
    expect(store.authenticateMember(accepted.accepted.memberToken)).toMatchObject({ acceptedBy: 'alice' });

    const revoked = store.revoke(created.invitation.invitationId);
    expect(revoked.ok).toBe(true);
    expect(store.authenticateMember(accepted.accepted.memberToken)).toBeNull();
  });

  it('rejects expired invitations', () => {
    let now = new Date('2026-05-15T20:00:00.000Z');
    const store = new InvitationStore({ now: () => now, tokenBytes: 8 });
    const created = store.create({
      nodeId: asNodeId('node-1'),
      grants: ['view'],
      ttlMs: 1_000,
    });

    now = new Date('2026-05-15T20:00:02.000Z');

    expect(store.accept(created.token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts share ID/password tickets through the existing member-token lifecycle', () => {
    const store = new InvitationStore({
      now: () => new Date('2026-05-15T20:00:00.000Z'),
      tokenBytes: 8,
      shareId: () => '482-913',
      sharePassword: () => 'cobalt-mint-7',
    });
    const created = store.create({
      nodeId: asNodeId('node-1'),
      grants: ['view'],
      ttlMs: 60_000,
      shareTicket: true,
    });

    expect(created.shareTicket).toEqual({
      shareId: '482-913',
      password: 'cobalt-mint-7',
      redactedShareLabel: '482-***',
    });
    expect(created.invitation).toMatchObject({
      shareId: '482-913',
      failedAcceptCount: 0,
      redactedShareLabel: '482-***',
    });
    expect(created.invitation.passwordVerifier).not.toContain('cobalt-mint-7');
    expect(created.invitation.passwordVerifier).toMatch(/^scrypt:16384:8:1:/);

    const accepted = store.acceptTicket('482 913', 'cobalt-mint-7', 'alice');
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('expected accept');
    expect(accepted.accepted.memberToken).toMatch(/^kookr_member_v1_/);
    expect(store.authenticateMember(accepted.accepted.memberToken)).toMatchObject({ acceptedBy: 'alice' });
    const resumed = store.acceptTicket('482-913', 'cobalt-mint-7', 'bob');
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected resumed accept');
    expect(resumed.accepted.memberToken).toMatch(/^kookr_member_v1_/);
    expect(resumed.accepted.memberToken).not.toBe(accepted.accepted.memberToken);
    expect(store.authenticateMember(resumed.accepted.memberToken)).toMatchObject({ acceptedBy: 'bob' });
  });

  it('scales share-ticket password entropy above the 24h share class', () => {
    const store = new InvitationStore({
      now: () => new Date('2026-05-15T20:00:00.000Z'),
      tokenBytes: 8,
      shareId: () => '482-913',
    });
    const created = store.create({
      nodeId: asNodeId('node-1'),
      grants: ['view'],
      ttlMs: 25 * 60 * 60 * 1000,
      shareTicket: true,
    });

    expect(created.shareTicket).toBeDefined();
    expect(Buffer.from(created.shareTicket!.password, 'base64url').byteLength).toBeGreaterThanOrEqual(10);
  });

  it('keeps 31-day invitation metadata valid after a fake-clock reload', () => {
    let now = new Date('2026-05-01T00:00:00.000Z');
    let persisted = [] as ReturnType<InvitationStore['list']>;
    const first = new InvitationStore({
      now: () => now,
      tokenBytes: 8,
      shareId: () => '482-913',
      onSave: (invitation) => {
        persisted = [invitation];
      },
    });
    first.create({
      nodeId: asNodeId('node-1'),
      grants: ['view'],
      ttlMs: 31 * 24 * 60 * 60 * 1000,
      shareTicket: true,
    });

    now = new Date('2026-05-31T00:00:00.000Z');
    const reloaded = new InvitationStore({ now: () => now, tokenBytes: 8, initialInvitations: persisted });

    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]).toMatchObject({
      shareId: '482-913',
      expiresAt: '2026-06-01T00:00:00.000Z',
    });
  });

  it('normalizes pre-upgrade persisted terminal input grants on reload', () => {
    let persisted = [] as ReturnType<InvitationStore['list']>;
    const first = new InvitationStore({
      now: () => new Date('2026-05-15T20:00:00.000Z'),
      tokenBytes: 8,
      onSave: (invitation) => {
        persisted = [invitation];
      },
    });
    first.create({
      nodeId: asNodeId('node-1'),
      grants: ['view', 'terminalInput'],
      ttlMs: 60_000,
    });
    persisted[0] = {
      ...persisted[0],
      grants: ['view', 'terminalInput'],
    };

    const reloaded = new InvitationStore({ tokenBytes: 8, initialInvitations: persisted });

    expect(reloaded.list()[0].grants).toEqual(['view', 'terminalView', 'terminalInput']);
  });

  it('locks a share ticket after repeated failed password guesses', () => {
    const store = new InvitationStore({
      now: () => new Date('2026-05-15T20:00:00.000Z'),
      tokenBytes: 8,
      shareId: () => '482-913',
      sharePassword: () => 'cobalt-mint-7',
    });
    store.create({
      nodeId: asNodeId('node-1'),
      grants: ['view'],
      ttlMs: 60_000,
      shareTicket: true,
    });

    for (let i = 0; i < 4; i += 1) {
      expect(store.acceptTicket('482-913', `wrong-${i}`)).toEqual({ ok: false, reason: 'invalid-password' });
    }
    expect(store.acceptTicket('482-913', 'wrong-4')).toEqual({ ok: false, reason: 'locked' });
    expect(store.acceptTicket('482-913', 'cobalt-mint-7')).toEqual({ ok: false, reason: 'locked' });
    expect(store.list()[0]).toMatchObject({
      failedAcceptCount: 5,
      lockedUntil: '2026-05-15T20:15:00.000Z',
    });
  });

  it('resets a locked share ticket with a new scrypt verifier', () => {
    const store = new InvitationStore({
      now: () => new Date('2026-05-15T20:00:00.000Z'),
      tokenBytes: 8,
      shareId: () => '482-913',
      sharePassword: () => 'cobalt-mint-7',
    });
    const created = store.create({
      nodeId: asNodeId('node-1'),
      grants: ['view'],
      ttlMs: 60_000,
      shareTicket: true,
    });
    for (let i = 0; i < 5; i += 1) store.acceptTicket('482-913', `wrong-${i}`);

    const reset = store.resetShareTicket(created.invitation.invitationId);
    expect(reset.ok).toBe(true);
    if (!reset.ok) throw new Error('expected reset');
    expect(reset.shareTicket).toEqual({
      shareId: '482-913',
      password: 'cobalt-mint-7',
      redactedShareLabel: '482-***',
    });
    expect(reset.invitation.failedAcceptCount).toBe(0);
    expect(reset.invitation.lockedUntil).toBeUndefined();
    expect(reset.invitation.passwordVerifier).toMatch(/^scrypt:16384:8:1:/);
    expect(store.acceptTicket('482-913', 'cobalt-mint-7', 'alice').ok).toBe(true);
  });
});
