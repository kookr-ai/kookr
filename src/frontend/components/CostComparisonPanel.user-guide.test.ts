import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * Pins the user-guide Cost Comparison section to the live open path
 * (command palette, not a top-bar $ icon). The decisions log still mentions
 * that stale icon; this test is the guard against copying it into the guide.
 */
describe('user-guide Cost Comparison section', () => {
  const userGuide = readFileSync(new URL('../../../docs/user-guide.md', import.meta.url), 'utf8');
  const section = userGuide.split(/^## Cost Comparison$/m)[1]?.split(/^## /m)[0] ?? '';

  test('has a Cost Comparison heading a new operator can find', () => {
    expect(userGuide).toMatch(/^## Cost Comparison$/m);
    expect(section.length).toBeGreaterThan(0);
  });

  test('documents the command-palette open path used by App.tsx and e2e', () => {
    expect(section).toContain('Ctrl+K');
    expect(section).toContain('Cmd+K');
    expect(section).toContain('Cost comparison');
    expect(section).toMatch(/command palette/i);
  });

  test('does not claim a top-bar $ icon', () => {
    expect(section).not.toMatch(/\$\s*icon/i);
    expect(section).not.toMatch(/top-bar/i);
  });
});
