import { describe, expect, test } from 'vitest';
import type { TaskShareSummary } from '../../remote/share-contract.js';
import { deriveTaskShareHeaderStatus } from './task-share-header-status.js';

function share(overrides: Partial<TaskShareSummary> = {}): TaskShareSummary {
  return {
    invitationId: 'inv-1',
    taskId: 'task-1',
    createdAt: '2026-05-17T12:00:00.000Z',
    expiresAt: '2026-05-17T12:10:00.000Z',
    state: 'waiting',
    connectedViewerCount: 0,
    grants: ['view'],
    grantRequests: [],
    ...overrides,
  };
}

describe('deriveTaskShareHeaderStatus', () => {
  test('maps no active share to the plain share button', () => {
    expect(deriveTaskShareHeaderStatus('task-1', [])).toEqual({
      kind: 'none',
      buttonLabel: 'Share',
      badgeLabel: null,
      title: 'Share this task',
    });
    expect(deriveTaskShareHeaderStatus('task-1', [share({ state: 'revoked' })]).kind).toBe('none');
  });

  test('maps an active waiting share to a shared badge', () => {
    expect(deriveTaskShareHeaderStatus('task-1', [share()])).toEqual({
      kind: 'shared',
      buttonLabel: 'Share',
      badgeLabel: 'Shared',
      title: 'Share status: active share link',
    });
  });

  test('maps connected viewers to aggregate viewer badges', () => {
    expect(deriveTaskShareHeaderStatus('task-1', [share({
      state: 'viewerConnected',
      connectedViewerCount: 1,
    })]).badgeLabel).toBe('Viewer connected');
    expect(deriveTaskShareHeaderStatus('task-1', [
      share({ state: 'viewerConnected', connectedViewerCount: 2 }),
      share({ invitationId: 'inv-2', state: 'viewerConnected', connectedViewerCount: 1 }),
    ]).badgeLabel).toBe('3 viewers connected');
  });

  test('prioritizes pending approval requests without leaking request comments or ids', () => {
    const status = deriveTaskShareHeaderStatus('task-1', [share({
      state: 'viewerConnected',
      connectedViewerCount: 1,
      grantRequests: [{
        requestId: 'raw-request-id',
        invitationId: 'raw-invitation-id',
        requestedGrants: ['terminalInput'],
        status: 'pending',
        requestedAt: '2026-05-17T12:01:00.000Z',
        comment: 'Alice requested terminal input',
      }],
    })]);

    expect(status.kind).toBe('approvalRequested');
    expect(status.badgeLabel).toBe('Approval requested');
    expect(`${status.badgeLabel} ${status.title}`).not.toContain('raw-request-id');
    expect(`${status.badgeLabel} ${status.title}`).not.toContain('Alice');
  });

  test('ignores shares for other tasks', () => {
    expect(deriveTaskShareHeaderStatus('task-2', [share()]).kind).toBe('none');
  });
});
