import type { GitHubPRState } from '../../../shared/protocol.js';

export interface FindingPrChipModel {
  number: number;
  status: GitHubPRState['status'];
  ciFailed: boolean;
  changesRequested: boolean;
}

function hasFailedCheck(pr: GitHubPRState): boolean {
  return pr.checks.some((check) => check.conclusion === 'failure');
}

function needsAttention(pr: GitHubPRState): boolean {
  return pr.reviewDecision === 'changes_requested' || hasFailedCheck(pr);
}

function statusRank(status: GitHubPRState['status']): number {
  switch (status) {
    case 'open': return 0;
    case 'draft': return 1;
    case 'merged': return 2;
    case 'closed': return 3;
  }
}

function toModel(pr: GitHubPRState): FindingPrChipModel {
  return {
    number: pr.ref.number,
    status: pr.status,
    ciFailed: hasFailedCheck(pr),
    changesRequested: pr.reviewDecision === 'changes_requested',
  };
}

/**
 * Pick the single PR a finding card should surface. Prefer a PR that needs
 * attention (failed CI or changes requested), then open/draft over merged/closed.
 */
export function selectFindingPrChip(prs: readonly GitHubPRState[]): FindingPrChipModel | null {
  if (prs.length === 0) return null;
  const ranked = [...prs].sort((left, right) => {
    const attention = Number(needsAttention(right)) - Number(needsAttention(left));
    if (attention !== 0) return attention;
    const status = statusRank(left.status) - statusRank(right.status);
    if (status !== 0) return status;
    return left.ref.number - right.ref.number;
  });
  return toModel(ranked[0]!);
}

export function findingPrChipLabel(model: FindingPrChipModel): string {
  const parts = [`#${model.number}`, model.status];
  if (model.ciFailed) parts.push('CI failed');
  if (model.changesRequested) parts.push('changes requested');
  return parts.join(' · ');
}

export function findingPrChipAriaLabel(model: FindingPrChipModel): string {
  return `Open GitHub pane for pull request ${findingPrChipLabel(model)}`;
}
