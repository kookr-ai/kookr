import { describe, expect, it } from 'vitest';
import {
  formatOpenCodePaneExcerpt,
  isOpenCodeBusyOrResponding,
  isOpenCodeComposerReady,
} from './opencode-readiness.js';

describe('opencode readiness probes', () => {
  it('detects the idle composer by placeholder or footer', () => {
    expect(isOpenCodeComposerReady('\x1b[2m Ask anything… \x1b[0m')).toBe(true);
    expect(isOpenCodeComposerReady('footer ctrl+p commands')).toBe(true);
    expect(isOpenCodeComposerReady('Loading…')).toBe(false);
  });

  it('detects a running turn', () => {
    expect(isOpenCodeBusyOrResponding('⠋ working  esc interrupt')).toBe(true);
    expect(isOpenCodeBusyOrResponding('Ask anything…  ctrl+p commands')).toBe(false);
  });

  it('bounds the excerpt', () => {
    const out = formatOpenCodePaneExcerpt('x'.repeat(1000), 50);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.startsWith('…')).toBe(true);
  });
});
