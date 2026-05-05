import { useEffect, useRef } from 'react';

/**
 * Registers a window-level capture-phase keydown listener for Escape.
 * Calls `onClose` and stops propagation so the global App.tsx Escape
 * handler (bubble phase) never fires while a dialog is open.
 */
export function useEscapeToClose(onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        ref.current();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);
}
