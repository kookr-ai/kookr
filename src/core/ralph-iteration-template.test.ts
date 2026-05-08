import { describe, expect, it } from 'vitest';
import { renderIterationPrompt, type IterationTemplateContext } from './ralph-iteration-template.js';
import type { BurnedOutTarget } from './tasks.js';
import type { RalphIterationRecord } from '../shared/contracts/ralph-iteration-log.js';

const baseCtx = (overrides: Partial<IterationTemplateContext> = {}): IterationTemplateContext => ({
  iteration: 3,
  cumulativeIterations: 5,
  burnedOutTargets: undefined,
  recentRecords: undefined,
  ...overrides,
});

const burnedTarget = (overrides: Partial<BurnedOutTarget> = {}): BurnedOutTarget => ({
  target: '154',
  consecutiveStallCount: 2,
  totalStallCount: 2,
  firstStalledAtIteration: 1,
  lastStallReason: 'tests fail to compile',
  lastStallBlockers: [],
  burned: true,
  lastAttemptedIteration: 2,
  ...overrides,
});

const verdictRecord = (n: number, fields: Partial<RalphIterationRecord> = {}): RalphIterationRecord => ({
  iterationNumber: n,
  startedAt: 1_700_000_000_000 + n * 1000,
  endedAt: 1_700_000_005_000 + n * 1000,
  exitReason: 'continued',
  cumulativeCostUsd: null,
  gitBaselineRef: null,
  diffStats: null,
  ...fields,
});

describe('renderIterationPrompt — opt-in', () => {
  it('returns the prompt unchanged when no {{ralph.*}} marker is present', () => {
    const prompt = 'Read prompt.md. Continue. The string {{paramName}} is not a ralph token.';
    expect(renderIterationPrompt(prompt, baseCtx())).toBe(prompt);
  });

  it('does not rewrite a literal "{{ralph}}" without dot-token suffix', () => {
    // Defends against accidental matches on operator prose that happens to
    // mention ralph. The regex requires `{{ralph.<word>}}`.
    const prompt = 'See {{ralph}} for context.';
    expect(renderIterationPrompt(prompt, baseCtx())).toBe(prompt);
  });
});

describe('renderIterationPrompt — substitutions', () => {
  it('substitutes iteration and cumulativeIterations', () => {
    const out = renderIterationPrompt(
      'iter={{ralph.iteration}} cum={{ralph.cumulativeIterations}}',
      baseCtx({ iteration: 7, cumulativeIterations: 12 }),
    );
    expect(out).toBe('iter=7 cum=12');
  });

  it('repeats substitution for the same token', () => {
    const out = renderIterationPrompt(
      '{{ralph.iteration}} {{ralph.iteration}} {{ralph.iteration}}',
      baseCtx({ iteration: 4 }),
    );
    expect(out).toBe('4 4 4');
  });
});

describe('renderIterationPrompt — burnedOutTargets', () => {
  it('formats an empty list as (none) so prose reads naturally', () => {
    const out = renderIterationPrompt(
      'Burned: {{ralph.burnedOutTargets}}',
      baseCtx({ burnedOutTargets: undefined }),
    );
    expect(out).toBe('Burned: (none)');
  });

  it('formats burned targets as comma-separated', () => {
    const out = renderIterationPrompt(
      'Burned: {{ralph.burnedOutTargets}}',
      baseCtx({
        burnedOutTargets: [
          burnedTarget({ target: '154' }),
          burnedTarget({ target: '162' }),
        ],
      }),
    );
    expect(out).toBe('Burned: 154, 162');
  });

  it('hides pre-burn (consecutiveStallCount=1) rows from the burned list', () => {
    // Pre-burn rows exist on RalphLoopState (tracking) but should not appear
    // in the agent's "do not pick" list. Only `burned: true` rows surface.
    const out = renderIterationPrompt(
      'Burned: {{ralph.burnedOutTargets}}',
      baseCtx({
        burnedOutTargets: [
          burnedTarget({ target: '154', burned: true }),
          burnedTarget({ target: '155', burned: false, consecutiveStallCount: 1 }),
        ],
      }),
    );
    expect(out).toBe('Burned: 154');
  });

  it('formats an all-pre-burn list as (none)', () => {
    const out = renderIterationPrompt(
      'Burned: {{ralph.burnedOutTargets}}',
      baseCtx({
        burnedOutTargets: [
          burnedTarget({ burned: false, consecutiveStallCount: 1 }),
        ],
      }),
    );
    expect(out).toBe('Burned: (none)');
  });
});

