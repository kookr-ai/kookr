import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubReference } from '../core/github-types.js';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFilePromisified: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => {
  const execFile = childProcessMocks.execFile as typeof childProcessMocks.execFile & {
    [promisify.custom]?: typeof childProcessMocks.execFilePromisified;
  };
  execFile[promisify.custom] = childProcessMocks.execFilePromisified;
  return {
    execFile,
    spawn: childProcessMocks.spawn,
  };
});

const { fetchStates } = await import('./github-fetcher.js');

afterEach(() => {
  vi.useRealTimers();
});

function ref(owner: string, repo: string, number = 42): GitHubReference {
  return {
    type: 'pr',
    owner,
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    detectedAt: new Date('2026-05-12T00:00:00.000Z'),
    detectedFrom: 'agent-1',
    taskId: 'task-1',
  };
}

function emptyRepoResponse(): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify({ data: { repository: { pr_42: null } } }),
    stderr: '',
  };
}

function graphqlArgs(): string[] {
  const call = childProcessMocks.execFilePromisified.mock.calls[0];
  expect(call?.[0]).toBe('gh');
  return call?.[1] as string[];
}

describe('fetchStates owner/repo sanitization', () => {
  beforeEach(() => {
    childProcessMocks.execFile.mockReset();
    childProcessMocks.execFilePromisified.mockReset();
    childProcessMocks.spawn.mockReset();
    childProcessMocks.execFilePromisified.mockResolvedValue(emptyRepoResponse());
  });

  it.each([
    {
      name: 'trims a trailing newline and does not send the illegal segment',
      owner: 'kookr-ai',
      repo: 'kookr\n',
      expectCall: true,
      expectedOwner: 'kookr-ai',
      expectedRepo: 'kookr',
    },
    {
      name: 'trims a trailing newline from owner',
      owner: 'kookr-ai\n',
      repo: 'kookr',
      expectCall: true,
      expectedOwner: 'kookr-ai',
      expectedRepo: 'kookr',
    },
    {
      name: 'skips a slash inside repo',
      owner: 'kookr-ai',
      repo: 'kookr/extra',
      expectCall: false,
    },
    {
      name: 'skips a slash inside owner',
      owner: 'kookr-ai/extra',
      repo: 'kookr',
      expectCall: false,
    },
    {
      name: 'passes a numeric owner as a string field',
      owner: '12345',
      repo: 'kookr',
      expectCall: true,
      expectedOwner: '12345',
      expectedRepo: 'kookr',
    },
    {
      name: 'sends mixed-case live refs without lowercasing them',
      owner: 'Kookr-AI',
      repo: 'Kookr',
      expectCall: true,
      expectedOwner: 'Kookr-AI',
      expectedRepo: 'Kookr',
    },
    {
      name: 'does not rewrite owner/repo stuffed into repo',
      owner: 'kookr-ai',
      repo: 'kookr-ai/kookr',
      expectCall: false,
    },
    {
      name: 'fetches a legal kookr-ai/kookr reference',
      owner: 'kookr-ai',
      repo: 'kookr',
      expectCall: true,
      expectedOwner: 'kookr-ai',
      expectedRepo: 'kookr',
    },
  ])('$name', async ({ owner, repo, expectCall, expectedOwner, expectedRepo }) => {
    const result = await fetchStates([ref(owner, repo)]);

    expect(result).toEqual({ prs: [], issues: [] });
    if (!expectCall) {
      expect(childProcessMocks.execFilePromisified).not.toHaveBeenCalled();
      return;
    }

    const args = graphqlArgs();
    expect(args).toContain('-f');
    expect(args).toContain(`owner=${expectedOwner}`);
    expect(args).toContain(`repo=${expectedRepo}`);
    expect(args).not.toContain('-F');
    if (owner !== expectedOwner) expect(args).not.toContain(`owner=${owner}`);
    if (repo !== expectedRepo) expect(args).not.toContain(`repo=${repo}`);
    const ownerIdx = args.indexOf(`owner=${expectedOwner}`);
    const repoIdx = args.indexOf(`repo=${expectedRepo}`);
    expect(args[ownerIdx - 1]).toBe('-f');
    expect(args[repoIdx - 1]).toBe('-f');
  });

  it('still fetches a legal repo when a sibling ref is illegal', async () => {
    await fetchStates([
      ref('kookr-ai', 'kookr/extra', 1),
      ref('kookr-ai', 'kookr', 42),
    ]);

    expect(childProcessMocks.execFilePromisified).toHaveBeenCalledTimes(1);
    const args = graphqlArgs();
    expect(args).toContain('owner=kookr-ai');
    expect(args).toContain('repo=kookr');
    expect(args).not.toContain('repo=kookr/extra');
  });

  it('emits one alias when a dirty repo trims to the same object as a clean sibling', async () => {
    await fetchStates([
      ref('kookr-ai', 'kookr\n', 42),
      ref('kookr-ai', 'kookr', 42),
    ]);

    expect(childProcessMocks.execFilePromisified).toHaveBeenCalledTimes(1);
    const args = graphqlArgs();
    const query = args.find((arg) => arg.startsWith('query=')) ?? '';
    expect(query.match(/pr_42: pullRequest/g)).toHaveLength(1);
    expect(args).toContain('repo=kookr');
    expect(args).not.toContain('repo=kookr\n');
  });
});
