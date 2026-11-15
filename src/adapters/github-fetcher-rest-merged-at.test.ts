import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubReference } from '../core/github-types.js';

/**
 * Issue #3746: the REST `fetchPRState` path (`gh pr view --json`) must carry
 * GitHub's `mergedAt`, or delivery attribution fails closed and never
 * auto-completes a task whose state came through this path.
 */
const transportMocks = vi.hoisted(() => ({ execGh: vi.fn() }));

vi.mock('./gh-cli-transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gh-cli-transport.js')>();
  return { ...actual, execGh: transportMocks.execGh };
});

const { fetchPRState } = await import('./github-fetcher.js');

const prRef: GitHubReference = {
  type: 'pr',
  owner: 'acme',
  repo: 'app',
  number: 855,
  url: 'https://github.com/acme/app/pull/855',
  detectedAt: new Date('2026-11-14T14:00:00.000Z'),
  detectedFrom: 'agent-1',
  taskId: 'task-1',
};

/** Answer `gh pr view` with `view`; checks / review-thread calls get empty payloads. */
function mockGh(view: Record<string, unknown>): void {
  transportMocks.execGh.mockImplementation(async (args: string[] = []) => {
    if (args[0] === 'pr' && args[1] === 'view') return { stdout: JSON.stringify(view), stderr: '' };
    if (args[0] === 'pr' && args[1] === 'checks') return { stdout: '[]', stderr: '' };
    return { stdout: JSON.stringify({ data: { repository: { pullRequest: null } } }), stderr: '' };
  });
}

const VIEW = {
  title: 'feat/ux-dogfooding-rfc-and-fixes',
  author: { login: 'alice' },
  headRefName: 'feat/ux-dogfooding-rfc-and-fixes',
  baseRefName: 'main',
  reviewDecision: null,
  isDraft: false,
  comments: [],
  mergeable: 'UNKNOWN',
};

describe('fetchPRState mergedAt (issue #3746)', () => {
  beforeEach(() => transportMocks.execGh.mockReset());

  it('requests mergedAt and returns it as a Date for a merged PR', async () => {
    mockGh({ ...VIEW, state: 'MERGED', mergedAt: '2026-06-10T09:00:00Z' });

    const state = await fetchPRState(prRef);

    const viewArgs = transportMocks.execGh.mock.calls.map((c) => c[0] as string[]).find((a) => a[1] === 'view');
    expect(viewArgs?.[viewArgs.indexOf('--json') + 1]?.split(',')).toContain('mergedAt');
    expect(state?.status).toBe('merged');
    expect(state?.mergedAt?.toISOString()).toBe('2026-06-10T09:00:00.000Z');
  });

  it('omits mergedAt for an unmerged PR', async () => {
    mockGh({ ...VIEW, state: 'OPEN', mergedAt: null });

    const state = await fetchPRState(prRef);

    expect(state?.status).toBe('open');
    expect(state).not.toHaveProperty('mergedAt');
  });
});
