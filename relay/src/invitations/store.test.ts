import { describe, expect, it } from 'vitest';

import { asNodeId } from '../../../src/remote/ids.js';
import { InvitationStore } from './store.js';

describe('InvitationStore member continuity', () => {
  it('lets a share-ticket collaborator resume on another device without sharing the controller lease', () => {
    const store = new InvitationStore({
      shareId: () => '482-913',
      sharePassword: () => 'cobalt-mint-7',
      now: () => new Date('2026-05-17T00:00:00.000Z'),
    });
    store.create({
      nodeId: asNodeId('node-1'),
      subject: { kind: 'task', nodeId: asNodeId('node-1'), taskId: 'task-1' },
      grants: ['view', 'terminalView', 'terminalInput'],
      shareTicket: true,
    });

    const phone = store.acceptTicket('482-913', 'cobalt-mint-7', 'phone', 'device-phone');
    expect(phone.ok).toBe(true);
    const laptop = store.acceptTicket('482-913', 'cobalt-mint-7', 'laptop', 'device-laptop');
    expect(laptop.ok).toBe(true);
    if (!phone.ok || !laptop.ok) throw new Error('expected accepted sessions');

    expect(store.authenticateMember(phone.accepted.memberToken)?.memberDeviceId).toBe('device-phone');
    expect(store.authenticateMember(laptop.accepted.memberToken)?.memberDeviceId).toBe('device-laptop');

    const phoneLease = store.acquireControllerLease({
      invitationId: phone.accepted.invitation.invitationId,
      deviceId: 'device-phone',
      holderLabel: 'phone',
    });
    expect(phoneLease.ok).toBe(true);

    const laptopLease = store.acquireControllerLease({
      invitationId: laptop.accepted.invitation.invitationId,
      deviceId: 'device-laptop',
      holderLabel: 'laptop',
    });
    expect(laptopLease).toEqual(expect.objectContaining({
      ok: false,
      reason: 'held-by-another-device',
      lease: expect.objectContaining({ deviceId: 'device-phone' }),
    }));
  });

  it('restores device-scoped member sessions from persisted invitations', () => {
    const store = new InvitationStore({
      shareId: () => '482-913',
      sharePassword: () => 'cobalt-mint-7',
      now: () => new Date('2026-05-17T00:00:00.000Z'),
    });
    store.create({
      nodeId: asNodeId('node-1'),
      subject: { kind: 'task', nodeId: asNodeId('node-1'), taskId: 'task-1' },
      grants: ['view', 'terminalView', 'terminalInput'],
      shareTicket: true,
    });
    const phone = store.acceptTicket('482-913', 'cobalt-mint-7', 'phone', 'device-phone');
    const laptop = store.acceptTicket('482-913', 'cobalt-mint-7', 'laptop', 'device-laptop');
    expect(phone.ok).toBe(true);
    expect(laptop.ok).toBe(true);
    if (!phone.ok || !laptop.ok) throw new Error('expected accepted sessions');

    const restored = new InvitationStore({ initialInvitations: store.list() });

    expect(restored.authenticateMember(phone.accepted.memberToken)).toMatchObject({
      acceptedBy: 'phone',
      memberDeviceId: 'device-phone',
    });
    expect(restored.authenticateMember(laptop.accepted.memberToken)).toMatchObject({
      acceptedBy: 'laptop',
      memberDeviceId: 'device-laptop',
    });
  });

  it('keeps denied grant cooldowns invitation-wide across resumed devices', () => {
    const store = new InvitationStore({
      shareId: () => '482-913',
      sharePassword: () => 'cobalt-mint-7',
      now: () => new Date('2026-05-17T00:00:00.000Z'),
    });
    const created = store.create({
      nodeId: asNodeId('node-1'),
      subject: { kind: 'task', nodeId: asNodeId('node-1'), taskId: 'task-1' },
      grants: ['view'],
      shareTicket: true,
    });
    const first = store.acceptTicket('482-913', 'cobalt-mint-7', 'phone', 'device-phone');
    expect(first.ok).toBe(true);
    const requested = store.requestGrants({
      invitationId: created.invitation.invitationId,
      requestedGrants: ['terminalInput'],
      requestedBy: 'phone',
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw new Error('expected grant request');
    expect(store.resolveGrantRequest({
      invitationId: created.invitation.invitationId,
      requestId: requested.request.requestId,
      approve: false,
    }).ok).toBe(true);

    const second = store.acceptTicket('482-913', 'cobalt-mint-7', 'laptop', 'device-laptop');
    expect(second.ok).toBe(true);
    const repeated = store.requestGrants({
      invitationId: created.invitation.invitationId,
      requestedGrants: ['terminalInput'],
      requestedBy: 'laptop',
    });
    expect(repeated).toEqual(expect.objectContaining({
      ok: false,
      reason: 'denied-cooldown',
    }));
  });
});
