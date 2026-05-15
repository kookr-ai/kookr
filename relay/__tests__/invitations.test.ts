import { describe, expect, it } from 'vitest';

import { asNodeId } from '../../src/remote/ids.js';
import { InvitationStore } from '../src/invitations/store.js';

describe('InvitationStore', () => {
  it('creates single-use hashed invitations, accepts once, and revokes grants', () => {
    let now = new Date('2026-05-15T20:00:00.000Z');
    const store = new InvitationStore({ now: () => now, tokenBytes: 8 });

    const created = store.create({
      nodeId: asNodeId('node-1'),
      grants: ['view', 'comment', 'terminalInput'],
      ttlMs: 60_000,
    });

    expect(created.token).toMatch(/^kookr_inv_v1_/);
    expect(created.invitation.tokenHash).not.toBe(created.token);
    expect(store.list()[0]).toMatchObject({
      nodeId: 'node-1',
      grants: ['view', 'comment', 'terminalInput'],
      expiresAt: '2026-05-15T20:01:00.000Z',
    });

    const accepted = store.accept(created.token, 'alice');
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('expected accept');
    expect(accepted.accepted.memberToken).toMatch(/^kookr_member_v1_/);
    expect(accepted.accepted.policyGrant).toMatchObject({
      grantId: created.invitation.grantId,
      grants: ['view', 'comment', 'terminalInput'],
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
});
