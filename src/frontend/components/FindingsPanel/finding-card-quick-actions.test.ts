import { describe, expect, test } from 'vitest';
import type { PermissionRequestBinding, QuickAction } from '../../../shared/protocol.js';
import {
  FINDING_CARD_QUICK_ACTION_CAP,
  isPermissionQuickAction,
  visibleFindingCardQuickActions,
} from './finding-card-quick-actions.js';

const permissionRequest: PermissionRequestBinding = {
  requestId: 'request-1',
  toolName: 'Bash',
  toolInputHash: 'hash-1',
  detectedAt: '2026-05-15T19:00:00.000Z',
  ttlMs: 300000,
};

function permissionChip(overrides: Partial<QuickAction> = {}): QuickAction {
  return {
    label: 'Allow: Bash: `git status`',
    value: 'Yes',
    keystroke: '1',
    permissionRequest,
    ...overrides,
  };
}

describe('visibleFindingCardQuickActions', () => {
  test('keeps Yes/No chips from extractQuickActions', () => {
    const actions: QuickAction[] = [
      { label: 'Yes', value: 'yes', shortcut: 'y' },
      { label: 'No', value: 'no', shortcut: 'n' },
    ];
    expect(visibleFindingCardQuickActions(actions)).toEqual(actions);
    expect(actions.every((action) => !isPermissionQuickAction(action))).toBe(true);
  });

  test('keeps permission chips that carry the live permissionRequest binding', () => {
    const allow = permissionChip();
    const deny = permissionChip({
      label: 'Deny',
      value: 'No',
      keystroke: '2',
    });
    expect(visibleFindingCardQuickActions([allow, deny])).toEqual([allow, deny]);
    expect(isPermissionQuickAction(allow)).toBe(true);
  });

  test('drops permission chips that lack permissionRequest so they cannot be sent', () => {
    const bound = permissionChip();
    const unbound: QuickAction = {
      label: 'Allow: Bash: `rm -rf /`',
      value: 'Yes',
      keystroke: '1',
    };
    expect(visibleFindingCardQuickActions([unbound, bound])).toEqual([bound]);
  });

  test(`caps the list at ${FINDING_CARD_QUICK_ACTION_CAP} chips`, () => {
    const actions = Array.from({ length: FINDING_CARD_QUICK_ACTION_CAP + 2 }, (_, i) => ({
      label: `Option ${i + 1}`,
      value: String(i + 1),
    }));
    const visible = visibleFindingCardQuickActions(actions);
    expect(visible).toHaveLength(FINDING_CARD_QUICK_ACTION_CAP);
    expect(visible.map((action) => action.value)).toEqual(['1', '2', '3', '4', '5']);
  });

  test('returns an empty list when there are no suggestions', () => {
    expect(visibleFindingCardQuickActions([])).toEqual([]);
  });
});
