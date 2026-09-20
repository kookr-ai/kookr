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

/**
 * Drift guard for issue #3255: assumed-submitted prompt-ack lives on the
 * per-session `promptDelivery` record (#2792). Overnight Grok launches that
 * never hook-confirm look like healthy workers unless the runbook names that
 * field. There is no process-wide health gauge for this — do not invent one.
 */
describe('unattended recovery runbook assumed-submitted prompt-ack (issue #3255)', () => {
  const doc = readFileSync(runbookPath, 'utf-8');

  test('matrix names assumed-submitted / prompt-ack against the per-session field', () => {
    expect(doc).toMatch(/prompt-ack/);
    expect(doc).toContain('assumed-submitted');
    expect(doc).toContain('sessions[].promptDelivery');
    expect(doc).toContain('GET /api/tasks');
    expect(doc).toContain('## 8. Assumed-submitted prompt-ack');
  });

  test('does not invent a fleet health alias that does not exist', () => {
    expect(doc).toMatch(/not.*\/api\/health.*gauge/i);
    expect(doc).toContain('submit-assumed-after-timeout');
    expect(doc.toLowerCase()).toMatch(/do \*\*not\*\* treat as confirmed delivery/);
    expect(doc).not.toMatch(/GET \/api\/health[^.\n]*promptDelivery/);
    expect(doc).not.toMatch(/health\.promptDelivery/);
    expect(doc).not.toMatch(/promptAckDrought|promptDeliveryGauge|fleetPromptAck/);
  });
});

describe('unattended recovery runbook paste-readiness timeout (issue #3310)', () => {
  const doc = readFileSync(runbookPath, 'utf-8');

  test('names paste_readiness_timeout on launch-outcomes, not health', () => {
    expect(doc).toContain('paste_readiness_timeout');
    expect(doc).toContain('GET /api/diagnostics/launch-outcomes');
    expect(doc).not.toMatch(/GET \/api\/health[^.\n]*promptAck/);
    expect(doc).not.toMatch(/health\.promptAck/);
  });
});

/**
 * Drift guard for issue #3308: GET /api/health always sets top-level
 * `status: "ok"`, so a Discord operator can report the instance healthy
 * while `terminalBackend.status=degraded` (`session-gone`) is already
 * in the same payload. The runbook must name that pairing.
 */
describe('unattended recovery runbook terminalBackend degraded while health ok (issue #3308)', () => {
  const doc = readFileSync(runbookPath, 'utf-8');

  test('names terminalBackend.status=degraded as a Lucy-visible symptom while health.status stays ok', () => {
    expect(doc).toContain('terminalBackend.status=degraded');
    expect(doc).toMatch(/Lucy/i);
    expect(doc).toMatch(/health\.status[`']?\s+stays [`'`]?ok[`'`]?/i);
  });

  test('prints terminalBackend.status and lastError.kind using stable kind names', () => {
    expect(doc).toContain('lastError.kind');
    expect(doc).toContain('terminalBackend.status');
    expect(doc).toContain('session-gone');
    expect(doc).toContain('session-attach-failed');
    expect(doc).toContain('write-timed-out');
  });
});
