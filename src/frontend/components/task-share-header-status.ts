import type { TaskShareSummary } from '../../shared/contracts/remote-share.js';

export type TaskShareHeaderStatusKind =
  | 'none'
  | 'shared'
  | 'viewerConnected'
  | 'approvalRequested';

export interface TaskShareHeaderStatus {
  kind: TaskShareHeaderStatusKind;
  buttonLabel: string;
  badgeLabel: string | null;
  title: string;
}

function isActiveOwnerShare(share: TaskShareSummary): boolean {
  return share.state === 'waiting' || share.state === 'viewerConnected' || share.state === 'revokePending';
}

export function deriveTaskShareHeaderStatus(
  taskId: string | null | undefined,
  shares: readonly TaskShareSummary[],
): TaskShareHeaderStatus {
  const none: TaskShareHeaderStatus = {
    kind: 'none',
    buttonLabel: 'Share',
    badgeLabel: null,
    title: 'Share this task',
  };

  if (!taskId) return none;

  const activeShares = shares.filter((share) => share.taskId === taskId && isActiveOwnerShare(share));
  if (activeShares.length === 0) return none;

  const pendingRequestCount = activeShares.reduce((count, share) => (
    count + share.grantRequests.filter((request) => request.status === 'pending').length
  ), 0);

  if (pendingRequestCount > 0) {
    return {
      kind: 'approvalRequested',
      buttonLabel: 'Share',
      badgeLabel: pendingRequestCount === 1 ? 'Approval requested' : `${pendingRequestCount} approvals requested`,
      title: pendingRequestCount === 1
        ? 'Share status: collaborator approval requested'
        : `Share status: ${pendingRequestCount} collaborator approvals requested`,
    };
  }

  const viewerCount = activeShares.reduce((count, share) => count + share.connectedViewerCount, 0);
  if (viewerCount > 0) {
    return {
      kind: 'viewerConnected',
      buttonLabel: 'Share',
      badgeLabel: viewerCount === 1 ? 'Viewer connected' : `${viewerCount} viewers connected`,
      title: viewerCount === 1
        ? 'Share status: viewer connected'
        : `Share status: ${viewerCount} viewers connected`,
    };
  }

  return {
    kind: 'shared',
    buttonLabel: 'Share',
    badgeLabel: 'Shared',
    title: 'Share status: active share link',
  };
}
