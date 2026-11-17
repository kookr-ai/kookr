// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { LucySaysMessage } from '../../shared/contracts/lucy-says.js';
import { __resetLucyConversationForTests, getConversationEntries } from '../store/lucy-conversation.js';
import { __resetLucySaysForTests, handleLucySays } from '../store/lucy-says.js';
import { useLucySaysThreadSync } from './useLucySays.js';

const says = (over: Partial<LucySaysMessage> = {}): LucySaysMessage => ({
  type: 'lucy_says', id: 'says-1', kind: 'task_wants_review', text: 'Docs link audit says it is finished and wants your review.', taskIds: ['t1'], at: 1, ...over,
});

function Harness() {
  useLucySaysThreadSync();
  return null;
}

describe('useLucySaysThreadSync', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    __resetLucyConversationForTests();
    __resetLucySaysForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root!.render(<Harness />); });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  test('each line becomes a finished message from Lucy that remembers its first task', () => {
    act(() => { handleLucySays(says()); });
    act(() => { handleLucySays(says({ id: 'says-2', kind: 'task_failed', text: 'Two more tasks failed: A and B.', taskIds: ['t2', 't3'] })); });
    expect(getConversationEntries()).toEqual([
      expect.objectContaining({ kind: 'typed-lucy', status: 'done', text: 'Docs link audit says it is finished and wants your review.', taskId: 't1' }),
      expect.objectContaining({ kind: 'typed-lucy', status: 'done', text: 'Two more tasks failed: A and B.', taskId: 't2' }),
    ]);
  });

  test('a line received twice is written once, and one about no task has no task on it', () => {
    act(() => { handleLucySays(says({ taskIds: [] })); });
    act(() => { handleLucySays(says({ taskIds: [] })); });
    expect(getConversationEntries()).toHaveLength(1);
    expect(getConversationEntries()[0]).not.toHaveProperty('taskId');
  });

  test('once the panel is gone nothing is written', () => {
    act(() => root?.unmount());
    root = null;
    handleLucySays(says());
    expect(getConversationEntries()).toEqual([]);
  });
});
