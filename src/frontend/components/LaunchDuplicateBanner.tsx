import React from 'react';

export const LAUNCH_DUPLICATE_BANNER_ID = 'launch-duplicate-banner';

interface Props {
  taskName?: string;
  onOpenExisting: () => void;
  onLaunchAnyway: () => void;
}

/**
 * Pre-submit warning when prompt + cwd + agent already have an active task.
 * Same interrupt the CLI documents for `kookr spawn --dedupe=warn`.
 */
export function LaunchDuplicateBanner({ taskName, onOpenExisting, onLaunchAnyway }: Props) {
  const existingLabel = taskName?.trim() ? `Open existing (${taskName.trim()})` : 'Open existing';
  return (
    <div
      id={LAUNCH_DUPLICATE_BANNER_ID}
      className="launch-duplicate-banner"
      role="status"
      aria-live="polite"
      data-testid="launch-duplicate-banner"
    >
      <p className="launch-duplicate-banner__copy">
        An active task already uses this prompt, working directory, and agent.
        Open it, or launch anyway as an intentional duplicate.
      </p>
      <div className="launch-duplicate-banner__actions">
        <button
          type="button"
          className="btn-secondary"
          onClick={onOpenExisting}
          data-testid="launch-duplicate-open-existing"
        >
          {existingLabel}
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={onLaunchAnyway}
          data-testid="launch-duplicate-launch-anyway"
        >
          Launch anyway
        </button>
      </div>
    </div>
  );
}
