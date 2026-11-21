import { useEffect, type RefObject } from 'react';

/**
 * Close a popover on Escape (returning focus to its trigger) or on a pointer
 * press outside both the popover and its trigger. Active only while `open`.
 */
export function usePopoverDismiss(
  open: boolean,
  onClose: () => void,
  popoverRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus();
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open, onClose, popoverRef, triggerRef]);
}
