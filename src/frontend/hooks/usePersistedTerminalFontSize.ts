import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

export const TERMINAL_FONT_SIZE_STORAGE_KEY = 'kookr:terminal.fontSize';
export const DEFAULT_TERMINAL_FONT_SIZE = 12;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 32;

function clampTerminalFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(value)));
}

function readStoredTerminalFontSize(): number {
  try {
    const raw = localStorage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY);
    if (raw === null) return DEFAULT_TERMINAL_FONT_SIZE;
    return clampTerminalFontSize(Number(raw));
  } catch {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
}

export function usePersistedTerminalFontSize(): [number, Dispatch<SetStateAction<number>>] {
  const [fontSize, setFontSizeState] = useState(readStoredTerminalFontSize);

  const setFontSize = useCallback<Dispatch<SetStateAction<number>>>((nextValue) => {
    setFontSizeState((prev) => {
      const resolved = typeof nextValue === 'function'
        ? (nextValue as (value: number) => number)(prev)
        : nextValue;
      const next = clampTerminalFontSize(resolved);
      try {
        localStorage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, String(next));
      } catch {
        // localStorage may be unavailable; terminal zoom remains usable in-memory.
      }
      return next;
    });
  }, []);

  return [fontSize, setFontSize];
}
