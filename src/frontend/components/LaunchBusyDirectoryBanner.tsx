import React from 'react';
import type { LaunchDuplicateCandidate } from '../../shared/launch-duplicate.js';

export const LAUNCH_BUSY_DIRECTORY_BANNER_ID = 'launch-busy-directory-banner';

interface Props {
  tasks: readonly LaunchDuplicateCandidate[];
  onOpenExisting: () => void;
  onLaunchAnyway: () => void;
}

function displayName(task: LaunchDuplicateCandidate): string {
  const named = task.taskName?.trim();
  if (named) return named;
  const desc = (task.description ?? task.userPrompt ?? task.prompt ?? '').trim();
  if (!desc) return task.taskId ?? task.id ?? 'untitled task';
  return desc.length > 40 ? `${desc.slice(0, 39)}…` : desc;
}

/**
 * Pre-submit warning when the chosen working directory already has live agents,
 * even when those agents have different prompts. Warning only — does not block
 * the main Launch button.
 */
export function LaunchBusyDirectoryBanner({ tasks, onOpenExisting, onLaunchAnyway }: Props) {
  const count = tasks.length;
  const names = tasks.map(displayName).join(', ');
  const agentWord = count === 1 ? 'live agent' : 'live agents';
  const oldestName = tasks[0] ? displayName(tasks[0]) : undefined;
  const existingLabel = oldestName ? `Open existing (${oldestName})` : 'Open existing';

  return (
    <div
      className="launch-busy-directory-banner"
      data-testid="launch-busy-directory-banner"
    >
      <p
        id={LAUNCH_BUSY_DIRECTORY_BANNER_ID}
        className="launch-busy-directory-banner__copy"
        role="status"
        aria-live="polite"
      >
        This working directory already has {count} {agentWord}: {names}.
        Open one, or launch anyway.
      </p>
      <div className="launch-busy-directory-banner__actions" role="group" aria-label="Busy directory warning">
        <button
          type="button"
          className="btn-secondary launch-busy-directory-banner__open"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onOpenExisting}
          title={oldestName ? `Open existing task: ${oldestName}` : 'Open existing task'}
          aria-label={oldestName ? `Open existing task: ${oldestName}` : 'Open existing'}
          data-testid="launch-busy-directory-open-existing"
        >
          {existingLabel}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onLaunchAnyway}
          data-testid="launch-busy-directory-launch-anyway"
        >
          Launch anyway
        </button>
      </div>
    </div>
  );
}
