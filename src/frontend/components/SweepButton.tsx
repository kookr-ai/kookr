import { useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { ClientMessage } from '../../shared/protocol.js';

interface Props {
  send: (msg: ClientMessage) => void;
  /** Number of known projects — shown in the confirmation dialog. */
  projectCount: number;
}

/**
 * Cross-project worktree sweep trigger.
 *
 * Renders an icon button that lives inside the TopBar's metric-group
 * alongside the other global actions (OSS view, schedules, settings).
 * The confirmation dialog is co-located so the trigger and its dialog
 * stay in one component. While the server is working, the button is
 * disabled; the reconnect snapshot carries sweepRunning so a page
 * refresh restores the disabled state.
 */
export function SweepButton({ send, projectCount }: Props) {
  const { sweepRunning, setSweepRunning } = useKookrStore();
  const [confirming, setConfirming] = useState(false);

  const disabled = sweepRunning || projectCount === 0;
  const title = sweepRunning
    ? 'Sweep in progress…'
    : projectCount === 0
      ? 'Sweep merged worktrees (no known projects)'
      : `Sweep merged worktrees across ${projectCount} project(s)`;

  function triggerSweep() {
    setSweepRunning(true);
    send({ type: 'workspace:sweep' });
    setConfirming(false);
  }

  return (
    <>
      <button
        type="button"
        className="btn-icon"
        data-testid="sweep-button"
        onClick={() => setConfirming(true)}
        disabled={disabled}
        title={title}
        aria-label={title}
      >
        {/* Feather "wind" — semantically suggests a sweeping motion */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.59 4.59A2 2 0 1 1 11 8H2" />
          <path d="M12.59 19.41A2 2 0 1 0 14 16H2" />
          <path d="M17.73 7.73A2.5 2.5 0 1 1 19.5 12H2" />
        </svg>
      </button>

      {confirming && (
        <div
          className="sweep-confirm-backdrop"
          data-testid="sweep-confirm"
          role="dialog"
          aria-modal="true"
        >
          <div className="sweep-confirm-dialog">
            <h3 className="sweep-confirm-title">Sweep merged worktrees</h3>
            <p>
              Kookr will visit <strong>{projectCount}</strong> known project(s) and remove worktrees
              whose branches are fully merged into their baseline. <em>patch_equivalent</em> worktrees
              are <strong>not</strong> touched by the sweep (per-project panel only).
            </p>
            <p className="sweep-confirm-hint">
              Deleted branches remain recoverable via <code>git reflog</code> in each repo for ~30 days.
            </p>
            <div className="sweep-confirm-actions">
              <button
                type="button"
                className="sweep-confirm-cancel"
                onClick={() => setConfirming(false)}
                data-testid="sweep-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className="sweep-confirm-go"
                onClick={triggerSweep}
                data-testid="sweep-confirm-go"
              >
                Sweep
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
