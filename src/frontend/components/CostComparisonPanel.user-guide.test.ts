import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * Pins the user-guide Cost Comparison section to the live open paths
 * (command palette, the 24-hour and all-time spend figures in the navigation
 * footer and the System detail's Usage section, overview live spend). The
 * status bar and the top-bar spend figure are gone (#3561 slice 5b). The decisions log still mentions a stale top-bar
 * `$` icon; that icon is gone — this test guards against copying it back.
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

  test('documents the 24-hour and all-time spend figures as open paths (issues #3335, #3398)', () => {
    expect(section).toMatch(/either spend figure \(rolling 24 hours, or all time\)/i);
    expect(section).toMatch(/navigation footer/i);
    expect(section).toMatch(/\*\*Usage\*\* section of the \*\*System\*\* detail/i);
  });

  test('no longer points at the removed status bar or top-bar spend figure (#3561 slice 5b)', () => {
    expect(section).not.toMatch(/status bar/i);
    expect(section).not.toMatch(/top-bar all-time spend/i);
  });

  test('documents that a live Tasks-row name opens the dashboard task (issue #3331)', () => {
    expect(section).toMatch(/name is a button/i);
    expect(section).toMatch(/closes Cost Comparison/i);
    expect(section).toMatch(/Historical rows stay plain text/i);
  });

  test('does not claim a top-bar $ icon', () => {
    // Matches "$ icon", "`$` icon", and "'$' icon" so the retired
    // decisions-log phrasing cannot sneak into the guide.
    expect(section).not.toMatch(/\$[`'\s]*icon/i);
  });
});
