import { describe, test, expect } from 'vitest';
import type { AgentState } from '../../core/monitor.js';
import type { GitHubReference } from '../../core/github-types.js';
import { buildGithubTaskOverlay } from './github-task-overlay.js';

function makeAgent(partial: Partial<AgentState> & { agentId: string }): AgentState {
  return {
    agentId: partial.agentId,
    events: [],
    anomaly: null,
    summary: '',
    summarizedAt: null,
    lastActivityAt: 0,
    taskStatus: 'inProgress',
    ...partial,
  } as AgentState;
}

function makeRef(
  owner: string,
  repo: string,
  type: 'pr' | 'issue',
  number: number,
  taskId: string,
): GitHubReference {
  return {
    type,
    owner,
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/${type === 'pr' ? 'pull' : 'issues'}/${number}`,
    detectedAt: new Date(),
    detectedFrom: 'agent-1',
    taskId,
  };
}

function refsFromList(refs: GitHubReference[]) {
  return (taskId: string) => refs.filter((r) => r.taskId === taskId);
}

describe('buildGithubTaskOverlay', () => {
  test('returns empty map when no agents are active', () => {
    const overlay = buildGithubTaskOverlay({ agents: [], getTaskGithubReferences: () => [] });
    expect(overlay.size).toBe(0);
  });

  test('skips agents missing taskId or projectId', () => {
    const overlay = buildGithubTaskOverlay({
      agents: [
        makeAgent({ agentId: 'a-1', taskId: 't-1' }),
        makeAgent({ agentId: 'a-2', projectId: 'github.com/octo/cat' }),
      ],
      getTaskGithubReferences: () => [makeRef('octo', 'cat', 'issue', 1, 't-1')],
    });
    expect(overlay.size).toBe(0);
  });

  test('matches refs case-insensitively against the project owner/repo', () => {
    // GitHub URLs are case-insensitive; the ref scanner stores owner/repo
    // verbatim from the captured URL while the projectId is canonicalised
    // lowercase. The overlay must still recognise the match.
    const overlay = buildGithubTaskOverlay({
      agents: [
        makeAgent({ agentId: 'a-1', taskId: 't-1', projectId: 'github.com/octo/cat' }),
      ],
      getTaskGithubReferences: refsFromList([makeRef('Octo', 'Cat', 'issue', 7, 't-1')]),
    });
    const entry = overlay.get('github.com/octo/cat')!;
    expect(Array.from(entry.tiedOpenIssueNumbers)).toEqual([7]);
  });

  test('skips completed and snoozed agents', () => {
    const refs = [
      makeRef('octo', 'cat', 'issue', 1, 't-1'),
      makeRef('octo', 'cat', 'issue', 2, 't-2'),
    ];
    const overlay = buildGithubTaskOverlay({
      agents: [
        makeAgent({ agentId: 'a-1', taskId: 't-1', projectId: 'github.com/octo/cat', taskStatus: 'completed' }),
        makeAgent({ agentId: 'a-2', taskId: 't-2', projectId: 'github.com/octo/cat', snoozedUntil: Date.now() + 60_000 }),
      ],
      getTaskGithubReferences: refsFromList(refs),
    });
    expect(overlay.size).toBe(0);
  });

  test('counts distinct issues referenced by active tasks', () => {
    const refs = [
      makeRef('octo', 'cat', 'issue', 42, 't-1'),
      makeRef('octo', 'cat', 'issue', 99, 't-2'),
    ];
    const overlay = buildGithubTaskOverlay({
      agents: [
        makeAgent({ agentId: 'a-1', taskId: 't-1', projectId: 'github.com/octo/cat', taskName: 'fix #42' }),
        makeAgent({ agentId: 'a-2', taskId: 't-2', projectId: 'github.com/octo/cat', taskName: 'fix #99' }),
      ],
      getTaskGithubReferences: refsFromList(refs),
    });
    const entry = overlay.get('github.com/octo/cat');
    expect(entry).toBeDefined();
    expect(entry!.tiedOpenIssueNumbers.size).toBe(2);
    expect(entry!.tiedOpenPrNumbers.size).toBe(0);
    expect(entry!.links).toHaveLength(2);
  });

  test('counts the same issue once even when multiple active tasks reference it', () => {
    const refs = [
      makeRef('octo', 'cat', 'issue', 42, 't-1'),
      makeRef('octo', 'cat', 'issue', 42, 't-2'),
    ];
    const overlay = buildGithubTaskOverlay({
      agents: [
        makeAgent({ agentId: 'a-1', taskId: 't-1', projectId: 'github.com/octo/cat', taskName: 'task A' }),
        makeAgent({ agentId: 'a-2', taskId: 't-2', projectId: 'github.com/octo/cat', taskName: 'task B' }),
      ],
      getTaskGithubReferences: refsFromList(refs),
    });
    const entry = overlay.get('github.com/octo/cat')!;
    expect(entry.tiedOpenIssueNumbers.size).toBe(1);
    expect(entry.links).toHaveLength(2);
    expect(entry.links.map((l) => l.taskName).sort()).toEqual(['task A', 'task B']);
  });

  test('ignores refs whose owner/repo does not match the project', () => {
    const refs = [
      makeRef('upstream', 'project', 'issue', 7, 't-1'),
      makeRef('octo', 'cat', 'issue', 8, 't-1'),
    ];
    const overlay = buildGithubTaskOverlay({
      agents: [
        makeAgent({ agentId: 'a-1', taskId: 't-1', projectId: 'github.com/octo/cat' }),
      ],
      getTaskGithubReferences: refsFromList(refs),
    });
    const entry = overlay.get('github.com/octo/cat')!;
    expect(Array.from(entry.tiedOpenIssueNumbers)).toEqual([8]);
  });

  test('separates issue and PR with the same number', () => {
    const refs = [
      makeRef('octo', 'cat', 'pr', 42, 't-1'),
      makeRef('octo', 'cat', 'issue', 42, 't-1'),
    ];
    const overlay = buildGithubTaskOverlay({
      agents: [
        makeAgent({ agentId: 'a-1', taskId: 't-1', projectId: 'github.com/octo/cat' }),
      ],
      getTaskGithubReferences: refsFromList(refs),
    });
    const entry = overlay.get('github.com/octo/cat')!;
    expect(entry.tiedOpenIssueNumbers.size).toBe(1);
    expect(entry.tiedOpenPrNumbers.size).toBe(1);
  });

  test('skips non-GitHub project ids', () => {
    const overlay = buildGithubTaskOverlay({
      agents: [
        makeAgent({ agentId: 'a-1', taskId: 't-1', projectId: 'local/myrepo' }),
      ],
      getReferences: () => [makeRef('octo', 'cat', 'pr', 1, 't-1')],
    });
    expect(overlay.size).toBe(0);
  });

  test('deduplicates same-task refs surfaced from both prompt scan and hook event', () => {
    // Two refs with same (owner, repo, type, number) but different detectedFrom
    // — store rejects identical (taskId, ...) so this list represents what would
    // survive the store. The overlay must still count once per task.
    const refs = [
      makeRef('octo', 'cat', 'issue', 42, 't-1'),
    ];
    const overlay = buildGithubTaskOverlay({
      agents: [
        makeAgent({ agentId: 'a-1', taskId: 't-1', projectId: 'github.com/octo/cat' }),
      ],
      getTaskGithubReferences: refsFromList(refs),
    });
    const entry = overlay.get('github.com/octo/cat')!;
    expect(entry.tiedOpenIssueNumbers.size).toBe(1);
    expect(entry.links).toHaveLength(1);
  });
});
