// Storage key value intentionally unchanged ('kookr:launchDialogDraft') so
// in-flight drafts survive the file/symbol rename without a migration step.
export const LAUNCH_TASK_DIALOG_DRAFT_KEY = 'kookr:launchDialogDraft';

export interface LaunchTaskDialogDraft {
  prompt: string;
  cwd: string;
  criteria: string;
  /**
   * Set when the draft was optimistically submitted: the dialog closes before
   * the server confirms the launch (RFC F12), so the draft is kept rather
   * than cleared — a failed launch must not lose the typed prompt. The marker
   * lets the next dialog open decide whether the launch was confirmed (clear)
   * or not (restore). Dropped again as soon as the user edits the restored
   * draft, because the save path persists only prompt/cwd/criteria.
   */
  submittedAt?: number;
}

export function loadLaunchTaskDialogDraft(): LaunchTaskDialogDraft | null {
  try {
    const raw = localStorage.getItem(LAUNCH_TASK_DIALOG_DRAFT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    return {
      prompt: typeof p.prompt === 'string' ? p.prompt : '',
      cwd: typeof p.cwd === 'string' ? p.cwd : '',
      criteria: typeof p.criteria === 'string' ? p.criteria : '',
      ...(typeof p.submittedAt === 'number' ? { submittedAt: p.submittedAt } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Stamp the stored draft as optimistically submitted. Called on submit
 * *instead of* clearing (RFC F12): the dialog closes before the server
 * confirms the launch, and clearing here would lose the prompt if the launch
 * fails server-side (e.g. nonexistent working directory).
 */
export function markLaunchTaskDialogDraftSubmitted(now: number = Date.now()): void {
  const draft = loadLaunchTaskDialogDraft();
  if (!draft) return;
  try {
    localStorage.setItem(
      LAUNCH_TASK_DIALOG_DRAFT_KEY,
      JSON.stringify({ ...draft, submittedAt: now }),
    );
  } catch {
    // Quota exceeded / private browsing — silently ignore.
  }
}

/**
 * Load the draft for a fresh dialog open. A never-submitted draft is returned
 * as-is. A draft carrying the {@link LaunchTaskDialogDraft.submittedAt}
 * marker is resolved against `isLaunchConfirmed` (typically "does a task
 * matching this prompt exist in the store?"): confirmed → the launch went
 * through, clear the draft and start empty; unconfirmed → the launch likely
 * failed, restore the draft so nothing typed is lost. The unconfirmed branch
 * errs toward restoring — worst case the user sees an already-launched prompt
 * with the existing "Discard draft" affordance, never data loss.
 */
export function loadLaunchTaskDialogDraftForOpen(
  isLaunchConfirmed: (draft: LaunchTaskDialogDraft) => boolean,
): LaunchTaskDialogDraft | null {
  const draft = loadLaunchTaskDialogDraft();
  if (!draft) return null;
  if (draft.submittedAt === undefined) return draft;
  if (isLaunchConfirmed(draft)) {
    clearLaunchTaskDialogDraft();
    return null;
  }
  return draft;
}

/**
 * Persist a draft. If both prompt and criteria are empty/whitespace, this
 * actively REMOVES any existing stored draft (i.e. save is not additive).
 * cwd alone does not count: it is auto-populated from recentPaths on open
 * and would otherwise cause every dialog-open to persist a zombie draft.
 */
export function saveLaunchTaskDialogDraft(draft: LaunchTaskDialogDraft): void {
  if (!draft.prompt.trim() && !draft.criteria.trim()) {
    clearLaunchTaskDialogDraft();
    return;
  }
  try {
    localStorage.setItem(LAUNCH_TASK_DIALOG_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Quota exceeded / private browsing — silently ignore.
  }
}

export function clearLaunchTaskDialogDraft(): void {
  try {
    localStorage.removeItem(LAUNCH_TASK_DIALOG_DRAFT_KEY);
  } catch {
    // Ignore.
  }
}
