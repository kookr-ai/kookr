import React from 'react';

/**
 * The two notices an agent raises without a finding: its completion signal
 * (RFC rfc-agent-signal-surface) and the operator-needed flag (issue #1562).
 * Inside the decision card they render as lines of the card (issue #4024);
 * where no card shows (terminal focus, a completion digest) they keep their
 * own banner above the tabs. Both placements keep the same test ids and live
 * region, so a screen reader still hears them arrive.
 */
export type NoticePlacement = 'card' | 'banner';

export function AgentSignalNotice({
  placement,
  ready,
  note,
  onDismiss,
}: {
  placement: NoticePlacement;
  /** The agent is idle on a completed turn, so completing is safe now. */
  ready: boolean;
  note?: string;
  /** Present only when dismissing would clear the signal. */
  onDismiss?: () => void;
}) {
  const className = placement === 'card'
    ? 'decision-card-note'
    : `detail-signal-banner${ready ? ' detail-signal-banner--ready' : ''}`;
  return (
    <div className={className} role="status" aria-live="polite" data-testid="agent-signal-banner">
      <span className={placement === 'card' ? 'decision-card-note-text' : 'detail-signal-banner__text'}>
        <strong>Agent:</strong>{' '}
        {ready ? 'ready for review — complete this task?' : 'flagged ready (still working — review when idle)'}
        {note ? ` — ${note}` : ''}
      </span>
      {onDismiss && (
        <button
          type="button"
          className="action-btn action-btn--neutral"
          data-testid="agent-signal-dismiss"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

export function OperatorNeededNotice({ placement, message }: { placement: NoticePlacement; message: string }) {
  const className = placement === 'card'
    ? 'decision-card-note decision-card-note--attention'
    : 'detail-signal-banner detail-signal-banner--attention';
  return (
    <div className={className} role="status" aria-live="polite" data-testid="agent-operator-needed-banner">
      <span className={placement === 'card' ? 'decision-card-note-text' : 'detail-signal-banner__text'}>
        <strong>Operator needed:</strong> {message}
      </span>
    </div>
  );
}
