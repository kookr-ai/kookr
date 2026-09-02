import React from 'react';
import type { GitHubPRState } from '../../../shared/protocol.js';
import { useKookrStore } from '../../store/useStore.js';
import {
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
  const className = [
    'finding-pr-chip',
    model.conflicting ? 'finding-pr-chip--conflict' : '',
    model.ciFailed ? 'finding-pr-chip--failed' : '',
    !model.conflicting && !model.ciFailed && model.changesRequested ? 'finding-pr-chip--attention' : '',
  ].filter(Boolean).join(' ');

  function handleClick(event: React.MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    onSelect();
    setLeftPane('github');
    setNarrowTab('github');
    if (useKookrStore.getState().detailPaneMode === 'right') {
      setDetailPaneMode('split');
    }
  }

  return (
    <button
      type="button"
      className={className}
      data-testid="finding-pr-chip"
      data-attention={attention ? 'true' : 'false'}
      aria-label={findingPrChipAriaLabel(model)}
      onClick={handleClick}
    >
      {findingPrChipLabel(model)}
    </button>
  );
}
