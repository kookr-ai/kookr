import { describe, it, expect } from 'vitest';
import type { Schedule } from './schedule.js';
import { parseExplicitIssuePins, detectDrainedPinRisk } from './batch-selector-pin.js';

/** Minimal Schedule the detector reads (id, name, maxTriggers, playbook). */
function schedule(overrides: {
  id?: string;
  name?: string;
  maxTriggers?: number;
  path?: string;
  issueSelector?: string;
  extraParams?: Record<string, string>;
} = {}): Schedule {
  const parameters: Record<string, string> = { ...(overrides.extraParams ?? {}) };
  if (overrides.issueSelector !== undefined) parameters.issueSelector = overrides.issueSelector;
  return {
    id: overrides.id ?? 'sched-1',
    name: overrides.name ?? 'Kookr parallel issue batch',
    enabled: true,
    cron: '23 2,14 * * *',
    ...(overrides.maxTriggers !== undefined ? { maxTriggers: overrides.maxTriggers } : {}),
    playbook: { path: overrides.path ?? 'parallel-issue-batch.md', parameters },
    cwd: '/home/jean/git/kookr',
  } as Schedule;
}

describe('parseExplicitIssuePins', () => {
  it('parses whitespace-separated numbers (the incident selector)', () => {
    expect(parseExplicitIssuePins('2756 2757 2758')).toEqual([2756, 2757, 2758]);
  });

  it('parses comma-separated and mixed separators, with optional #', () => {
    expect(parseExplicitIssuePins('123, 456')).toEqual([123, 456]);
    expect(parseExplicitIssuePins('#12  #7,#33')).toEqual([7, 12, 33]);
  });

  it('sorts ascending and de-duplicates', () => {
    expect(parseExplicitIssuePins('30 10 10 20')).toEqual([10, 20, 30]);
  });

  it('returns null for a blank / whitespace-only selector (the healthy Lucy config)', () => {
    expect(parseExplicitIssuePins('')).toBeNull();
    expect(parseExplicitIssuePins('   ')).toBeNull();
    expect(parseExplicitIssuePins(undefined)).toBeNull();
  });

  it('returns null for a GitHub search filter (any non-numeric token)', () => {
    expect(parseExplicitIssuePins('label:bug')).toBeNull();
    expect(parseExplicitIssuePins('123 label:bug')).toBeNull();
    expect(parseExplicitIssuePins('is:open')).toBeNull();
  });

  it('returns null for non-positive or non-integer tokens', () => {
    expect(parseExplicitIssuePins('0')).toBeNull();
    expect(parseExplicitIssuePins('12 0')).toBeNull();
    expect(parseExplicitIssuePins('1.5')).toBeNull();
    expect(parseExplicitIssuePins('-4')).toBeNull();
  });
});

describe('detectDrainedPinRisk', () => {
  it('flags the 2026-09-02 Kookr-batch incident config', () => {
    const info = detectDrainedPinRisk(schedule({ issueSelector: '2756 2757 2758' }));
    expect(info).not.toBeNull();
    expect(info).toMatchObject({
      id: 'sched-1',
      name: 'Kookr parallel issue batch',
      issues: [2756, 2757, 2758],
      selector: '2756 2757 2758',
    });
  });

  it('does NOT flag a blank selector (the working Lucy batch)', () => {
    expect(detectDrainedPinRisk(schedule({ issueSelector: '' }))).toBeNull();
    expect(detectDrainedPinRisk(schedule({}))).toBeNull(); // no issueSelector param at all
  });

  it('does NOT flag a search-filter selector', () => {
    expect(detectDrainedPinRisk(schedule({ issueSelector: 'label:idea-scout' }))).toBeNull();
  });

  it('does NOT flag a non-batch playbook even with a numeric selector', () => {
    expect(detectDrainedPinRisk(schedule({ path: 'issue-triage.md', issueSelector: '1 2 3' }))).toBeNull();
  });

  it('flags plugin-tier and extension-less batch playbook ids', () => {
    expect(detectDrainedPinRisk(schedule({ path: 'plugin/playbooks/parallel-issue-batch.md', issueSelector: '9' }))).not.toBeNull();
    expect(detectDrainedPinRisk(schedule({ path: 'parallel-issue-batch', issueSelector: '9' }))).not.toBeNull();
  });

  it('exempts a one-shot pinned batch (maxTriggers === 1)', () => {
    expect(detectDrainedPinRisk(schedule({ issueSelector: '2756 2757 2758', maxTriggers: 1 }))).toBeNull();
  });

  it('still flags a finite but recurring budget (maxTriggers > 1)', () => {
    expect(detectDrainedPinRisk(schedule({ issueSelector: '10 20', maxTriggers: 5 }))).not.toBeNull();
  });

  it('trims the reported selector', () => {
    const info = detectDrainedPinRisk(schedule({ issueSelector: '  42  ' }));
    expect(info?.selector).toBe('42');
    expect(info?.issues).toEqual([42]);
  });
});
