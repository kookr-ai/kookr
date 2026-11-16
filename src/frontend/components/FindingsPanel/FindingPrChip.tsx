import React from 'react';
import type { GitHubPRState } from '../../../shared/protocol.js';
import { useKookrStore } from '../../store/useStore.js';
import {
  deliveryGlyph,
  deliverySentence,
  deliveryTone,
  findingPrChipAriaLabel,
  findingPrChipLabel,
  selectFindingPrChip,
} from './finding-pr-chip.js';

export function FindingPrChip({
  prs,
  onSelect,
}: {
  prs: readonly GitHubPRState[] | undefined;
  onSelect: () => void;
}): React.ReactElement | null {
  const setLeftPane = useKookrStore((s) => s.setLeftPane);
  const setNarrowTab = useKookrStore((s) => s.setNarrowTab);
  const setDetailPaneMode = useKookrStore((s) => s.setDetailPaneMode);
  const model = selectFindingPrChip(prs ?? []);
  if (!model) return null;

  const attention = model.ciFailed || model.changesRequested || model.conflicting;
  const delivery = model.delivery;
  const tone = delivery ? deliveryTone(delivery) : null;
  const sentence = delivery ? deliverySentence(delivery) : null;
  const className = [
    'finding-pr-chip',
    // The delivery tone colours a quiet chip; CI, conflict and review problems keep their own colour.
    tone && !attention ? `finding-pr-chip--delivery-${tone}` : '',
    model.conflicting ? 'finding-pr-chip--conflict' : '',
    model.ciFailed ? 'finding-pr-chip--failed' : '',
    !model.conflicting && !model.ciFailed && model.changesRequested ? 'finding-pr-chip--attention' : '',
  ].filter(Boolean).join(' ');

  function handleClick(event: React.MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    onSelect();
    setLeftPane('github');
    setNarrowTab('github');
    // Leave terminal focus for the default tabbed layout, where the GitHub tab
    // is now selected; never opt the operator into a stored Split view.
    if (useKookrStore.getState().detailPaneMode === 'right') {
      setDetailPaneMode('tabs');
    }
  }

  return (
    <button
      type="button"
      className={className}
      data-testid="finding-pr-chip"
      data-attention={attention ? 'true' : 'false'}
      {...(delivery ? { 'data-delivery-stage': delivery.stage } : {})}
      aria-label={sentence ? `${findingPrChipAriaLabel(model)}. ${sentence}` : findingPrChipAriaLabel(model)}
      {...(sentence ? { title: sentence } : {})}
      onClick={handleClick}
    >
      {delivery && <span className="finding-pr-chip-glyph" aria-hidden="true">{deliveryGlyph(delivery)}</span>}
      {findingPrChipLabel(model)}
    </button>
  );
}
