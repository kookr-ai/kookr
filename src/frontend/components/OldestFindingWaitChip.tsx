import React, { useEffect, useState } from 'react';
import { formatOldestFindingWait } from '../presentation.js';

/*
 * Age of the oldest unanswered finding, on the right of the list's "Needs you"
 * header (issue #3561 slice 5b; the variant B frames put "oldest first" there).
 * It moved out of the removed status bar. Clicking it selects that finding.
 */

const TITLE = 'Age of the oldest unanswered finding — live wait, not the historical median';

interface Props {
  findings: number;
  startedAt?: Date | string;
  /** Optional so an isolated list still shows a passive readout. */
  onSelect?: () => void;
}

export function OldestFindingWaitChip({ findings, startedAt, onSelect }: Props) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (findings <= 0 || startedAt === undefined) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => clearInterval(timer);
  }, [findings, startedAt]);

  const label = findings > 0 ? formatOldestFindingWait(startedAt) : null;
  if (!label) return null;
  if (onSelect) {
    return (
      <button
        type="button"
        className="oldest-finding-wait-pill"
        data-testid="oldest-finding-wait-chip"
        title={TITLE}
        aria-label={`oldest ${label}. Select oldest unanswered finding`}
        onClick={onSelect}
      >
        oldest {label}
      </button>
    );
  }
  return (
    <span className="oldest-finding-wait-pill" data-testid="oldest-finding-wait-chip" role="status" title={TITLE}>
      oldest {label}
    </span>
  );
}
