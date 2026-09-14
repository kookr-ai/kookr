import { describe, expect, test } from 'vitest';
import { buildResourceWatchdogPrompt } from './resource-watchdog-prompt.js';
import type { ResourceWatchdogRssCoverage, ResourceWatchdogSample } from './resource-watchdog-types.js';

const sample: ResourceWatchdogSample = {
  sampledAt: '2026-07-31T12:00:00.000Z',
  swapUsedPercent: 80,
  memAvailableMb: 200,
  oomKillTotal: 2,
  processCounts: { claude: 41, grok: 0, codex: 0, dtach: 0 },
  orphanSessionCount: 0,
  terminalLeakCount: 0,
  topConsumers: [],
};

const cases: { name: string; coverage?: ResourceWatchdogRssCoverage; statement: string }[] = [
  { name: 'legacy sample', statement: 'unknown (metadata unavailable)' },
  { name: 'failed enumeration', coverage: { eligibleProcesses: null, attemptedReads: 0, successfulReads: 0, truncated: false }, statement: 'unavailable (process enumeration failed)' },
  { name: 'empty eligible set', coverage: { eligibleProcesses: 0, attemptedReads: 0, successfulReads: 0, truncated: false }, statement: 'complete for eligible processes in the enumerated table' },
  { name: 'zero RSS measurement', coverage: { eligibleProcesses: 1, attemptedReads: 1, successfulReads: 1, truncated: false }, statement: 'complete for eligible processes in the enumerated table' },
  { name: 'unavailable RSS', coverage: { eligibleProcesses: 1, attemptedReads: 1, successfulReads: 0, truncated: false }, statement: 'partial; unread or skipped eligible processes may include larger consumers' },
  { name: 'capped prefix', coverage: { eligibleProcesses: 41, attemptedReads: 40, successfulReads: 40, truncated: true }, statement: 'partial; unread or skipped eligible processes may include larger consumers' },
];

describe.each(['investigation', 'meta_reflection'] as const)('%s RSS coverage', (kind) => {
  test.each(cases)('explains $name even with no consumers displayed', ({ coverage, statement }) => {
    const prompt = buildResourceWatchdogPrompt({
      kind, sample: { ...sample, ...(coverage ? { rssCoverage: coverage } : {}) },
      triggers: [], spawnsInWindow: 0, spawnBudget24h: 4,
    });
    expect(prompt).toContain(`RSS sample coverage: ${statement}.`);
    expect(prompt).toContain('RSS scope: agent-family and dtach processes only');
    if (coverage) expect(prompt).toContain(`rssCoverage: ${JSON.stringify(coverage)}`);
    if (!statement.startsWith('complete')) expect(prompt).not.toContain('RSS sample coverage: complete');
  });
});
