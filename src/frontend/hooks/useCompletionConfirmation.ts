import { useCallback, useEffect, useState } from 'react';
import type { TaskCompletionFeedback } from '../../shared/contracts/messages.js';

/**
 * The task a "Complete Task" confirmation dialog is currently gathering input
 * for. Non-null only while the dialog is being prepared/open.
 */
export interface PendingCompleteConfirmation {
  taskId: string;
  agentId: string;
  label: string;
  method: 'button' | 'shortcut';
}

export interface CompletionConfirmationState {
  /** The task awaiting confirmation, or null when the flow is idle. */
  pending: PendingCompleteConfirmation | null;
  /** Optional thumbs up/down + note the user attached in the dialog footer. */
  feedback: TaskCompletionFeedback | undefined;
  setFeedback: React.Dispatch<React.SetStateAction<TaskCompletionFeedback | undefined>>;
  /** Whether to kick off a reflection task after completing. */
  requestReflect: boolean;
  setRequestReflect: React.Dispatch<React.SetStateAction<boolean>>;
  /** Whether the task's worktree(s) should be cleaned up on completion. */
  cleanupWorktree: boolean;
  /** True once the user manually toggled the cleanup checkbox this session. */
  cleanupWorktreeTouched: boolean;
  /** Set the cleanup checkbox AND mark it user-touched (footer interaction). */
  setCleanupWorktree: (value: boolean) => void;
  /** Open the flow for a task, seeding the cleanup default and clearing touched. */
  begin: (target: PendingCompleteConfirmation) => void;
  /** Return every field to its idle default (used on confirm and on cancel). */
  reset: () => void;
}

/**
 * Encapsulates the task-completion confirmation flow that previously lived as
 * five interleaved `useState`s in {@link App} (issue #1825): the pending task,
 * the feedback draft, the reflect toggle, and the worktree-cleanup checkbox
 * (value + whether the user has touched it).
 *
 * Whether the dialog is actually rendered stays the caller's decision — it is
 * gated on a shared cancel/complete selector so a cancel confirmation and a
 * complete confirmation remain mutually exclusive. The caller passes that gate
 * in as {@link options.isOpen} so the cleanup-default sync effect only runs
 * while the complete dialog is showing.
 */
export function useCompletionConfirmation(options: {
  /** Saved "cleanup worktree on complete" preference, or undefined until settings load. */
  cleanupWorktreeOnComplete: boolean | undefined;
  /** True while the complete confirmation dialog is open (drives the default sync). */
  isOpen: boolean;
  /** Side effect to run when a confirmation begins, e.g. request a cleanup inspection. */
  onBegin: (taskId: string) => void;
}): CompletionConfirmationState {
  const { cleanupWorktreeOnComplete, isOpen, onBegin } = options;

  const [pending, setPending] = useState<PendingCompleteConfirmation | null>(null);
  const [feedback, setFeedback] = useState<TaskCompletionFeedback | undefined>(undefined);
  const [requestReflect, setRequestReflect] = useState(false);
  const [cleanupWorktree, setCleanupWorktreeState] = useState(true);
  const [cleanupWorktreeTouched, setCleanupWorktreeTouched] = useState(false);

  // The saved cleanup default may resolve AFTER the dialog opens (settings are
  // fetched asynchronously). While the dialog is open and the user has not
  // manually toggled the checkbox, keep it synced to the saved preference.
  useEffect(() => {
    if (!isOpen || cleanupWorktreeOnComplete === undefined || cleanupWorktreeTouched) return;
    setCleanupWorktreeState(cleanupWorktreeOnComplete);
  }, [cleanupWorktreeOnComplete, cleanupWorktreeTouched, isOpen]);

  const begin = useCallback((target: PendingCompleteConfirmation) => {
    setPending(target);
    setCleanupWorktreeState(cleanupWorktreeOnComplete ?? true);
    setCleanupWorktreeTouched(false);
    onBegin(target.taskId);
  }, [cleanupWorktreeOnComplete, onBegin]);

  const reset = useCallback(() => {
    setPending(null);
    setFeedback(undefined);
    setRequestReflect(false);
    setCleanupWorktreeState(true);
    setCleanupWorktreeTouched(false);
  }, []);

  const setCleanupWorktree = useCallback((value: boolean) => {
    setCleanupWorktreeState(value);
    setCleanupWorktreeTouched(true);
  }, []);

  return {
    pending,
    feedback,
    setFeedback,
    requestReflect,
    setRequestReflect,
    cleanupWorktree,
    cleanupWorktreeTouched,
    setCleanupWorktree,
    begin,
    reset,
  };
}
