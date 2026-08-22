import type { QuickAction } from '../../../shared/protocol.js';

/**
 * Same 1–5 cap as the detail-pane number-key shortcuts. The findings rail is
 * 340px wide, so the card must not dump a long permission menu onto one row.
 */
export const FINDING_CARD_QUICK_ACTION_CAP = 5;

/** Permission chips carry a keystroke (the menu digit to send to the terminal). */
export function isPermissionQuickAction(action: QuickAction): boolean {
  return typeof action.keystroke === 'string' && action.keystroke.length > 0;
}

/**
 * Live chips that are safe to render on a finding card.
 *
 * Permission chips without a live `permissionRequest` binding are dropped —
 * the server matches the click to the prompt still on screen, so a chip
 * without that binding must never be sent. Non-permission chips (Yes/No,
 * numbered answers from `extractQuickActions`) pass through. The list is
 * then capped at {@link FINDING_CARD_QUICK_ACTION_CAP}.
 */
export function visibleFindingCardQuickActions(actions: readonly QuickAction[]): QuickAction[] {
  const usable = actions.filter((action) => {
    if (!isPermissionQuickAction(action)) return true;
    return Boolean(action.permissionRequest);
  });
  return usable.slice(0, FINDING_CARD_QUICK_ACTION_CAP);
}
