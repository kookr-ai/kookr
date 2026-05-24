import { describe, expect, test } from 'vitest';
import { detectShortcutPlatform, getFeaturedShortcuts, getPhysicalShortcutKey, getShortcutGroups } from './shortcut-bindings.js';

describe('shortcut-bindings', () => {
  test('uses Option labels on macOS', () => {
    const shortcuts = getFeaturedShortcuts('darwin');

    expect(shortcuts.find((shortcut) => shortcut.id === 'next-finding')?.keys).toEqual(['Option', 'N']);
    expect(shortcuts.find((shortcut) => shortcut.id === 'quick-launch')?.keys).toEqual(['Option', 'L']);
  });

  test('keeps Alt labels on Linux and WSL', () => {
    expect(getFeaturedShortcuts('linux').find((shortcut) => shortcut.id === 'next-finding')?.keys).toEqual(['Alt', 'N']);
    expect(getFeaturedShortcuts('wsl2').find((shortcut) => shortcut.id === 'next-finding')?.keys).toEqual(['Alt', 'N']);
  });

  test('detects platform from browser data', () => {
    expect(detectShortcutPlatform({ platform: 'MacIntel', userAgent: 'Mozilla/5.0' })).toBe('darwin');
    expect(detectShortcutPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0' })).toBe('linux');
    expect(detectShortcutPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 WSL' })).toBe('wsl2');
  });

  test('formats non-featured platform-specific bindings', () => {
    const darwinGroups = getShortcutGroups('darwin');
    const linuxGroups = getShortcutGroups('linux');

    expect(darwinGroups.flatMap((group) => group.shortcuts).find((shortcut) => shortcut.id === 'cancel-task')?.keys)
      .toEqual(['Option', 'Delete']);
    expect(linuxGroups.flatMap((group) => group.shortcuts).find((shortcut) => shortcut.id === 'cancel-task')?.keys)
      .toEqual(['Alt', 'Del']);
  });

  test('normalizes Option-modified physical keys on macOS', () => {
    expect(getPhysicalShortcutKey({ code: 'KeyT', key: '†' })).toBe('t');
    expect(getPhysicalShortcutKey({ code: 'Digit4', key: '¢' })).toBe('4');
    expect(getPhysicalShortcutKey({ code: '', key: 't' })).toBe('t');
  });
});
