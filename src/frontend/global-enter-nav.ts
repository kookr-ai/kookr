/**
 * Decide whether a bare Enter keypress that bubbled to the window (i.e. was not
 * consumed by a focused composer) should advance to the next task.
 *
 * Returns false when the user is interacting with a control or when a dialog
 * owns the keyboard, so native Enter activation (buttons/links) and modal
 * confirmation are preserved. Kept free of React/DOM-event types and exported
 * so the guard can be unit-tested against a jsdom document without rendering
 * the whole App.
 */
export function globalEnterShouldNavigate(activeEl: Element | null): boolean {
  const tag = activeEl?.tagName;
  const role = activeEl?.getAttribute('role');
  // Check both the live `isContentEditable` property (correct in real browsers,
  // covers inherited editability) and the attribute (jsdom doesn't implement the
  // property, and `contenteditable=""` means true).
  const ce = activeEl?.getAttribute('contenteditable');
  const isEditable =
    (activeEl instanceof HTMLElement && activeEl.isContentEditable)
    || ce === '' || ce === 'true' || ce === 'plaintext-only';
  const isInteractive =
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || tag === 'BUTTON' || tag === 'A'
    || isEditable
    || role === 'button' || role === 'menuitem' || role === 'tab';
  if (isInteractive) return false;

  // Any open dialog owns Enter (confirmation), so navigation must not fire
  // beneath it. Match every modal signal the codebase uses: aria-modal /
  // role=dialog cover dialogs whose backdrop class is not `.dialog-overlay`
  // (e.g. SweepButton, TaskDependencyEditor) — a `.dialog-overlay`-only check
  // would miss those and navigate the dashboard under the open modal.
  const dialogOpen =
    typeof document !== 'undefined'
    && document.querySelector('[aria-modal="true"], [role="dialog"], .dialog-overlay') !== null;
  return !dialogOpen;
}
