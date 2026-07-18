import React, { useState } from 'react';
import type { WorktreeCleanupVerdict } from '../../shared/contracts/worktree-cleanup-verdict.js';
import { describeBlocker, formatDirtySummary, totalDirtyCount } from '../../shared/contracts/worktree-cleanup-verdict.js';

interface Props {
  verdict: WorktreeCleanupVerdict;
  /** Blocked-but-recoverable states render amber rather than red. */
  tone: 'safe' | 'blocked' | 'pending';
}

/**
 * One worktree's verdict: a status line, plus a `why?` drawer holding the
 * evidence behind it.
 *
 * The drawer opens whenever the verdict is blocked — a refused action should
 * explain itself without a second click — and stays closed when safe, where the
 * detail only interests someone who doubts the answer.
 */
export function WorktreeCleanupVerdictRow({ verdict, tone }: Props): JSX.Element {
  const blocked = !verdict.removable;
  const [toggle, setToggle] = useState<{ open: boolean; forVerdict: string } | null>(null);

  // Derived, not initialised-once: a re-check keeps this row mounted (rows are
  // keyed by the stable worktree path), so a safe→blocked flip must open the
  // drawer rather than leave the refusal unexplained.
  //
  // An explicit toggle wins, but only for the verdict it was made against —
  // dismissing the detail of a *safe* row expresses no opinion about a later
  // refusal, and letting it carry over would re-hide the explanation.
  const verdictKey = `${verdict.removable}:${verdict.blocker ?? ''}`;
  const showDetails = toggle !== null && toggle.forVerdict === verdictKey ? toggle.open : blocked;

  const glyphColor = tone === 'safe' ? 'var(--green)' : tone === 'pending' ? 'var(--amber)' : 'var(--red)';
  const verdictColor = tone === 'safe' ? 'var(--text-muted)' : glyphColor;

  const dirtyText = formatDirtySummary(verdict.evidence.dirty);
  const hasDirty = verdict.evidence.dirty !== undefined;
  const hasAhead = verdict.evidence.aheadCount !== undefined;

  return (
    <>
      {/* Identity and verdict are separate rows: worktree names here run to 40+
          chars, and sharing a row means either the name wraps mid-word or the
          verdict gets truncated. Neither degrades well. */}
      <div className="complete-cleanup-idline">
        <span aria-hidden="true" style={{ color: glyphColor }}>{blocked ? '✕' : '✓'}</span>
        <span className="complete-cleanup-name" title={verdict.worktreePath}>
          {verdict.worktreeName}
        </span>
      </div>
      <div className="complete-cleanup-line">
        <span style={{ color: verdictColor }}>
          {blocked && verdict.blocker
            ? `kept — ${describeBlocker(verdict.blocker)}`
            : 'safe to remove'}
        </span>
        <button
          type="button"
          className="complete-cleanup-why"
          aria-expanded={showDetails}
          // Named per worktree: a task with two worktrees otherwise renders two
          // identically-labelled "hide" buttons in a screen reader's button list.
          aria-label={`${showDetails ? 'Hide' : 'Why?'} — ${verdict.worktreeName}`}
          onClick={() => setToggle({ open: !showDetails, forVerdict: verdictKey })}
        >
          {showDetails ? 'hide' : 'why?'}
        </button>
      </div>
      {showDetails && (
        <div className="complete-cleanup-details">
          {/* The visible name is CSS-truncated and the full path is otherwise
              only in a `title`, which keyboard and touch users never see. */}
          <div><span className="k">path</span> {verdict.worktreePath}</div>
          {verdict.branch !== undefined && (
            <div><span className="k">branch</span> {verdict.branch}</div>
          )}
          {hasDirty && (
            <div>
              <span className="k">status</span>{' '}
              {totalDirtyCount(verdict.evidence.dirty) === 0 ? 'clean (0 changes)' : dirtyText}
            </div>
          )}
          {hasAhead && (
            <div>
              <span className="k">ahead</span> {verdict.evidence.aheadCount}
              {verdict.evidence.aheadCount === 1 ? ' commit' : ' commits'} ahead of the cleanup baseline
            </div>
          )}
        </div>
      )}
    </>
  );
}
