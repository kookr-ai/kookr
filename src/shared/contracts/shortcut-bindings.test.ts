import { describe, expect, test } from 'vitest';
import {
  SHORTCUT_ACTIONS,
  detectShortcutPlatform,
  findShortcutConflicts,
  formatShortcutBinding,
  getDefaultShortcutBindings,
  getFeaturedShortcuts,
  getPhysicalShortcutKey,
  matchesShortcutAction,
  parseShortcutBinding,
  resolveShortcutBindings,
  validateShortcutBindingOverrides,
} from './shortcut-bindings.js';

describe('shortcut bindings', () => {
  test('keeps default platform shortcuts compatible with the existing Alt map', () => {
    const defaults = getDefaultShortcutBindings('default');

    expect(formatShortcutBinding(defaults.next_bottleneck)).toBe('Alt+N');
    expect(formatShortcutBinding(defaults.quick_launch)).toBe('Alt+L');
    expect(formatShortcutBinding(defaults.toggle_terminal_focus)).toBe('Alt+T');
    expect(formatShortcutBinding(defaults.terminal_send_1)).toBe('Alt+1');
    expect(formatShortcutBinding(defaults.select_project_6)).toBe('Alt+9');
    expect(formatShortcutBinding(defaults.toggle_shortcuts_help)).toBe('?');
    expect(formatShortcutBinding(defaults.deselect_task)).toBe('Esc');
  });

  test('provides macOS Cmd+Ctrl defaults for every configurable action', () => {
    const mac = getDefaultShortcutBindings('mac');

    for (const action of SHORTCUT_ACTIONS) {
      expect(mac[action.id]).toBeTruthy();
    }
    expect(formatShortcutBinding(mac.next_bottleneck)).toBe('Cmd+Ctrl+N');
    expect(formatShortcutBinding(mac.quick_launch)).toBe('Cmd+Ctrl+L');
    expect(formatShortcutBinding(mac.complete_task)).toBe('Cmd+Ctrl+Enter');
    expect(formatShortcutBinding(mac.cancel_task)).toBe('Cmd+Ctrl+Backspace');
    expect(formatShortcutBinding(mac.toggle_shortcuts_help)).toBe('?');
    expect(findShortcutConflicts(mac)).toEqual([]);
  });

  test('detects mac platforms without requiring tests to run on macOS', () => {
    expect(detectShortcutPlatform('MacIntel')).toBe('mac');
    expect(detectShortcutPlatform('Linux x86_64')).toBe('default');
  });

  test('featured shortcuts use the active platform defaults', () => {
    const shortcuts = getFeaturedShortcuts('mac');

    expect(shortcuts.find((shortcut) => shortcut.id === 'next_bottleneck')?.keys).toEqual(['Cmd', 'Ctrl', 'N']);
    expect(shortcuts.find((shortcut) => shortcut.id === 'quick_launch')?.keys).toEqual(['Cmd', 'Ctrl', 'L']);
  });

  test('parses aliases and formats canonical bindings', () => {
    expect(formatShortcutBinding(parseShortcutBinding('Command+Control+Return')!)).toBe('Cmd+Ctrl+Enter');
    expect(formatShortcutBinding(parseShortcutBinding('Option+Del')!)).toBe('Alt+Del');
    expect(formatShortcutBinding(parseShortcutBinding('Esc')!)).toBe('Esc');
    expect(parseShortcutBinding('Ctrl+N+K')).toBeNull();
    expect(parseShortcutBinding('N')).toBeNull();
  });

  test('treats Shift+? as conflicting with bare question mark help', () => {
    const result = validateShortcutBindingOverrides({
      mac: {
        quick_launch: 'Shift+?',
      },
    });

    expect(result.overrides.mac).toEqual({});
    expect(result.warnings).toEqual([
      'Shortcut "quick_launch" in mac bindings conflicts with "toggle_shortcuts_help" on Shift+?; ignored',
    ]);
  });

  test('matches macOS shortcuts and shifted question-mark help', () => {
    const mac = getDefaultShortcutBindings('mac');

    expect(matchesShortcutAction({
      key: 'n',
      metaKey: true,
      ctrlKey: true,
    }, mac, 'next_bottleneck')).toBe(true);
    expect(matchesShortcutAction({
      key: '?',
      shiftKey: true,
    }, mac, 'toggle_shortcuts_help')).toBe(true);
    expect(matchesShortcutAction({
      key: 'n',
      altKey: true,
    }, mac, 'next_bottleneck')).toBe(false);
  });

  test('normalizes physical keys for dead-key modifier combinations', () => {
    expect(getPhysicalShortcutKey({ code: 'KeyT', key: '†' })).toBe('t');
    expect(getPhysicalShortcutKey({ code: 'Digit4', key: '¢' })).toBe('4');
    expect(getPhysicalShortcutKey({ code: '', key: 't' })).toBe('t');
  });

  test('validates platform-scoped overrides and rejects conflicts deterministically', () => {
    const result = validateShortcutBindingOverrides({
      mac: {
        next_bottleneck: 'Cmd+Ctrl+Space',
        quick_launch: 'Cmd+Ctrl+Space',
        unknown_action: 'Ctrl+X',
        previous_task: 'Ctrl+N+K',
      },
    });

    expect(result.overrides.mac).toEqual({ next_bottleneck: 'Cmd+Ctrl+Space' });
    expect(result.warnings).toEqual([
      'Shortcut "quick_launch" in mac bindings conflicts with "next_bottleneck" on Cmd+Ctrl+Space; ignored',
      'Unknown shortcut action "unknown_action" in mac bindings was ignored',
      'Shortcut "previous_task" in mac bindings has invalid binding "Ctrl+N+K"; ignored',
    ]);
  });

  test('resolves overrides only for the active platform', () => {
    const resolved = resolveShortcutBindings('mac', {
      default: { next_bottleneck: 'Ctrl+N' },
      mac: { next_bottleneck: 'Cmd+Ctrl+Space' },
    });

    expect(formatShortcutBinding(resolved.next_bottleneck)).toBe('Cmd+Ctrl+Space');
  });
});
