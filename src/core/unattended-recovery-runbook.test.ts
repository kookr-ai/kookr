import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Drift guard for issue #2642 / #2635: after a restart the hourly safety-net
 * loops stay dark for the deferred startup delay (~60s), not a full interval.
 * The unattended recovery runbook must name that window so a remote operator
 * does not treat empty last-fired stamps as a dead loop — or ignore a truly
 * dead loop because "it always looks like that."
 */
const runbookPath = join(
  import.meta.dirname,
  '..',
  '..',
  'docs',
  'reference',
  'unattended-recovery-runbook.md',
);

describe('unattended recovery runbook hourly-timer boot window (issue #2642)', () => {
  const doc = readFileSync(runbookPath, 'utf-8');

  test('names the four hourly safety-net loops and the timer-health last-fired surface', () => {
    expect(doc).toContain('## 7. Hourly-timer boot window');
    expect(doc).toMatch(/smoke/i);
    expect(doc).toMatch(/prune/i);
    expect(doc).toMatch(/deploy-lag/i);
    expect(doc).toMatch(/deploy-convergence/i);
    expect(doc).toContain('prodSmokeTick');
    expect(doc).toContain('maintenancePrune');
    expect(doc).toContain('deployLagDetector');
    expect(doc).toContain('deployConvergence');
    expect(doc).toContain('GET /api/diagnostics/timer-health');
    expect(doc).toMatch(/lastFiredAt|last-fired/);
  });

  test('tells the operator not to treat never-fired as dead until the startup fire has had time to stamp', () => {
    expect(doc.toLowerCase()).toMatch(/never-fired|never fired/);
    expect(doc.toLowerCase()).toMatch(/60s|60 seconds|about a minute/);
    expect(doc).toMatch(/overdue/);
    expect(doc.toLowerCase()).toMatch(/two expected intervals|two intervals/);
  });

  test('published text has no local home-directory paths', () => {
    expect(doc).not.toMatch(/\/home\/[^\s]+/);
    expect(doc).not.toMatch(/\/Users\/[^\s]+/);
  });
});
