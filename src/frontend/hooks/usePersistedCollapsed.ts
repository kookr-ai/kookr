import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * localStorage-backed boolean for collapsible UI sections.
 * Stored as '1' (collapsed) / '0' (expanded). Any other value falls back to
 * `defaultCollapsed` so a partially-written or future-format value never
 * forces the wrong visual state.
 *
 * Returns `[collapsed, toggle, expand]`. `expand` is an explicit "make this
 * section visible" setter (persisted like a manual toggle) used by
 * auto-expand behaviors such as {@link useAutoExpandOnItemGain}; it is a
 * no-op (no state churn, no storage write) when already expanded.
 */
export function usePersistedCollapsed(
  key: string,
  defaultCollapsed: boolean,
): [boolean, () => void, () => void] {
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

  const expand = useCallback(() => {
    setCollapsed((prev) => {
      if (!prev) return prev;
      try {
        localStorage.setItem(key, '0');
      } catch {
        // localStorage may be unavailable (private mode, quota); preference is best-effort.
      }
      return false;
    });
  }, [key]);

  return [collapsed, toggle, expand];
}

/**
 * Auto-expand a collapsible section whenever it GAINS items, so something
 * newly waiting on the user is never hidden inside a collapsed group (F19).
 *
 * Fires `expand` only when `count` increases versus the previous render.
 * The first render establishes the baseline WITHOUT expanding: a persisted
 * collapsed preference survives reloads (items already present at mount are
 * not "new arrivals"), and only post-mount gains pop the section open. A
 * manual re-collapse likewise sticks until the next new arrival.
 */
export function useAutoExpandOnItemGain(count: number, expand: () => void): void {
  const prevCount = useRef<number | null>(null);
  useEffect(() => {
    if (prevCount.current !== null && count > prevCount.current) {
      expand();
    }
    prevCount.current = count;
  }, [count, expand]);
}
