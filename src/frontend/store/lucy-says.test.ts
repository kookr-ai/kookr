import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { LucySaysMessage } from '../../shared/contracts/lucy-says.js';
import { __resetLucySaysForTests, handleLucySays, onLucySays } from './lucy-says.js';

const says = (over: Partial<LucySaysMessage> = {}): LucySaysMessage => ({
  type: 'lucy_says', id: 'says-1', kind: 'task_failed', text: 'Docs link audit failed.', taskIds: ['t1'], at: 1_790_000_000_000, ...over,
});

describe('lucy-says store', () => {
  beforeEach(() => __resetLucySaysForTests());

  test('passes each line to the listeners', () => {
    const listener = vi.fn();
    onLucySays(listener);
    handleLucySays(says());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(says());
  });

  test('a line that arrives twice is passed on once', () => {
    const listener = vi.fn();
    onLucySays(listener);
    handleLucySays(says());
    handleLucySays(says());
    handleLucySays(says({ id: 'says-2', text: 'Another failed.' }));
    expect(listener.mock.calls.map((call) => (call[0] as LucySaysMessage).id)).toEqual(['says-1', 'says-2']);
  });

  test('a malformed line is ignored, and task ids that are not text are dropped', () => {
    const listener = vi.fn();
    onLucySays(listener);
    handleLucySays(says({ id: '' }));
    handleLucySays(says({ id: 'a', text: '   ' }));
    handleLucySays({ ...says({ id: 'b' }), text: 42 } as unknown as LucySaysMessage);
    expect(listener).not.toHaveBeenCalled();
    handleLucySays({ ...says({ id: 'c' }), taskIds: ['t1', 7, ''] } as unknown as LucySaysMessage);
    handleLucySays({ ...says({ id: 'd' }), taskIds: undefined } as unknown as LucySaysMessage);
    expect(listener.mock.calls.map((call) => (call[0] as LucySaysMessage).taskIds)).toEqual([['t1'], []]);
  });

  test('with nobody listening a line is dropped, not kept for later', () => {
    handleLucySays(says());
    const listener = vi.fn();
    onLucySays(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  test('unsubscribing stops the calls', () => {
    const listener = vi.fn();
    const off = onLucySays(listener);
    off();
    handleLucySays(says());
    expect(listener).not.toHaveBeenCalled();
  });
});
