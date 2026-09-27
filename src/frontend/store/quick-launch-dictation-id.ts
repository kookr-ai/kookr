import { createDictationId } from './dictation-recovery.js';

import { dictationTabId } from './dictation-tab.js';

const BASE_KEY = 'kookr:quickLaunchDictationId';
function key(): string { return `${BASE_KEY}:${dictationTabId()}`; }
let fallback: string | undefined;

/** Closing the quick launcher keeps its input identity; submitting starts a new one. */
export function loadQuickLaunchDictationId(): string {
  if (fallback) return fallback;
  try {
    const saved = localStorage.getItem(key());
    if (saved) return saved;
  } catch { /* Retain the identity in this tab if storage is unavailable. */ }
  return renewQuickLaunchDictationId();
}

export function renewQuickLaunchDictationId(): string {
  const id = createDictationId();
  try {
    localStorage.setItem(key(), id);
    fallback = undefined;
  } catch {
    fallback = id;
  }
  return id;
}

interface QuickDictationDraft { prompt: string; cwd: string; submissionId?: string }
const draftFallback = new Map<string, QuickDictationDraft>();
export function loadQuickDictationDraft(id: string): QuickDictationDraft | null {
  try {
    const raw = localStorage.getItem(`${key()}:draft:${id}`);
    if (!raw) return draftFallback.get(id) ?? null;
    const value = JSON.parse(raw) as QuickDictationDraft;
    return typeof value.prompt === 'string' && typeof value.cwd === 'string' ? value : null;
  } catch { return draftFallback.get(id) ?? null; }
}
export function saveQuickDictationDraft(id: string, draft: QuickDictationDraft): void {
  try { localStorage.setItem(`${key()}:draft:${id}`, JSON.stringify(draft)); draftFallback.delete(id); }
  catch { draftFallback.set(id, draft); }
}
export function clearQuickDictationDraft(id: string): void {
  try { localStorage.removeItem(`${key()}:draft:${id}`); } catch { /* Best effort. */ }
  draftFallback.delete(id);
}