describe('renderIterationPrompt — lastStallReason', () => {
  it('returns empty string when no targets', () => {
    const out = renderIterationPrompt('Reason: {{ralph.lastStallReason}}', baseCtx());
    expect(out).toBe('Reason: ');
  });

  it('returns the most recent stall reason by lastAttemptedIteration', () => {
    const out = renderIterationPrompt(
      'Reason: {{ralph.lastStallReason}}',
      baseCtx({
        burnedOutTargets: [
          burnedTarget({ target: '154', lastStallReason: 'older', lastAttemptedIteration: 1 }),
          burnedTarget({ target: '155', lastStallReason: 'newer', lastAttemptedIteration: 4 }),
          burnedTarget({ target: '156', lastStallReason: 'middle', lastAttemptedIteration: 2 }),
        ],
      }),
    );
    expect(out).toBe('Reason: newer');
  });
});

describe('renderIterationPrompt — recentVerdicts', () => {
  it('returns empty string when no records', () => {
    const out = renderIterationPrompt('Recent: {{ralph.recentVerdicts}}', baseCtx());
    expect(out).toBe('Recent: ');
  });

  it('returns empty string when records have no verdicts', () => {
    const out = renderIterationPrompt(
      'Recent: {{ralph.recentVerdicts}}',
      baseCtx({ recentRecords: [verdictRecord(1), verdictRecord(2)] }),
    );
    expect(out).toBe('Recent: ');
  });

  it('formats a stalled verdict with target', () => {
    const out = renderIterationPrompt(
      '{{ralph.recentVerdicts}}',
      baseCtx({
        recentRecords: [
          verdictRecord(3, {
            verdict: { verdict: 'stalled', iteration: 3, target: '154', reason: 'fails' },
          }),
        ],
      }),
    );
    expect(out).toBe('iter 3: stalled (target=154)');
  });

  it('joins multiple verdicts in iteration order with semicolons', () => {
    const out = renderIterationPrompt(
      '{{ralph.recentVerdicts}}',
      baseCtx({
        recentRecords: [
          verdictRecord(1, { verdict: { verdict: 'progress', iteration: 1, target: '149' } }),
          verdictRecord(2, { verdict: { verdict: 'stalled', iteration: 2, target: '154', reason: 'x' } }),
          verdictRecord(3, { verdict: { verdict: 'progress', iteration: 3, target: '153' } }),
        ],
      }),
    );
    expect(out).toBe('iter 1: progress (target=149); iter 2: stalled (target=154); iter 3: progress (target=153)');
  });

  it('caps at the last 5 verdicted records (skipping non-verdicted ones)', () => {
    const records: RalphIterationRecord[] = [];
    for (let i = 1; i <= 10; i++) {
      records.push(verdictRecord(i, {
        verdict: { verdict: 'progress', iteration: i, target: `t${i}` },
      }));
    }
    const out = renderIterationPrompt('{{ralph.recentVerdicts}}', baseCtx({ recentRecords: records }));
    // Last 5: iters 6, 7, 8, 9, 10
    expect(out).toBe('iter 6: progress (target=t6); iter 7: progress (target=t7); iter 8: progress (target=t8); iter 9: progress (target=t9); iter 10: progress (target=t10)');
  });

  it('skips non-verdicted records when collecting the last 5', () => {
    const records: RalphIterationRecord[] = [
      verdictRecord(1, { verdict: { verdict: 'progress', iteration: 1, target: 'a' } }),
      verdictRecord(2),
      verdictRecord(3, { verdict: { verdict: 'progress', iteration: 3, target: 'c' } }),
      verdictRecord(4),
      verdictRecord(5, { verdict: { verdict: 'progress', iteration: 5, target: 'e' } }),
    ];
    const out = renderIterationPrompt('{{ralph.recentVerdicts}}', baseCtx({ recentRecords: records }));
    expect(out).toBe('iter 1: progress (target=a); iter 3: progress (target=c); iter 5: progress (target=e)');
  });

  it('formats progress verdict without target as bare verdict', () => {
    const out = renderIterationPrompt(
      '{{ralph.recentVerdicts}}',
      baseCtx({
        recentRecords: [verdictRecord(2, { verdict: { verdict: 'progress', iteration: 2 } })],
      }),
    );
    expect(out).toBe('iter 2: progress');
  });

  it('formats complete verdict without target', () => {
    const out = renderIterationPrompt(
      '{{ralph.recentVerdicts}}',
      baseCtx({
        recentRecords: [verdictRecord(2, { verdict: { verdict: 'complete', iteration: 2 } })],
      }),
    );
    expect(out).toBe('iter 2: complete');
  });
});
