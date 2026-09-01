import React from 'react';

export const LAUNCH_DUPLICATE_BANNER_ID = 'launch-duplicate-banner';

interface Props {
  taskName?: string;
  onOpenExisting: () => void;
  onLaunchAnyway: () => void;
  launchAnywayDisabled?: boolean;
}

/**
 * Pre-submit warning when prompt + cwd + agent already have an active task.
 * Same interrupt the CLI documents for `kookr spawn --dedupe=warn`.
 */
export function LaunchDuplicateBanner({
  taskName,
  onOpenExisting,
  onLaunchAnyway,
  launchAnywayDisabled = false,
}: Props) {
  const trimmedName = taskName?.trim();
  const existingLabel = trimmedName ? `Open existing (${trimmedName})` : 'Open existing';
  return (
    <div
      className="launch-duplicate-banner"
      data-testid="launch-duplicate-banner"
    >
      <p
        id={LAUNCH_DUPLICATE_BANNER_ID}
        className="launch-duplicate-banner__copy"
        role="status"
        aria-live="polite"
      >
        An active task already uses this prompt, working directory, and agent.
        Open it, or launch anyway as an intentional duplicate.
      </p>
      <div className="launch-duplicate-banner__actions" role="group" aria-label="Duplicate launch warning">
        <button
          type="button"
          className="btn-secondary launch-duplicate-banner__open"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onOpenExisting}
          title={trimmedName ? `Open existing task: ${trimmedName}` : 'Open existing task'}
          aria-label={trimmedName ? `Open existing task: ${trimmedName}` : 'Open existing'}
          data-testid="launch-duplicate-open-existing"
        >
          {existingLabel}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onLaunchAnyway}
          disabled={launchAnywayDisabled}
          data-testid="launch-duplicate-launch-anyway"
        >
          Launch anyway
        </button>
      </div>
    </div>
  );
}
