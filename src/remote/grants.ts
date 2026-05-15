import type { KnownGrant, ShareGrant } from './policy-sync.js';

export const KNOWN_GRANTS: readonly KnownGrant[] = [
  'view',
  'comment',
  'terminalInput',
  'launch',
  'stop',
  'permissionApprove',
  'admin',
];

export function isKnownGrant(value: ShareGrant): value is KnownGrant {
  return (KNOWN_GRANTS as readonly string[]).includes(value);
}

export function grantForRemoteCommandAction(action: unknown): KnownGrant | null {
  switch (action) {
    case 'presetReply':
    case 'submitMessage':
    case 'leaseAcquire':
    case 'leaseHeartbeat':
    case 'leaseOverride':
      return 'terminalInput';
    case 'permissionApprove':
      return 'permissionApprove';
    case 'launch':
      return 'launch';
    case 'skip':
    case 'snooze':
    case 'mark-done':
      return 'stop';
    default:
      return null;
  }
}
