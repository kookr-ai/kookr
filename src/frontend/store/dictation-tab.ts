import { createDictationId } from './dictation-recovery.js';

let tabId: string | undefined;
/** A copied tab starts its own draft; reload and history navigation retain ownership. */
export function dictationTabId(): string {
  if (tabId) return tabId;
  const key = 'kookr:dictationTab:v1';
  try {
    const previous = sessionStorage.getItem(key);
    const navigation = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
    tabId = previous && navigation?.type !== 'navigate' ? previous : createDictationId();
    sessionStorage.setItem(key, tabId);
  } catch { tabId = createDictationId(); }
  return tabId;
}
