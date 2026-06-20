import React from 'react';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { markPermanentlyDismissed } from '../store/scheduled-tasks-hint-status.js';

interface Props {
  /** Hide for now (does not persist — may reappear after the next schedule). */
  onHide: () => void;
}

/**
 * One-time, dismissible callout shown after a user creates a schedule from the
 * task-panel schedule button. It points at the command-palette trigger (which
 * is spotlighted in parallel via the `schedule-hint-spotlight` class) so the
 * user learns where the Schedules action lives for next time.
 *
 * "Got it"/× hides it for now; "Don't show again" persists the dismissal so it
 * never reappears (see `scheduled-tasks-hint-status`). The eligibility check
 * (`shouldShow()`) lives at the call site in App, which also mounts this
 * component only while the hint is active.
 */
export function ScheduledTasksHint({ onHide }: Props) {
  useEscapeToClose(onHide);

  function dismissForever() {
    markPermanentlyDismissed();
    onHide();
  }

  return (
    <div className="scheduled-tasks-hint" role="status" aria-live="polite" aria-atomic="true">
      <div className="scheduled-tasks-hint-arrow" aria-hidden="true" />
      <button
        className="scheduled-tasks-hint-close"
        onClick={onHide}
        aria-label="Dismiss hint"
        title="Dismiss"
      >
        &times;
      </button>
      <div className="scheduled-tasks-hint-body">
        <strong>Schedule created.</strong>
        <span>
          Find your scheduled tasks anytime from <kbd>⌘K</kbd> (the
          {' '}<strong>Search actions</strong> button up here) — search
          {' '}<em>Schedules</em>.
        </span>
      </div>
      <div className="scheduled-tasks-hint-actions">
        <button className="btn-xs" onClick={onHide}>
          Got it
        </button>
        <button className="scheduled-tasks-hint-never" onClick={dismissForever}>
          Don&rsquo;t show again
        </button>
      </div>
    </div>
  );
}
