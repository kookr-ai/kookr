import { describe, expect, it, vi } from 'vitest';
import { createComposerDraftReporter } from './composer-draft-reporter.js';

function setup(sendResult = true) {
  let clock = 0;
  const send = vi.fn(() => sendResult);
  const reporter = createComposerDraftReporter(send, { refreshMs: 30_000, now: () => clock });
  return { send, reporter, advance: (ms: number) => { clock += ms; } };
}

describe('createComposerDraftReporter', () => {
  it('reports when a draft appears and when it is cleared, not on every keystroke', () => {
    const { send, reporter, advance } = setup();

    reporter.report('task-1', 'P');
    advance(100);
    reporter.report('task-1', 'Pe');
    advance(100);
    reporter.report('task-1', 'Peu');
    reporter.report('task-1', '');

    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { type: 'composerDraft', taskId: 'task-1', hasDraft: true },
      { type: 'composerDraft', taskId: 'task-1', hasDraft: false },
    ]);
  });

  it('re-reports a draft still being edited after the refresh period', () => {
    const { send, reporter, advance } = setup();

    reporter.report('task-1', 'début');
    advance(30_000);
    reporter.report('task-1', 'début, suite');

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ type: 'composerDraft', taskId: 'task-1', hasDraft: true });
  });

  it('sends nothing for an empty box that was never a draft, or whitespace only', () => {
    const { send, reporter } = setup();
    reporter.report('task-1', '');
    reporter.report('task-1', '   ');
    expect(send).not.toHaveBeenCalled();
  });

  it('tracks tasks separately', () => {
    const { send, reporter } = setup();
    reporter.report('task-1', 'a');
    reporter.report('task-2', 'b');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retries on the next change when the socket was down', () => {
    const { send, reporter } = setup(false);
    reporter.report('task-1', 'a');
    reporter.report('task-1', 'ab');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
