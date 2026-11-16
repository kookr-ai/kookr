import type { GitHubPRState } from '../../../shared/protocol.js';
import type { PrDeliveryState } from '../../../shared/contracts/pr-delivery.js';
import { formatCompactDateTime } from '../../presentation.js';

export interface FindingPrChipModel {
  number: number;
  status: GitHubPRState['status'];
  ciFailed: boolean;
  changesRequested: boolean;
  conflicting: boolean;
  /** Where the change is relative to the integration train (issue #3915), when the server knows. */
  delivery?: PrDeliveryState;
}

/** Visual tone of the delivery badge; each tone also has its own glyph, so colour is never the only cue. */
export type DeliveryTone = 'open' | 'staging' | 'main' | 'reverted' | 'skipped';

function hasFailedCheck(pr: GitHubPRState): boolean {
  return pr.checks.some((check) => check.conclusion === 'failure');
}

function isConflicting(pr: GitHubPRState): boolean {
  return pr.mergeable === 'CONFLICTING';
}

function needsAttention(pr: GitHubPRState): boolean {
  return pr.reviewDecision === 'changes_requested' || hasFailedCheck(pr) || isConflicting(pr);
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
    conflicting: isConflicting(pr),
    ...(pr.delivery ? { delivery: pr.delivery } : {}),
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

/** Tone of a delivery state; skipping the train outranks being on main. */
export function deliveryTone(delivery: PrDeliveryState): DeliveryTone {
  switch (delivery.stage) {
    case 'pr-open': return 'open';
    case 'in-staging': return 'staging';
    case 'reverted': return 'reverted';
    case 'on-main': return delivery.skippedTrain ? 'skipped' : 'main';
  }
}

const DELIVERY_GLYPH: Record<DeliveryTone, string> = {
  open: '○',
  staging: '◐',
  main: '●',
  reverted: '↺',
  skipped: '!',
};

export function deliveryGlyph(delivery: PrDeliveryState): string {
  return DELIVERY_GLYPH[deliveryTone(delivery)];
}

/** Short words for the badge: `in staging`, `on main · skipped train`, `reverted · fix 2/3`. */
export function deliveryShortLabel(delivery: PrDeliveryState, status: GitHubPRState['status'] = 'open'): string {
  switch (delivery.stage) {
    case 'pr-open': return status === 'draft' ? 'draft' : 'PR open';
    case 'in-staging': return `in ${delivery.integrationBranch}`;
    case 'on-main': return delivery.skippedTrain ? 'on main · skipped train' : 'on main';
    case 'reverted': {
      const revert = delivery.revert;
      if (revert?.needsHuman) return 'reverted · needs you';
      if (revert?.attempt !== undefined) return `reverted · fix ${revert.attempt}/${revert.maxAttempts ?? 3}`;
      return 'reverted';
    }
  }
}

/** One sentence for a tooltip or screen reader: what the state means and since when. */
export function deliverySentence(delivery: PrDeliveryState, now: Date = new Date()): string {
  const at = (iso: string | undefined): string => (iso ? formatCompactDateTime(iso, now) : '');
  const since = (iso: string | undefined): string => (at(iso) ? ` since ${at(iso)}` : '');
  const branch = delivery.integrationBranch;
  switch (delivery.stage) {
    case 'pr-open':
      return `PR open${since(delivery.openedAt)}; it will be merged into ${branch}.`;
    case 'in-staging':
      return `In ${branch}${since(delivery.mergedAt)}, awaiting the train: main does not have it yet.`;
    case 'on-main':
      return delivery.skippedTrain
        ? `On main${since(delivery.mergedAt)}, merged straight into main: it skipped the train.`
        : `On main${since(delivery.onMainAt)}: the train verified it.`;
    case 'reverted': {
      const revert = delivery.revert;
      const when = at(delivery.revertedAt) ? ` at ${at(delivery.revertedAt)}` : '';
      const next = revert?.needsHuman
        ? 'No fix task is running: it needs a human.'
        : revert?.attempt !== undefined
          ? `Fix attempt ${revert.attempt} of ${revert.maxAttempts ?? 3} is running.`
          : '';
      return `Reverted by the train${when}: the full suite failed on it.${next ? ` ${next}` : ''}`;
    }
  }
}

export interface DeliveryTimelineStep {
  label: string;
  at?: string;
  /** done: reached; pending: not yet; bad: the revert; warn: skipped the train. */
  state: 'done' | 'pending' | 'bad' | 'warn';
}

/** The steps the detail pane lists, oldest first. */
export function deliveryTimeline(delivery: PrDeliveryState): DeliveryTimelineStep[] {
  const opened: DeliveryTimelineStep = { label: 'PR opened', state: 'done', ...(delivery.openedAt ? { at: delivery.openedAt } : {}) };
  const branch = delivery.integrationBranch;
  switch (delivery.stage) {
    case 'pr-open':
      return [opened, { label: `Merged into ${branch}`, state: 'pending' }, { label: 'On main', state: 'pending' }];
    case 'in-staging':
      return [
        opened,
        { label: `Merged into ${branch}`, state: 'done', ...(delivery.mergedAt ? { at: delivery.mergedAt } : {}) },
        { label: 'On main: awaiting the train', state: 'pending' },
      ];
    case 'on-main':
      if (delivery.skippedTrain) {
        return [opened, { label: 'Merged straight into main (skipped the train)', state: 'warn', ...(delivery.mergedAt ? { at: delivery.mergedAt } : {}) }];
      }
      return [
        opened,
        { label: `Merged into ${branch}`, state: 'done', ...(delivery.mergedAt ? { at: delivery.mergedAt } : {}) },
        { label: 'On main', state: 'done', ...(delivery.onMainAt ? { at: delivery.onMainAt } : {}) },
      ];
    case 'reverted':
      return [
        opened,
        { label: `Merged into ${branch}`, state: 'done', ...(delivery.mergedAt ? { at: delivery.mergedAt } : {}) },
        { label: 'Reverted by the train', state: 'bad', ...(delivery.revertedAt ? { at: delivery.revertedAt } : {}) },
      ];
  }
}

export function findingPrChipLabel(model: FindingPrChipModel): string {
  // A merged or open PR with a delivery state says where the change is instead of "merged".
  const statusWord = model.delivery ? deliveryShortLabel(model.delivery, model.status) : model.status;
  const parts = [`#${model.number}`, statusWord];
  if (model.conflicting) parts.push('conflict');
  if (model.ciFailed) parts.push('CI failed');
  if (model.changesRequested) parts.push('changes requested');
  return parts.join(' · ');
}

export function findingPrChipAriaLabel(model: FindingPrChipModel): string {
  return `Open GitHub pane for pull request ${findingPrChipLabel(model)}`;
}
