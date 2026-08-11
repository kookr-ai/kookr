import { chmodSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  COLLABORATION_CONTACT_SHARE_INVITE_SCHEMA_VERSION,
  type CollaborationContactShareInvite,
  type CollaborationGrantRecord,
  type CollaborationGrantRevocationTombstone,
} from '../shared/contracts/collaboration-share.js';
import type { VerifiedDevicePrincipal } from '../shared/contracts/collaboration-pairing.js';
import { CollaborationShareError, CollaborationShareStore } from './collaboration-share-store.js';

const PRINCIPAL: VerifiedDevicePrincipal = { contactId: 'contact-1', deviceId: 'device-1' };
const NOW = '2026-06-10T12:00:00.000Z';

function principal() {
  return { kind: 'contact-device' as const, ...PRINCIPAL };
}

function invite(overrides: Partial<CollaborationContactShareInvite> = {}): CollaborationContactShareInvite {
  return {
    schemaVersion: COLLABORATION_CONTACT_SHARE_INVITE_SCHEMA_VERSION,
    inviteId: 'invite-1',
    direction: 'outbound',
    principal: principal(),
    subject: { kind: 'task', taskId: 'task-1' },
    capabilities: ['viewTask'],
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function grant(overrides: Partial<CollaborationGrantRecord> = {}): CollaborationGrantRecord {
  return {
    grantId: 'grant-1',
    principal: principal(),
    subject: { kind: 'task', taskId: 'task-1' },
    capabilities: ['viewTask'],
    policyVersion: 1,
    createdAt: NOW,
    ...overrides,
  };
}

function tombstone(overrides: Partial<CollaborationGrantRevocationTombstone> = {}): CollaborationGrantRevocationTombstone {
  return {
    tombstoneId: 'tombstone-1',
    principal: principal(),
    subject: { kind: 'task', taskId: 'task-1' },
    capabilities: ['viewTask'],
    policyVersion: 2,
    revokedAt: '2026-06-10T12:01:00.000Z',
    inviteId: 'invite-1',
    grantId: 'grant-1',
    ...overrides,
  };
}

function store(filePath: string): CollaborationShareStore {
  return new CollaborationShareStore({
    filePath,
    auditLog: null,
    now: () => new Date(NOW),
    idGenerator: () => 'generated',
  });
}

describe('CollaborationShareStore persistence', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-share-store-'));
    filePath = join(dir, 'collaboration-shares.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('persists collaboration-shares.json with owner-only mode 0o600', async () => {
    const shareStore = store(filePath);
    await shareStore.load();
    await shareStore.createOutboundInvite(PRINCIPAL, { taskId: 'task-1' });

    const modeAfterCreate = statSync(filePath).mode & 0o777;
    expect(modeAfterCreate).toBe(0o600);

    // Re-write after a world-readable seed must still land at 0o600 (rename
    // preserves the temp file’s mode rather than the prior destination mode).
    chmodSync(filePath, 0o644);
    expect(statSync(filePath).mode & 0o777).toBe(0o644);

    await shareStore.createOutboundInvite(
      { contactId: 'contact-2', deviceId: 'device-2' },
      { taskId: 'task-2' },
    );

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  test('recovers from a truncated store file as empty state and can save again', async () => {
    await writeFile(filePath, '{"version":1,"policyVersion":', 'utf8');

    const shareStore = store(filePath);
    await expect(shareStore.load()).resolves.toBeUndefined();
    expect(shareStore.diagnostics()).toEqual({
      pendingInvites: 0,
      activeGrants: 0,
      expiredGrants: 0,
      revokedShares: 0,
      tombstones: 0,
    });

    await shareStore.createOutboundInvite(PRINCIPAL, { taskId: 'task-after-corrupt' });

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number;
      invites: Array<{ inviteId: string; subject: { taskId: string } }>;
    };
    expect(persisted.version).toBe(1);
    expect(persisted.invites).toEqual([
      expect.objectContaining({
        inviteId: 'collab-invite-generated',
        subject: { kind: 'task', taskId: 'task-after-corrupt' },
      }),
    ]);
  });

  test('drops unknown store envelope versions instead of loading future-shape trust state', async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 99,
        policyVersion: 2,
        invites: [invite({ status: 'accepted', grantId: 'grant-1' })],
        grants: [grant()],
        tombstones: [tombstone()],
      }),
      'utf8',
    );

    const shareStore = store(filePath);
    await shareStore.load();

    expect(shareStore.getGrant('grant-1')).toBeUndefined();
    expect(shareStore.listActiveTaskSharesForPrincipal(PRINCIPAL)).toEqual([]);
    expect(shareStore.listTombstones()).toEqual([]);
    expect(shareStore.diagnostics()).toEqual({
      pendingInvites: 0,
      activeGrants: 0,
      expiredGrants: 0,
      revokedShares: 0,
      tombstones: 0,
    });
  });

  test('keeps valid invite rows while filtering mismatched invite schema versions', async () => {
    const validAccepted = invite({ inviteId: 'invite-active', status: 'accepted', grantId: 'grant-active' });
    const validPending = invite({ inviteId: 'invite-pending', subject: { kind: 'task', taskId: 'task-pending' } });
    const wrongSchema = {
      ...invite({ inviteId: 'invite-v2', subject: { kind: 'task', taskId: 'task-v2' } }),
      schemaVersion: 'collaboration-contact-share-invite.v2',
    };
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        policyVersion: 1,
        invites: [validAccepted, wrongSchema, validPending],
        grants: [grant({ grantId: 'grant-active' })],
        tombstones: [],
      }),
      'utf8',
    );

    const shareStore = store(filePath);
    await shareStore.load();

    expect(shareStore.listActiveTaskSharesForPrincipal(PRINCIPAL)).toEqual([
      {
        invite: validAccepted,
        grant: grant({ grantId: 'grant-active' }),
      },
    ]);
    expect(shareStore.diagnostics().pendingInvites).toBe(1);
    await expect(shareStore.decide(PRINCIPAL, { inviteId: 'invite-v2', decision: 'accept' }))
      .rejects.toMatchObject<Partial<CollaborationShareError>>({
        code: 'contact-share-invite-not-found',
        status: 404,
      });
  });

  test('preserves tombstones on reload so revoked grants cannot become active again', async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        policyVersion: 2,
        invites: [invite({ status: 'accepted', grantId: 'grant-1' })],
        grants: [grant()],
        tombstones: [tombstone()],
      }),
      'utf8',
    );

    const firstLoad = store(filePath);
    await firstLoad.load();
    expect(firstLoad.getGrant('grant-1')).toBeUndefined();
    expect(firstLoad.listActiveTaskSharesForPrincipal(PRINCIPAL)).toEqual([]);
    expect(firstLoad.listRemovedTaskSharesForPrincipal(PRINCIPAL)).toEqual([
      {
        inviteId: 'invite-1',
        reason: 'revoked',
        policyVersion: 2,
        removedAt: '2026-06-10T12:01:00.000Z',
      },
    ]);

    const secondLoad = store(filePath);
    await secondLoad.load();
    expect(secondLoad.listTombstones()).toEqual([tombstone()]);
    expect(secondLoad.getGrant('grant-1')).toBeUndefined();
  });
});
