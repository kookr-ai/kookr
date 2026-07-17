import React, { useState } from 'react';
import type { TaskCompletionFeedback } from '../../shared/contracts/messages.js';
import type { WorktreeCleanupVerdict } from '../../shared/contracts/worktree-cleanup-verdict.js';
import { CleanupWorktreeOption } from './CleanupWorktreeOption.js';

interface Props {
  feedback: TaskCompletionFeedback | undefined;
  requestReflect: boolean;
  cleanupWorktree: boolean;
  /** undefined while the removal probe is in flight. */
  cleanupVerdicts?: WorktreeCleanupVerdict[];
  /** The inspection errored — removability is unknown, not "no". */
  cleanupInspectFailed?: boolean;
  /** An agent is still driving the worktree; blocks cleanup client-side. */
  ralphActive?: boolean;
  cleanupRefreshing?: boolean;
  onRefreshCleanupVerdicts?: () => void;
  onChange: (feedback: TaskCompletionFeedback | undefined) => void;
  onRequestReflectChange: (requestReflect: boolean) => void;
  onCleanupWorktreeChange: (cleanupWorktree: boolean) => void;
}

/**
 * Inline thumbs UI for the Complete confirm dialog. Renders into
 * `ConfirmDialog`'s `footer` slot. The dialog's `suppressEnterToConfirm` is set
 * when the user opens the note textarea, so Enter inserts a newline rather than
 * prematurely submitting.
 *
 * State is owned by the dialog caller (App.tsx) — this component is a
 * controlled view that emits the new feedback shape on every change. Skipping
 * a rating is the default; passing `undefined` to onChange clears the rating.
 */
export function CompleteDialogFooter({
  feedback,
  requestReflect,
  cleanupWorktree,
  cleanupVerdicts,
  cleanupInspectFailed = false,
  ralphActive = false,
  cleanupRefreshing = false,
  onRefreshCleanupVerdicts,
  onChange,
  onRequestReflectChange,
  onCleanupWorktreeChange,
}: Props): JSX.Element {
  const [showNoteInput, setShowNoteInput] = useState(feedback !== undefined);

  function setRating(rating: 'up' | 'down') {
    if (feedback?.rating === rating) {
      // Click the active thumb again → unset
      onChange(undefined);
      onRequestReflectChange(false);
      setShowNoteInput(false);
      return;
    }
    setShowNoteInput(true);
    // Clear downReason when switching to thumbs-up
    onChange({
      rating,
      ...(feedback?.note !== undefined ? { note: feedback.note } : {}),
      ...(rating === 'down' && feedback?.downReason ? { downReason: feedback.downReason } : {}),
    });
    onRequestReflectChange(rating === 'down');
  }

  function setNote(note: string) {
    if (!feedback) return;
    const next: TaskCompletionFeedback = { rating: feedback.rating };
    if (note.length > 0) next.note = note;
    if (feedback.downReason !== undefined) next.downReason = feedback.downReason;
    onChange(next);
  }

  function setMyPromptUnclear(checked: boolean) {
    if (!feedback || feedback.rating !== 'down') return;
    const next: TaskCompletionFeedback = { rating: 'down' };
    if (feedback.note !== undefined) next.note = feedback.note;
    if (checked) next.downReason = 'my_prompt';
    onChange(next);
  }

  return (
    <div className="complete-feedback">
      <div className="complete-feedback-thumbs">
        <button
          type="button"
          className={`btn-thumb ${feedback?.rating === 'up' ? 'btn-thumb-active' : ''}`}
          onClick={() => setRating('up')}
          aria-pressed={feedback?.rating === 'up'}
          aria-label="Thumbs up"
        >
          👍
        </button>
        <button
          type="button"
          className={`btn-thumb ${feedback?.rating === 'down' ? 'btn-thumb-active' : ''}`}
          onClick={() => setRating('down')}
          aria-pressed={feedback?.rating === 'down'}
          aria-label="Thumbs down"
        >
          👎
        </button>
        <span className="complete-feedback-hint">
          {feedback ? '(click again to clear)' : '(optional — skip to complete without rating)'}
        </span>
      </div>
      {/* Renders nothing when the task owns no worktree — the option's own
          concern, not the caller's. */}
      <CleanupWorktreeOption
        cleanupWorktree={cleanupWorktree}
        verdicts={cleanupVerdicts}
        inspectFailed={cleanupInspectFailed}
        ralphActive={ralphActive}
        refreshing={cleanupRefreshing}
        onRefresh={() => onRefreshCleanupVerdicts?.()}
        onChange={onCleanupWorktreeChange}
      />
      {showNoteInput && feedback && (
        <>
          <textarea
            className="complete-feedback-note"
            placeholder={
              feedback.rating === 'up'
                ? 'What worked? (optional, ≤500 chars)'
                : 'What went wrong? (optional, ≤500 chars)'
            }
            value={feedback.note ?? ''}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={500}
          />
          {feedback.rating === 'down' && (
            <label className="complete-feedback-checkbox">
              <input
                type="checkbox"
                checked={feedback.downReason === 'my_prompt'}
                onChange={(e) => setMyPromptUnclear(e.target.checked)}
              />
              <span>My prompt was unclear (skips structural-fix proposals)</span>
            </label>
          )}
          <label className="complete-feedback-checkbox">
            <input
              type="checkbox"
              checked={requestReflect}
              onChange={(e) => onRequestReflectChange(e.target.checked)}
            />
            <span>Create reflection task after completion</span>
          </label>
        </>
      )}
    </div>
  );
}
