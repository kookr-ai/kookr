import { describe, expect, test } from 'vitest';
import {
  findingFingerprint,
  findingLineageKey,
  findingsAreEquivalent,
  isMaterialChange,
  normalizeFindingContext,
} from './finding-fingerprint.js';
import type { Anomaly } from './types.js';

const FIXED_TIME = new Date('2026-01-01T00:00:00Z');

function anomaly(overrides: Partial<Anomaly> & Pick<Anomaly, 'type' | 'explanation'>): Anomaly {
  return {
    agentId: 'agent-1',
    type: overrides.type,
    severity: 'info',
    explanation: overrides.explanation,
    detectedAt: FIXED_TIME,
    ...overrides,
  };
}

function needsInput(message: string, overrides: Partial<Anomaly> = {}): Anomaly {
  return anomaly({
    type: 'needs_input',
    subType: 'stop',
    explanation: `Agent is waiting for input. Last message: "${message}"`,
    ...overrides,
  });
}

describe('normalizeFindingContext', () => {
  test('collapses whitespace, quotes, casing and trailing punctuation', () => {
    expect(normalizeFindingContext('  Deploy the  API now?? ')).toBe('deploy the api now');
    expect(normalizeFindingContext('“Deploy the API now”')).toBe('deploy the api now');
    expect(normalizeFindingContext("Deploy the API now.")).toBe('deploy the api now');
  });

  test('keeps distinct questions distinct', () => {
    expect(normalizeFindingContext('Deploy to prod?')).not.toBe(
      normalizeFindingContext('Deploy to staging?'),
    );
  });
});

describe('findingFingerprint', () => {
  test('is stable across superficial question drift', () => {
    const a = needsInput('Should I deploy to prod?');
    const b = needsInput('should i deploy to prod'); // casing + punctuation drift
    const c = needsInput('Should I   deploy to prod?  '); // whitespace drift
    expect(findingFingerprint(b, { taskId: 't1' })).toBe(findingFingerprint(a, { taskId: 't1' }));
    expect(findingFingerprint(c, { taskId: 't1' })).toBe(findingFingerprint(a, { taskId: 't1' }));
  });

  test('is stable across volatile agentId when keyed by task', () => {
    const first = needsInput('Should I deploy?', { agentId: 'session-a' });
    const second = needsInput('Should I deploy?', { agentId: 'session-b' });
    expect(findingFingerprint(second, { taskId: 't1' })).toBe(findingFingerprint(first, { taskId: 't1' }));
  });

  test('changes when the question materially changes', () => {
    const before = needsInput('Should I deploy to prod?');
    const after = needsInput('Should I roll back the migration?');
    expect(isMaterialChange(
      findingFingerprint(before, { taskId: 't1' }),
      findingFingerprint(after, { taskId: 't1' }),
    )).toBe(true);
  });

  test('changes when stateVersion changes even if the text is identical', () => {
    const q = needsInput('Should I deploy?');
    const v1 = findingFingerprint(q, { taskId: 't1', stateVersion: 1 });
    const v2 = findingFingerprint(q, { taskId: 't1', stateVersion: 2 });
    expect(isMaterialChange(v1, v2)).toBe(true);
  });

  test('differs by task and by anomaly type', () => {
    const q = needsInput('Should I deploy?');
    expect(findingFingerprint(q, { taskId: 't1' })).not.toBe(findingFingerprint(q, { taskId: 't2' }));

    const permission = anomaly({
      type: 'permission_blocked',
      explanation: 'Agent is waiting for input. Last message: "Should I deploy?"',
    });
    expect(findingFingerprint(permission, { taskId: 't1' })).not.toBe(findingFingerprint(q, { taskId: 't1' }));
  });

  test('falls back to agentId when no task is known', () => {
    const orphan1 = needsInput('Should I deploy?', { agentId: 'orphan-1' });
    const orphan2 = needsInput('Should I deploy?', { agentId: 'orphan-2' });
    expect(findingFingerprint(orphan1)).toContain('orphan-1');
    // Without a task, distinct agents are distinct lineages...
    expect(findingsAreEquivalent(findingFingerprint(orphan1), findingFingerprint(orphan2))).toBe(false);
    // ...but a blank taskId is treated as "no task" and falls back to the agent.
    expect(findingFingerprint(orphan1, { taskId: '  ' })).toBe(findingFingerprint(orphan1));
  });
});

describe('findingLineageKey', () => {
  test('groups a task+type lineage regardless of question or sub-type', () => {
    const stop = needsInput('Should I deploy?', { subType: 'stop' });
    const ask = anomaly({
      type: 'needs_input',
      subType: 'ask_user_question',
      explanation: 'Agent is asking a question via AskUserQuestion tool',
    });
    expect(findingLineageKey(ask, { taskId: 't1' })).toBe(findingLineageKey(stop, { taskId: 't1' }));
  });

  test('separates lineages by task and anomaly type', () => {
    const q = needsInput('Should I deploy?');
    expect(findingLineageKey(q, { taskId: 't1' })).not.toBe(findingLineageKey(q, { taskId: 't2' }));
  });
});
