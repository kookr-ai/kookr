export const LAUNCH_DIALOG_DRAFT_KEY = 'kookr:launchDialogDraft';

export interface LaunchDialogDraft {
  prompt: string;
  cwd: string;
  criteria: string;
}

export function loadLaunchDialogDraft(): LaunchDialogDraft | null {
  try {
    const raw = localStorage.getItem(LAUNCH_DIALOG_DRAFT_KEY);
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
export function saveLaunchDialogDraft(draft: LaunchDialogDraft): void {
  if (!draft.prompt.trim() && !draft.criteria.trim()) {
    clearLaunchDialogDraft();
    return;
  }
  try {
    localStorage.setItem(LAUNCH_DIALOG_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Quota exceeded / private browsing — silently ignore.
  }
}

export function clearLaunchDialogDraft(): void {
  try {
    localStorage.removeItem(LAUNCH_DIALOG_DRAFT_KEY);
  } catch {
    // Ignore.
  }
}
