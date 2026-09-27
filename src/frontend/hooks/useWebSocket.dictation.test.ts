// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { useWebSocket } from './useWebSocket.js';
import { acknowledgeDictationLaunch, resumeDictationCorpusRetries } from '../store/dictation-corpus.js';

vi.mock('../store/dictation-corpus.js', () => ({
  acknowledgeDictationLaunch: vi.fn(), resumeDictationCorpusRetries: vi.fn(),
}));

class Socket {
  static OPEN = 1;
  static current: Socket;
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { Socket.current = this; }
  send() {}
  close() { this.readyState = 3; }
}
function Probe() { useWebSocket(); return null; }
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

test('a mounted dashboard resumes retained corpus retries and correlates direct launch acknowledgements', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Probe)); });
  const submissionId = '5b7ee799-01a1-4e23-8e92-f049cbdd3b5d';
  await act(async () => {
    Socket.current.onopen?.();
    Socket.current.onmessage?.({ data: JSON.stringify({ type: 'dictationLaunchResult', submissionId, taskId: 'actual-task' }) });
  });
  expect(resumeDictationCorpusRetries).toHaveBeenCalledOnce();
  expect(acknowledgeDictationLaunch).toHaveBeenCalledWith(submissionId, 'actual-task', undefined);
  await act(async () => {
    Socket.current.onmessage?.({ data: JSON.stringify({ type: 'dictationLaunchResult', submissionId, error: 'launch_failed' }) });
  });
  expect(acknowledgeDictationLaunch).toHaveBeenLastCalledWith(submissionId, undefined, 'launch_failed');
  await act(async () => { root.unmount(); });
});
