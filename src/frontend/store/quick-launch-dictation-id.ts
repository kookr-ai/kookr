import { createDictationId } from './dictation-recovery.js';

const KEY = 'kookr:quickLaunchDictationId';
let fallback: string | undefined;

/** Closing the quick launcher keeps its input identity; submitting starts a new one. */
export function loadQuickLaunchDictationId(): string {
  if (fallback) return fallback;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved;
  } catch { /* Retain the identity in this tab if storage is unavailable. */ }
  return renewQuickLaunchDictationId();
}

export function renewQuickLaunchDictationId(): string {
  const id = createDictationId();
  try {
    localStorage.setItem(KEY, id);
    fallback = undefined;
  } catch {
    fallback = id;
  }
  return id;
}
