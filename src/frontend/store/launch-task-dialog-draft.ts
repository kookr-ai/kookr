// Storage key value intentionally unchanged ('kookr:launchDialogDraft') so
// in-flight drafts survive the file/symbol rename without a migration step.
export const LAUNCH_TASK_DIALOG_DRAFT_KEY = 'kookr:launchDialogDraft';

export interface LaunchTaskDialogDraft {
  prompt: string;
  cwd: string;
  criteria: string;
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
    };
  } catch {
    return null;
  }
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
