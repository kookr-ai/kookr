// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../../shared/protocol.js';
import { TaskCompletionDigest } from './TaskCompletionDigest.js';

// Focused tests for the extracted digest component. They mount the component
// directly (no DetailPanel, no store) so the digest's own rendering and
// verification hydration are exercised in isolation; the parent-integration
// contract is covered by the DetailPanel.*.test.tsx suites.

type Digest = NonNullable<AgentState['completionDigest']>;

function completedAgent(overrides: Partial<AgentState> = {}, digest: Partial<Digest> = {}): AgentState {
  return {
    agentId: 'kookr-done',
    taskId: 'task-1',
    taskName: 'Digest task',
    events: [],
    anomaly: null,
    taskStatus: 'completed',
    cwd: '/repo',
    startedAt: '2026-06-11T12:00:00.000Z',
    completionDigest: {
      bullets: ['Changed 1 file'],
      filesChanged: ['src/app.ts'],
      ...digest,
    },
    ...overrides,
  };
}

/** Mock GET /api/tasks/:id to return a full digest with the given commands. */
function stubDetailFetch(verificationCommands: string[] | undefined) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      taskId: 'task-1',
      completionDigest: {
        bullets: ['Changed 1 file'],
        filesChanged: ['src/app.ts'],
        ...(verificationCommands ? { verificationCommands } : {}),
      },
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Let the hydration fetch resolve and React re-render. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TaskCompletionDigest', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    stubDetailFetch(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  function render(agent: AgentState): Root {
    const r = createRoot(container);
    act(() => {
      r.render(React.createElement(TaskCompletionDigest, { agent }));
    });
    return r;
  }

  test('renders the Completed heading with bullets and files changed', () => {
    root = render(completedAgent());
    const digest = container.querySelector('.detail-digest');
    expect(digest).not.toBeNull();
    expect(digest?.querySelector('h3')?.textContent).toBe('Completed');
    expect(container.textContent).toContain('Changed 1 file');
    expect(container.textContent).toContain('Files changed:');
    expect(container.textContent).toContain('src/app.ts');
  });

  test('uses the Cancelled and Terminated headings for those statuses', () => {
    root = render(completedAgent({ taskStatus: 'cancelled' }));
    expect(container.querySelector('.detail-digest h3')?.textContent).toBe('Cancelled');
    act(() => root?.unmount());
    root = render(completedAgent({ taskStatus: 'terminated' }));
    expect(container.querySelector('.detail-digest h3')?.textContent).toBe('Terminated');
  });

  test('renders the test summary block only when present', () => {
    root = render(completedAgent({}, { testSummary: '3 passed, 0 failed' }));
    const summary = container.querySelector('[data-testid="digest-test-summary"]');
    expect(summary?.textContent).toContain('Tests:');
    expect(summary?.textContent).toContain('3 passed, 0 failed');
  });

  test('omits the test summary block when absent', () => {
    root = render(completedAgent());
    expect(container.querySelector('[data-testid="digest-test-summary"]')).toBeNull();
  });

  test('omits the files-changed block when filesChanged is empty', () => {
    root = render(completedAgent({}, { filesChanged: [] }));
    expect(container.querySelector('.detail-digest-files')).toBeNull();
    // The rest of the digest still renders.
    expect(container.textContent).toContain('Changed 1 file');
  });

  test('renders labelled PR links opening in a new tab', () => {
    root = render(completedAgent({}, { prUrls: ['https://github.com/kookr-ai/kookr/pull/2731'] }));
    const block = container.querySelector('[data-testid="detail-digest-prs"]');
    expect(block?.textContent).toContain('Pull request:');
    const link = block?.querySelector<HTMLAnchorElement>('a[href]');
    expect(link?.getAttribute('href')).toBe('https://github.com/kookr-ai/kookr/pull/2731');
    expect(link?.textContent).toContain('PR #2731');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('renders the criteria verdict block with a pass summary', () => {
    root = render(completedAgent({}, {
      criteriaVerdict: {
        summary: { pass: 2, fail: 0, unknown: 0 },
        items: [
          { criterion: 'Builds', verdict: 'pass', reason: 'green' },
          { criterion: 'Tests', verdict: 'pass', reason: 'all pass' },
        ],
      },
    }));
    const verdict = container.querySelector('[data-testid="criteria-verdict"]');
    expect(verdict).not.toBeNull();
    expect(verdict?.classList.contains('criteria-verdict--pass')).toBe(true);
    expect(verdict?.textContent).toContain('Criteria passed');
    expect(verdict?.querySelectorAll('.criteria-verdict-item')).toHaveLength(2);
  });

  test('hydrates verification commands from the detail fetch for the task id', async () => {
    const fetchMock = stubDetailFetch(['pnpm build', 'pnpm test']);
    root = render(completedAgent());
    await flush();
    // Hydration targets this task's detail endpoint (id threaded through).
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1', expect.objectContaining({ signal: expect.anything() }));
    const commands = container.querySelector('[data-testid="verify-commands"]');
    expect(commands?.textContent).toContain('How to verify');
    const codes = Array.from(commands?.querySelectorAll('code') ?? []).map((c) => c.textContent);
    expect(codes).toEqual(['pnpm build', 'pnpm test']);
  });

  test('renders nothing when the agent has no completion digest', () => {
    root = render(completedAgent({ completionDigest: undefined }));
    expect(container.querySelector('.detail-digest')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
