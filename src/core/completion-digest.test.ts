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

    expect(digest.testSummary).toContain('8 passed');
    expect(digest.testSummary).toContain('2 failed');
  });

  test('extracts vitest-style test output', () => {
    const events: AgentEvent[] = [
      toolResult('Bash', 'Tests  5 passed (3)'),
    ];

    const digest = generateCompletionDigest(events);

    expect(digest.testSummary).toContain('5 passed');
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

    expect(digest.bullets.length).toBeLessThanOrEqual(5);
  });

  test('handles events with missing toolInput gracefully', () => {
    const events: AgentEvent[] = [
      toolUse('Write'),
      toolUse('Bash'),
      toolResult('Bash', undefined),
    ];

    const digest = generateCompletionDigest(events);

    // Should not throw, falls back gracefully
    expect(digest.bullets.length).toBeGreaterThan(0);
  });
});
