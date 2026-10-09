// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TranscriptView, TranscriptToggle } from './TranscriptView.js';

function stubTranscript(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TranscriptView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(el: React.ReactElement) {
    act(() => root.render(el));
    await flush();
  }

  test('renders the final assistant answer prominently and tool calls collapsed', async () => {
    const fetchMock = stubTranscript({
      taskId: 't1', source: 'vendor',
      messages: [
        { kind: 'text', role: 'user', text: 'do it' },
        { kind: 'tool_call', name: 'Bash', input: 'ls' },
        { kind: 'text', role: 'assistant', text: 'The answer is 42' },
      ],
    });
    await render(<TranscriptView taskId="t1" />);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/tasks/t1/transcript');
    expect(container.querySelector('[data-testid="transcript-final-answer"]')?.textContent).toContain('The answer is 42');
    expect(container.querySelector('[data-testid="transcript-user"]')?.textContent).toContain('do it');
    expect(container.querySelector('details[data-testid="transcript-tool-call"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="transcript-ledger-note"]')).toBeNull();
  });

  test.each([
    ['vendor_never_persisted', "This conversation wasn't recorded (the agent's transcript was never written)."],
    ['aged_out', 'This conversation is no longer available (transcript aged out).'],
    ['unsupported_provider', "Transcript viewing isn't supported for this agent yet."],
    ['not_found', 'Task not found.'],
  ])('unavailable reason %s shows its message', async (reason, text) => {
    stubTranscript({ taskId: 't1', unavailable: { reason } }, reason === 'not_found' ? 404 : 200);
    await render(<TranscriptView taskId="t1" />);
    expect(container.querySelector('[data-testid="transcript-unavailable"]')?.textContent).toBe(text);
  });

  test('ledger source shows the recovered-from-log note', async () => {
    stubTranscript({ taskId: 't1', source: 'ledger', messages: [{ kind: 'text', role: 'assistant', text: 'done' }] });
    await render(<TranscriptView taskId="t1" />);
    expect(container.querySelector('[data-testid="transcript-ledger-note"]')?.textContent).toContain('Recovered from activity log');
  });

  test('shows an error state when the request fails', async () => {
    stubTranscript({ error: 'boom' }, 500);
    await render(<TranscriptView taskId="t1" />);
    expect(container.querySelector('[data-testid="transcript-error"]')).not.toBeNull();
  });

  test('toggle fetches only after opening', async () => {
    const fetchMock = stubTranscript({ taskId: 't1', source: 'vendor', messages: [{ kind: 'text', role: 'assistant', text: 'hi' }] });
    await render(<TranscriptToggle taskId="t1" />);
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="transcript-toggle"]')!.click());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('hi');
  });
});
