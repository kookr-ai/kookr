import { describe, expect, test } from 'vitest';
import { computeTerminalVisible, resolveDetailPaneLayout } from './detail-panel-visibility.js';

describe('computeTerminalVisible', () => {
  test('hidden when rightPane is not terminal, in every layout', () => {
    for (const layout of ['tabs', 'split', 'focus'] as const) {
      expect(computeTerminalVisible({ rightPane: 'diff', layout, activeTab: 'terminal' })).toBe(false);
    }
  });

  test('split view and terminal focus show the terminal whatever tab is active', () => {
    expect(computeTerminalVisible({ rightPane: 'terminal', layout: 'split', activeTab: 'activity' })).toBe(true);
    expect(computeTerminalVisible({ rightPane: 'terminal', layout: 'focus', activeTab: 'activity' })).toBe(true);
    expect(computeTerminalVisible({ rightPane: 'terminal', layout: 'split', activeTab: 'terminal' })).toBe(true);
  });

  test('the tabbed layout shows the terminal only on the Terminal tab', () => {
    expect(computeTerminalVisible({ rightPane: 'terminal', layout: 'tabs', activeTab: 'activity' })).toBe(false);
    expect(computeTerminalVisible({ rightPane: 'terminal', layout: 'tabs', activeTab: 'github' })).toBe(false);
    expect(computeTerminalVisible({ rightPane: 'terminal', layout: 'tabs', activeTab: 'terminal' })).toBe(true);
  });
});

describe('resolveDetailPaneLayout', () => {
  test('wide windows honour the stored mode', () => {
    expect(resolveDetailPaneLayout({ requestedMode: 'tabs', wideDetailActive: true, panesVisible: true })).toBe('tabs');
    expect(resolveDetailPaneLayout({ requestedMode: 'split', wideDetailActive: true, panesVisible: true })).toBe('split');
    expect(resolveDetailPaneLayout({ requestedMode: 'right', wideDetailActive: true, panesVisible: true })).toBe('focus');
  });

  test('narrow windows and completion digests always use tabs', () => {
    for (const requestedMode of ['tabs', 'split', 'right'] as const) {
      expect(resolveDetailPaneLayout({ requestedMode, wideDetailActive: false, panesVisible: true })).toBe('tabs');
      expect(resolveDetailPaneLayout({ requestedMode, wideDetailActive: true, panesVisible: false })).toBe('tabs');
    }
  });
});
