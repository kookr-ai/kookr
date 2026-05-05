import { describe, expect, test } from 'vitest';
import { computeTerminalVisible } from './detail-panel-visibility.js';

describe('computeTerminalVisible', () => {
  test('hidden when rightPane is not terminal', () => {
    expect(computeTerminalVisible({ rightPane: 'diff', isNarrowViewport: false, narrowTab: 'terminal' })).toBe(false);
    expect(computeTerminalVisible({ rightPane: 'diff', isNarrowViewport: true, narrowTab: 'terminal' })).toBe(false);
  });

  test('visible when rightPane is terminal in wide mode regardless of narrowTab', () => {
    expect(computeTerminalVisible({ rightPane: 'terminal', isNarrowViewport: false, narrowTab: 'activity' })).toBe(true);
    expect(computeTerminalVisible({ rightPane: 'terminal', isNarrowViewport: false, narrowTab: 'terminal' })).toBe(true);
  });

  test('in narrow mode, visible only when narrowTab is terminal', () => {
    expect(computeTerminalVisible({ rightPane: 'terminal', isNarrowViewport: true, narrowTab: 'activity' })).toBe(false);
    expect(computeTerminalVisible({ rightPane: 'terminal', isNarrowViewport: true, narrowTab: 'github' })).toBe(false);
    expect(computeTerminalVisible({ rightPane: 'terminal', isNarrowViewport: true, narrowTab: 'terminal' })).toBe(true);
  });
});
