import { describe, expect, it } from 'vitest';
import { endsChainWithoutHandoff, isSelfContinuationTask } from './chain-handoff.js';

describe('isSelfContinuationTask (issue #3678, mirrors chain-handoff-stop)', () => {
  it('the playbook parameter decides when present', () => {
    expect(isSelfContinuationTask({ prompt: '- self-continuation: true', playbookParameterValues: { selfContinuation: 'false' } })).toBe(false);
    expect(isSelfContinuationTask({ prompt: 'x', playbookParameterValues: { selfContinuation: 'true' } })).toBe(true);
    expect(isSelfContinuationTask({ prompt: 'x', playbookParameterValues: { selfContinuation: '1' } })).toBe(true);
  });

  it.each([
    ['the parameter list line', 'Do it.\n- self-continuation: `true`\n'],
    ['the rendered playbook marker', '**Self-continuation** — `true`'],
    ['the continuation envelope header', 'You are continuing a sequential Kookr task chain (continuation envelope v2)\n'],
  ])('recognizes %s', (_label, prompt) => {
    expect(isSelfContinuationTask({ prompt })).toBe(true);
  });

  it('a plain prompt, or one that merely says self-continuation, is not a chain link', () => {
    expect(isSelfContinuationTask({ prompt: 'implement issue 5' })).toBe(false);
    expect(isSelfContinuationTask({ prompt: '- self-continuation: false' })).toBe(false);
  });

  it('reads the user prompt too', () => {
    expect(isSelfContinuationTask({ prompt: 'x', userPrompt: '- self-continuation: true' })).toBe(true);
  });
});

describe('endsChainWithoutHandoff', () => {
  const chain = { prompt: '- self-continuation: true' };

  it('true for a chain link with no child and no signal', () => {
    expect(endsChainWithoutHandoff(chain)).toBe(true);
  });

  it.each([
    ['a child task', { childTaskIds: ['c'] }],
    ['a pending signal', { pendingSignal: { kind: 'needs_input', raisedAt: '2026-11-16T00:00:00Z' } }],
    ['a recorded "finished"', { finishedSignalAt: '2026-11-16T00:00:00Z' }],
    ['a playbook chain', { chain: { chainId: 'c' } }],
    ['an active Ralph loop', { ralphLoop: { status: 'running' } }],
  ])('false with %s', (_label, fields) => {
    expect(endsChainWithoutHandoff({ ...chain, ...(fields as object) } as Parameters<typeof endsChainWithoutHandoff>[0])).toBe(false);
  });

  it('an empty child list is no handoff', () => {
    expect(endsChainWithoutHandoff({ ...chain, childTaskIds: [] })).toBe(true);
  });

  it('false for a task that is not a chain link', () => {
    expect(endsChainWithoutHandoff({ prompt: 'implement issue 5' })).toBe(false);
  });
});
