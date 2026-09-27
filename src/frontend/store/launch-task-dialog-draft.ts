import { dictationTabId } from './dictation-tab.js';

// Storage key value intentionally unchanged ('kookr:launchDialogDraft') so
// in-flight drafts survive the file/symbol rename without a migration step.
export const LAUNCH_TASK_DIALOG_DRAFT_KEY = 'kookr:launchDialogDraft';

export interface LaunchTaskDialogDraft {
  prompt: string;
  cwd: string;
  criteria: string;
  /** Persists the identity of an empty form while provisional speech is recoverable. */
  dictationId?: string;
  submittedCorpusId?: string;
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

function scopedDraftKey(): string { return `${LAUNCH_TASK_DIALOG_DRAFT_KEY}:${dictationTabId()}`; }
function storedDraftKey(): string { return localStorage.getItem(scopedDraftKey()) ? scopedDraftKey() : LAUNCH_TASK_DIALOG_DRAFT_KEY; }

let fallbackDraft: LaunchTaskDialogDraft | null | undefined;

export function loadLaunchTaskDialogDraft(): LaunchTaskDialogDraft | null {
  if (fallbackDraft !== undefined) return fallbackDraft;
  try {
    const raw = localStorage.getItem(storedDraftKey());
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    return {
      prompt: typeof p.prompt === 'string' ? p.prompt : '',
      cwd: typeof p.cwd === 'string' ? p.cwd : '',
      criteria: typeof p.criteria === 'string' ? p.criteria : '',
      ...(typeof p.dictationId === 'string' ? { dictationId: p.dictationId } : {}),
      ...(typeof p.submittedCorpusId === 'string' ? { submittedCorpusId: p.submittedCorpusId } : {}),
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
export function markLaunchTaskDialogDraftSubmitted(now: number = Date.now(), submittedCorpusId?: string): void {
  const draft = loadLaunchTaskDialogDraft();
  if (!draft) return;
  try {
    localStorage.setItem(
      draft.dictationId ? scopedDraftKey() : LAUNCH_TASK_DIALOG_DRAFT_KEY,
      JSON.stringify({ ...draft, submittedAt: now, ...(submittedCorpusId ? { submittedCorpusId } : {}) }),
    );
    fallbackDraft = undefined;
  } catch {
    fallbackDraft = { ...draft, submittedAt: now, ...(submittedCorpusId ? { submittedCorpusId } : {}) };
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
 * Persist typed content and the form's dictation identity. An identity keeps a
 * small empty-form marker so speech recorded before typing returns to the same
 * form after closing or reloading. Without an identity or typed content, remove
 * the draft: the automatically populated working directory alone is not a draft.
 */
export function saveLaunchTaskDialogDraft(draft: LaunchTaskDialogDraft): void {
  if (!draft.prompt.trim() && !draft.criteria.trim() && !draft.dictationId) {
    clearLaunchTaskDialogDraft();
    return;
  }
  try {
    localStorage.setItem(draft.dictationId ? scopedDraftKey() : LAUNCH_TASK_DIALOG_DRAFT_KEY, JSON.stringify(draft));
    fallbackDraft = undefined;
  } catch {
    fallbackDraft = draft;
  }
}

export function clearLaunchTaskDialogDraft(): void {
  try {
    localStorage.removeItem(scopedDraftKey());
    localStorage.removeItem(LAUNCH_TASK_DIALOG_DRAFT_KEY);
    fallbackDraft = undefined;
  } catch {
    fallbackDraft = null;
  }
}

const relaunchFallback = new Map<string, LaunchTaskDialogDraft>();
function relaunchKey(context: string): string { return `${scopedDraftKey()}:relaunch:${context}`; }
/** Relaunch drafts keep their own recording identity without overwriting the manual draft. */
export function loadRelaunchDictationDraft(context: string): LaunchTaskDialogDraft | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(relaunchKey(context)) ?? 'null');
    if (value && typeof value === 'object') {
      const draft = value as Partial<LaunchTaskDialogDraft> & { savedAt?: number };
      if (typeof draft.savedAt === 'number' && Date.now() - draft.savedAt < 7 * 24 * 60 * 60 * 1000
        && typeof draft.prompt === 'string' && typeof draft.criteria === 'string' && typeof draft.cwd === 'string'
        && typeof draft.dictationId === 'string') return draft as LaunchTaskDialogDraft;
    }
    return relaunchFallback.get(context) ?? null;
  } catch { return relaunchFallback.get(context) ?? null; }
}
export function saveRelaunchDictationDraft(context: string, draft: LaunchTaskDialogDraft): void {
  try {
    const prefix = `${scopedDraftKey()}:relaunch:`;
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => Boolean(key?.startsWith(prefix)));
    if (keys.length >= 12 && !keys.includes(relaunchKey(context))) localStorage.removeItem(keys[0]);
    localStorage.setItem(relaunchKey(context), JSON.stringify({ ...draft, savedAt: Date.now() }));
    relaunchFallback.delete(context);
  } catch {
    if (relaunchFallback.size >= 12 && !relaunchFallback.has(context)) relaunchFallback.delete(relaunchFallback.keys().next().value!);
    relaunchFallback.set(context, draft);
  }
}
