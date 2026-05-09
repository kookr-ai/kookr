import { describe, test, expect } from 'vitest';
import { generateCompletionDigest } from './completion-digest.js';
import type { AgentEvent } from './types.js';

function toolUse(toolName: string, toolInput?: unknown): AgentEvent {
  return { type: 'tool_use', sessionId: 's1', toolName, toolInput };
}

function toolResult(toolName: string, toolResponse?: unknown): AgentEvent {
  return { type: 'tool_result', sessionId: 's1', toolName, toolResponse };
}

function stopEvent(lastMessage: string): AgentEvent {
  return { type: 'stop', sessionId: 's1', lastMessage };
}

describe('generateCompletionDigest', () => {
  test('extracts files changed from Write and Edit events', () => {
    const events: AgentEvent[] = [
      toolUse('Write', { file_path: '/home/user/src/main.ts', content: '...' }),
      toolUse('Edit', { file_path: '/home/user/src/utils.ts', old_string: 'a', new_string: 'b' }),
      toolUse('Read', { file_path: '/home/user/src/other.ts' }),
    ];

    const digest = generateCompletionDigest(events);

    expect(digest.filesChanged).toEqual(['main.ts', 'utils.ts']);
    expect(digest.bullets[0]).toContain('Changed 2 files');
    expect(digest.bullets[0]).toContain('main.ts');
    expect(digest.bullets[0]).toContain('utils.ts');
  });

  test('deduplicates files changed', () => {
    const events: AgentEvent[] = [
      toolUse('Write', { file_path: '/src/foo.ts', content: 'v1' }),
      toolUse('Edit', { file_path: '/src/foo.ts', old_string: 'a', new_string: 'b' }),
      toolUse('Write', { file_path: '/src/bar.ts', content: 'v1' }),
    ];

    const digest = generateCompletionDigest(events);

    expect(digest.filesChanged).toEqual(['foo.ts', 'bar.ts']);
  });

  test('truncates file list when more than 3', () => {
    const events: AgentEvent[] = [
      toolUse('Write', { file_path: '/a.ts' }),
      toolUse('Write', { file_path: '/b.ts' }),
      toolUse('Write', { file_path: '/c.ts' }),
      toolUse('Write', { file_path: '/d.ts' }),
      toolUse('Write', { file_path: '/e.ts' }),
    ];

    const digest = generateCompletionDigest(events);

    expect(digest.filesChanged).toHaveLength(5);
    expect(digest.bullets[0]).toContain('+2 more');
  });

  test('detects git commits from Bash tool_use', () => {
    const events: AgentEvent[] = [
      toolUse('Bash', { command: 'git commit -m "fix: bug"' }),
      toolUse('Bash', { command: 'git status' }),
      toolUse('Bash', { command: 'git commit -m "feat: add feature"' }),
    ];

    const digest = generateCompletionDigest(events);

    expect(digest.bullets).toContainEqual(expect.stringContaining('2 commits'));
  });

  test('extracts test summary from generic pattern', () => {
    const events: AgentEvent[] = [
      toolResult('Bash', '12 tests passed, 0 failed'),
    ];

    const digest = generateCompletionDigest(events);

    expect(digest.testSummary).toBe('Tests: 12 passed');
    expect(digest.bullets).toContainEqual(expect.stringContaining('12 passed'));
  });

  test('extracts test summary with failures', () => {
    const events: AgentEvent[] = [
      toolResult('Bash', 'Results: 8 tests passed, 2 tests failed'),
    ];

    const digest = generateCompletionDigest(events);

    expect(digest.testSummary).toBe('Tests: 8 passed, 2 failed');
    expect(digest.bullets).toEqual(['Tests: 8 passed, 2 failed']);
  });

  test('extracts vitest-style test output', () => {
    const events: AgentEvent[] = [
      toolResult('Bash', 'Tests  5 passed (3)'),
    ];

    const digest = generateCompletionDigest(events);

    expect(digest.testSummary).toBe('Tests: 5 passed');
    expect(digest.bullets).toEqual(['Tests: 5 passed']);
  });

  test('includes PR URLs when provided', () => {
    const events: AgentEvent[] = [
      toolUse('Write', { file_path: '/src/main.ts' }),
    ];

    const digest = generateCompletionDigest(events, {
      prUrls: ['https://github.com/org/repo/pull/42'],
    });

    expect(digest.bullets).toContainEqual(expect.stringContaining('Created PR'));
    expect(digest.bullets).toContainEqual(expect.stringContaining('pull/42'));
  });

  test('preserves implementation metadata when provided by the completion layer', () => {
    const events: AgentEvent[] = [
      toolUse('Bash', { command: 'pnpm test' }),
      toolResult('Bash', 'Tests  5 passed (3)'),
    ];

    const digest = generateCompletionDigest(events, {
      branch: 'feat-issue-223-completion-metadata',
      commits: ['abc1234'],
      prUrls: ['https://github.com/kookr-ai/kookr/pull/224'],
      filesChanged: ['src/core/completion-digest.ts'],
      tokenUsage: {
        source: 'codex-rollout',
        quality: 'available',
        model: 'gpt-5.3-codex',
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        costUsd: 0.01,
      },
    });

    expect(digest.branch).toBe('feat-issue-223-completion-metadata');
    expect(digest.commits).toEqual(['abc1234']);
    expect(digest.prUrls).toEqual(['https://github.com/kookr-ai/kookr/pull/224']);
    expect(digest.filesChanged).toEqual(['src/core/completion-digest.ts']);
    expect(digest.verificationCommands).toEqual(['pnpm test']);
    expect(digest.tokenUsage).toEqual({
      source: 'codex-rollout',
      quality: 'available',
      model: 'gpt-5.3-codex',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      costUsd: 0.01,
    });
  });

  test('records unavailable token metadata explicitly instead of zero totals', () => {
    const digest = generateCompletionDigest([], {
      tokenUsage: {
        source: 'codex-rollout',
        quality: 'unavailable',
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
        reason: 'Codex rollout has no token telemetry',
      },
    });

    expect(digest.tokenUsage).toEqual({
      source: 'codex-rollout',
      quality: 'unavailable',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      reason: 'Codex rollout has no token telemetry',
    });
    expect(digest.bullets).toContain('Token usage unavailable: Codex rollout has no token telemetry');
  });

  test('falls back to stop message when few bullets', () => {
    const events: AgentEvent[] = [
      stopEvent('I have completed the requested changes to the configuration file.'),
    ];

    const digest = generateCompletionDigest(events);

    expect(digest.bullets[0]).toContain('completed the requested changes');
  });

  test('falls back to "Task completed" when no events', () => {
    const digest = generateCompletionDigest([]);

    expect(digest.bullets).toEqual(['Task completed']);
    expect(digest.filesChanged).toEqual([]);
    expect(digest.testSummary).toBeUndefined();
  });

  test('limits bullets to 5', () => {
    const events: AgentEvent[] = [
      toolUse('Write', { file_path: '/a.ts' }),
      toolUse('Write', { file_path: '/b.ts' }),
      toolUse('Write', { file_path: '/c.ts' }),
      toolUse('Write', { file_path: '/d.ts' }),
      toolUse('Bash', { command: 'git commit -m "first"' }),
      toolUse('Bash', { command: 'git commit -m "second"' }),
      toolResult('Bash', '42 tests passed'),
      stopEvent('All done!'),
    ];

    const digest = generateCompletionDigest(events, {
      prUrls: ['#1', '#2'],
    });

    expect(digest.bullets).toEqual([
      'Changed 4 files: a.ts, b.ts, c.ts +1 more',
      'Created PRs: #1, #2',
      'Made 2 commits',
      'Tests: 42 passed',
    ]);
  });

  test('handles events with missing toolInput gracefully', () => {
    const events: AgentEvent[] = [
      toolUse('Write'),
      toolUse('Bash'),
      toolResult('Bash', undefined),
    ];

    const digest = generateCompletionDigest(events);

    expect(digest).toEqual({
      bullets: ['Task completed'],
      filesChanged: [],
      testSummary: undefined,
    });
  });
});
