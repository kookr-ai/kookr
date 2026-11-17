// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocket } from './useWebSocket.js';
import { __resetLucyActionForTests, getLucyActionSnapshot } from '../store/lucy-action.js';
import { __resetLucyConversationForTests, getConversationEntries } from '../store/lucy-conversation.js';
import { __resetLucySaysForTests, onLucySays } from '../store/lucy-says.js';

/**
 * The stores have their own tests and call their handlers directly. This file covers the two lines in
 * between: the dashboard socket handing `lucy_action` and `lucy_says` to the stores. Without them an
 * action card or one of her lines never reaches the browser while every other test passes.
 */
class RuntimeWebSocket {
  static OPEN = 1;
  static instances: RuntimeWebSocket[] = [];
  readyState = RuntimeWebSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public readonly url: string) {
    RuntimeWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

function Probe() {
  useWebSocket();
  return null;
}

const proposal = {
  id: 'a1', kind: 'close' as const, taskId: 't1', taskName: 'Billing migration', title: 'Close Billing migration',
  asked: 'close the billing task', readBack: 'I will close it.', expiresAt: Date.now() + 100_000,
};

describe('useWebSocket: Lucy action cards and her own lines reach the stores', () => {
  let root: Root;
  let socket: RuntimeWebSocket;
  const receive = (message: unknown) => act(() => { socket.onmessage?.({ data: JSON.stringify(message) }); });

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    RuntimeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', RuntimeWebSocket);
    __resetLucyActionForTests();
    __resetLucyConversationForTests();
    __resetLucySaysForTests();
    root = createRoot(document.createElement('div'));
    await act(async () => { root.render(React.createElement(Probe)); });
    socket = RuntimeWebSocket.instances[0];
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    vi.unstubAllGlobals();
    __resetLucyActionForTests();
    __resetLucyConversationForTests();
    __resetLucySaysForTests();
  });

  it('a lucy_action proposal becomes the card, and its outcome ends it with one line in the thread', () => {
    receive({ type: 'lucy_action', conversationId: 'c1', proposal });
    expect(getLucyActionSnapshot()).toMatchObject({ proposal, conversationId: 'c1' });
    receive({ type: 'lucy_action', conversationId: 'c1', outcome: { outcome: 'done', proposalId: 'a1', kind: 'close', taskId: 't1' } });
    expect(getLucyActionSnapshot().proposal).toBeNull();
    expect(getConversationEntries()).toEqual([expect.objectContaining({ id: 'action-a1', text: 'Close Billing migration: Closed', taskId: 't1' })]);
  });

  it('a lucy_says line is handed on with its words and tasks, once', () => {
    const heard = vi.fn();
    onLucySays(heard);
    const line = { type: 'lucy_says', id: 'says-1', kind: 'task_failed', text: 'Docs link audit failed.', taskIds: ['t9'], at: 5 };
    receive(line);
    receive(line);
    expect(heard).toHaveBeenCalledExactlyOnceWith(line);
  });
});
