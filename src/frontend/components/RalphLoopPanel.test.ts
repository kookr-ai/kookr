// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RalphLoopPanel } from './RalphLoopPanel.js';

describe('RalphLoopPanel', () => {
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function emptyModel(prompt: string, status: 'running' | 'paused' = 'paused') {
    return {
      ralphLoop: {
        prompt,
        status,
        iterationCap: 5,
        currentIteration: 2,
        lastIterationStartedAt: 0,
        cumulativeIterations: 2,
      },
      iterations: [],
      summary: {
        totalIterations: 0,
        returnedIterations: 0,
        capped: false,
        malformedLines: 0,
        latestExitReason: null,
        cumulativeCostUsd: null,
        startedAt: null,
        endedAt: null,
        runtimeMs: null,
        averageIterationDurationMs: null,
        etaMs: null,
      },
    };
  }

  test('renders an empty state for Ralph tasks with no recorded iterations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      iterations: [],
      summary: {
        totalIterations: 0,
        returnedIterations: 0,
        capped: false,
        malformedLines: 0,
        latestExitReason: null,
        cumulativeCostUsd: null,
        startedAt: null,
        endedAt: null,
        runtimeMs: null,
        averageIterationDurationMs: null,
        etaMs: null,
      },
    }), { status: 200 })));

    await act(async () => {
      root.render(React.createElement(RalphLoopPanel, { taskId: 'task-1' }));
    });
    await act(async () => {});

    expect(container.textContent).toContain('No Ralph iterations recorded yet.');
    expect(fetch).toHaveBeenCalledWith('/api/tasks/task-1/ralph-loop/iterations', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  test('renders export links for Ralph iteration history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      iterations: [],
      summary: {
        totalIterations: 0,
        returnedIterations: 0,
        capped: false,
        malformedLines: 0,
        latestExitReason: null,
        cumulativeCostUsd: null,
        startedAt: null,
        endedAt: null,
        runtimeMs: null,
        averageIterationDurationMs: null,
        etaMs: null,
      },
    }), { status: 200 })));

    await act(async () => {
      root.render(React.createElement(RalphLoopPanel, { taskId: 'task-1' }));
    });
    await act(async () => {});

    const links = Array.from(container.querySelectorAll('a.ralph-export-link'));
    expect(links.map((link) => link.textContent)).toEqual(['Export CSV', 'Export JSON']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/api/tasks/task-1/ralph-loop/iterations/export?format=csv',
      '/api/tasks/task-1/ralph-loop/iterations/export?format=json',
    ]);
  });

  test('updates the future Ralph prompt from the panel', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/ralph-loop/prompt')) {
        expect(init?.method).toBe('PATCH');
        expect(init?.body).toBe(JSON.stringify({ prompt: 'continue, but focus on tests' }));
        return new Response(JSON.stringify({
          ok: true,
          ralphLoop: {
            prompt: 'continue, but focus on tests',
            status: 'paused',
            iterationCap: 5,
            currentIteration: 2,
            lastIterationStartedAt: 0,
            cumulativeIterations: 2,
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify(emptyModel('old prompt')), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(React.createElement(RalphLoopPanel, { taskId: 'task-1' }));
    });
    await act(async () => {});

    const textarea = container.querySelector('textarea.ralph-prompt-edit') as HTMLTextAreaElement | null;
    expect(textarea?.value).toBe('old prompt');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'continue, but focus on tests');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = container.querySelector('form.ralph-prompt-form') as HTMLFormElement | null;
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1/ralph-loop/prompt', expect.objectContaining({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'continue, but focus on tests' }),
    }));
    expect(container.textContent).toContain('Saved for future iterations.');
    expect(container.querySelector('.ralph-prompt-message')?.getAttribute('role')).toBe('status');
  });

  test('keeps an unsaved prompt edit across polling refreshes', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      const prompt = fetchMock.mock.calls.length === 1 ? 'server prompt v1' : 'server prompt v2';
      return new Response(JSON.stringify(emptyModel(prompt)), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(React.createElement(RalphLoopPanel, { taskId: 'task-1' }));
    });
    await act(async () => {});

    const textarea = container.querySelector('textarea.ralph-prompt-edit') as HTMLTextAreaElement | null;
    expect(textarea?.value).toBe('server prompt v1');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'unsaved local edit');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await act(async () => {});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(textarea?.value).toBe('unsaved local edit');
    vi.useRealTimers();
  });

  test('nudges users to pause before editing a running loop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(emptyModel('running prompt', 'running')), { status: 200 })));

    await act(async () => {
      root.render(React.createElement(RalphLoopPanel, { taskId: 'task-1' }));
    });
    await act(async () => {});

    expect(container.textContent).toContain('Pause first; next run starts fresh.');
    const textarea = container.querySelector('textarea.ralph-prompt-edit') as HTMLTextAreaElement | null;
    const hint = container.querySelector('[id^="ralph-prompt-hint-"]');
    expect(textarea?.getAttribute('aria-describedby')).toBe(hint?.id);
  });

  test('renders iteration rows and capped summary metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      iterations: [
        {
          iterationNumber: 4,
          startedAt: 1_000,
          endedAt: 4_000,
          exitReason: 'continued',
          cumulativeCostUsd: null,
          gitBaselineRef: 'ralph/iter-4-start',
          diffStats: { filesChanged: 2, insertions: 5, deletions: 1 },
        },
        {
          iterationNumber: 5,
          startedAt: 5_000,
          endedAt: 6_000,
          exitReason: 'predicate_satisfied',
          cumulativeCostUsd: 0.42,
          gitBaselineRef: 'ralph/iter-5-start',
          diffStats: null,
        },
      ],
      summary: {
        totalIterations: 5,
        returnedIterations: 2,
        capped: true,
        malformedLines: 1,
        latestExitReason: 'predicate_satisfied',
        cumulativeCostUsd: 0.42,
        startedAt: 1_000,
        endedAt: 6_000,
        runtimeMs: 5_000,
        averageIterationDurationMs: 2_000,
        etaMs: null,
      },
    }), { status: 200 })));

    await act(async () => {
      root.render(React.createElement(RalphLoopPanel, { taskId: 'task-2' }));
    });
    await act(async () => {});

    expect(container.textContent).toContain('predicate_satisfied');
    expect(container.textContent).toContain('2 files, +5 / -1');
    expect(container.textContent).toContain('$0.42');
    expect(container.textContent).toContain('1 malformed log line skipped');
    expect(container.textContent).toContain('Showing latest 2 of 5.');
  });
});
