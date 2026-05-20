import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

interface UseDialogFocusOptions {
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function useDialogFocus({ dialogRef, initialFocusRef }: UseDialogFocusOptions) {
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? null;
    (initialFocusRef?.current ?? firstFocusable ?? dialog)?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const currentDialog = dialogRef.current;
      if (!currentDialog) return;

      const focusable = Array.from(
        currentDialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      const first = focusable[0] ?? currentDialog;
      const last = focusable[focusable.length - 1] ?? currentDialog;

      if (!currentDialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      previousFocus?.focus();
    };
  }, [dialogRef, initialFocusRef]);
}
