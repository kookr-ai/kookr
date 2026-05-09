import { describe, expect, test } from 'vitest';
import type { AgentEvent } from '../core/types.js';
import type { Task } from '../core/tasks.js';
import { buildTaskCompletionMetadata } from './completion-metadata.js';
import type { CodexRolloutMeta, ScanResult } from '../adapters/codex-rollout-scanner.js';

function task(overrides: Partial<Task> = {}): Task {
  const createdAt = new Date('2026-05-09T10:00:00.000Z');
  return {
    id: 'task-1',
    prompt: 'Populate completion metadata',
    cwd: '/repo',
    agentType: 'codex-cli',
    status: 'inProgress',
    sessions: [{
      tmuxSession: 'kookr-1',
      agentType: 'codex-cli',
      cwd: '/repo',
      createdAt,
      gitBranch: 'feat-issue-223-completion-metadata',
      gitCommit: 'head-sha',
    }],
    autonomy: 'supervised',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function rollout(overrides: Partial<CodexRolloutMeta> = {}): CodexRolloutMeta {
  return {
    path: '/codex/rollout.jsonl',
    id: 'rollout-1',
    cwd: '/repo',
    startedAt: new Date('2026-05-09T10:00:15.000Z'),
    cliVersion: '0.0.0',
    forkedFromId: null,
    parentThreadId: null,
    agentNickname: null,
    model: 'gpt-5.3-codex',
    totalUsage: {
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 100,
      reasoningOutputTokens: 0,
    },
    hasTerminalEvent: true,
    mtimeMs: Date.parse('2026-05-09T10:05:00.000Z'),
    parseError: null,
    ...overrides,
  };
}

function toolUse(command: string): AgentEvent {
  return { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command } };
}

function toolResult(toolResponse: string): AgentEvent {
  return { type: 'tool_result', sessionId: 's1', toolName: 'Bash', toolResponse };
}

describe('buildTaskCompletionMetadata', () => {
  test('enriches Codex task completion with git, PR, diff, verification, and token data', async () => {
    const commands: string[] = [];
    const runCommand = async (cmd: string, args: string[], opts: { cwd: string }) => {
      commands.push([cmd, ...args].join(' '));
      if (cmd === 'git' && args[0] === 'branch') return 'feat-issue-223-completion-metadata\n';
      if (cmd === 'git' && args[0] === 'merge-base') return 'base-sha\n';
      if (cmd === 'git' && args[0] === 'log') return 'commit-one\ncommit-two\n';
      if (cmd === 'git' && args[0] === 'diff') return 'src/core/completion-digest.ts\nsrc/server/completion-metadata.ts\n';
      if (cmd === 'gh' && args[0] === 'pr') return 'https://github.com/kookr-ai/kookr/pull/224\n';
      throw new Error(`unexpected command in ${opts.cwd}: ${cmd} ${args.join(' ')}`);
    };

    const scan: ScanResult = {
      rollouts: [rollout()],
      stats: { rolloutCount: 1, parseErrorCount: 0, abandonedCount: 0, scanDurationMs: 1, codexHome: '/codex' },
    };
    const scanner = {
      scan: async () => scan,
      bindTasks: () => ({
        bindings: new Map(),
        outcomes: new Map([
          ['task-1', {
            kind: 'bound' as const,
            binding: {
              taskId: 'task-1',
              parent: scan.rollouts[0],
              subagents: [],
              totalInputTokens: 1000,
              totalOutputTokens: 200,
              totalCachedInputTokens: 100,
              model: 'gpt-5.3-codex',
              hasTokenData: true,
              hasParseError: false,
            },
          }],
        ]),
        orphanBindings: [],
      }),
    };

    const metadata = await buildTaskCompletionMetadata(
      task(),
      [toolUse('pnpm test'), toolResult('Tests  5 passed (3)')],
      { runCommand, scanner, now: () => Date.parse('2026-05-09T10:10:00.000Z') },
    );

    expect(commands).toContain('git branch --show-current');
    expect(metadata.digest.branch).toBe('feat-issue-223-completion-metadata');
    expect(metadata.digest.commits).toEqual(['commit-one', 'commit-two']);
    expect(metadata.digest.prUrls).toEqual(['https://github.com/kookr-ai/kookr/pull/224']);
    expect(metadata.digest.filesChanged).toEqual([
      'src/core/completion-digest.ts',
      'src/server/completion-metadata.ts',
    ]);
    expect(metadata.digest.verificationCommands).toEqual(['pnpm test']);
    expect(metadata.digest.tokenUsage?.quality).toBe('available');
    expect(metadata.taskTokenUsage).toEqual({
      inputTokens: 900,
      outputTokens: 200,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      costUsd: expect.any(Number),
    });
  });

  test('marks missing Codex rollout token data explicitly', async () => {
    const scan: ScanResult = {
      rollouts: [rollout({ totalUsage: null })],
      stats: { rolloutCount: 1, parseErrorCount: 0, abandonedCount: 0, scanDurationMs: 1, codexHome: '/codex' },
    };
    const scanner = {
      scan: async () => scan,
      bindTasks: () => ({
        bindings: new Map(),
        outcomes: new Map([
          ['task-1', {
            kind: 'bound' as const,
            binding: {
              taskId: 'task-1',
              parent: scan.rollouts[0],
              subagents: [],
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalCachedInputTokens: 0,
              model: 'gpt-5.3-codex',
              hasTokenData: false,
              hasParseError: false,
            },
          }],
        ]),
        orphanBindings: [],
      }),
    };

    const metadata = await buildTaskCompletionMetadata(task(), [], {
      runCommand: async () => '',
      scanner,
    });

    expect(metadata.taskTokenUsage).toBeUndefined();
    expect(metadata.digest.tokenUsage).toMatchObject({
      source: 'codex-rollout',
      quality: 'unavailable',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
    });
  });
});
