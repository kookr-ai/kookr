// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocket } from './useWebSocket.js';
import {
  __resetOperatorAsksForTests,
  getOperatorAsksSnapshot,
  markAskSubmitting,
  onAskAnnounced,
} from '../store/operator-asks.js';

/**
 * The store, the card and the announcement each have their own tests. This file covers the
 * two lines in between: the dashboard socket handing `operatorAsks` and `operatorAskResult`
 * to the store. Without them the feature is dead in the browser while every other test passes.
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

const pending = {
  id: 'a1b2c3d4e5f6', taskId: 't1', taskName: 'Fix login', question: 'Ship it?', options: ['Yes', 'No'],
  allowText: true, state: 'pending' as const, createdAt: 1, expiresAt: 2,
};

describe('useWebSocket: questions from tasks reach the store', () => {
  let root: Root;
  let socket: RuntimeWebSocket;
  const receive = (message: unknown) => act(() => { socket.onmessage?.({ data: JSON.stringify(message) }); });

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    RuntimeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', RuntimeWebSocket);
    __resetOperatorAsksForTests();
    root = createRoot(document.createElement('div'));
    await act(async () => { root.render(React.createElement(Probe)); });
    socket = RuntimeWebSocket.instances[0];
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    vi.unstubAllGlobals();
    __resetOperatorAsksForTests();
  });

  it('puts the list in the store and announces the question that was just created', () => {
    const announced = vi.fn();
    onAskAnnounced(announced);
    receive({ type: 'operatorAsks', asks: [pending], announce: pending.id });
    expect(getOperatorAsksSnapshot().asks).toEqual([pending]);
    expect(announced).toHaveBeenCalledOnce();
    expect(announced.mock.calls[0][0]).toMatchObject({ id: pending.id });
  });

  it('does not announce a list that names no new question', () => {
    const announced = vi.fn();
    onAskAnnounced(announced);
    receive({ type: 'operatorAsks', asks: [pending] });
    expect(getOperatorAsksSnapshot().asks).toHaveLength(1);
    expect(announced).not.toHaveBeenCalled();
  });

  it('turns a refused answer into the notice on the card', () => {
    receive({ type: 'operatorAsks', asks: [pending] });
    act(() => { markAskSubmitting(pending.id, true); });
    receive({ type: 'operatorAskResult', askId: pending.id, ok: false, reason: 'expired' });
    expect(getOperatorAsksSnapshot().submit[pending.id]).toEqual({ status: 'refused', message: 'This question expired before your answer arrived.' });
  });

  it('clears "sending" when the server confirms the answer', () => {
    receive({ type: 'operatorAsks', asks: [pending] });
    act(() => { markAskSubmitting(pending.id, true); });
    receive({ type: 'operatorAskResult', askId: pending.id, ok: true });
    expect(getOperatorAsksSnapshot().submit[pending.id]).toBeUndefined();
  });
});
