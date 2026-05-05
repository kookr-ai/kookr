import { useCallback, useState } from 'react';

/**
 * localStorage-backed boolean for collapsible UI sections.
 * Stored as '1' (collapsed) / '0' (expanded). Any other value falls back to
 * `defaultCollapsed` so a partially-written or future-format value never
 * forces the wrong visual state.
 */
export function usePersistedCollapsed(
  key: string,
  defaultCollapsed: boolean,
): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === '1') return true;
      if (raw === '0') return false;
      return defaultCollapsed;
    } catch {
      return defaultCollapsed;
    }
  });

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(key, next ? '1' : '0');
      } catch {
        // localStorage may be unavailable (private mode, quota); preference is best-effort.
      }
      return next;
    });
  }, [key]);

  return [collapsed, toggle];
}
