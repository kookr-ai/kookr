export type STTLanguage = 'auto' | 'fr' | 'en';

export const STT_LANGUAGE_KEY = 'kookr:sttLanguage';

export function isSTTLanguage(value: unknown): value is STTLanguage {
  return value === 'auto' || value === 'fr' || value === 'en';
}

export function loadSTTLanguage(): STTLanguage {
  try {
    const value = localStorage.getItem(STT_LANGUAGE_KEY);
    return isSTTLanguage(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveSTTLanguage(language: STTLanguage): void {
  try {
    localStorage.setItem(STT_LANGUAGE_KEY, language);
  } catch {
    // Dictation remains available when browser storage is unavailable.
  }
}
