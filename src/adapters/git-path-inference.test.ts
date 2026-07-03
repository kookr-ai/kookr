import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../core/types.js';
import { inferGitInfoPathFromEvent } from './git-path-inference.js';

describe('inferGitInfoPathFromEvent', () => {
  it.each([
    {
      name: 'tool_use structured file path',
      event: {
        type: 'tool_use',
        sessionId: 'session-1',
        toolName: 'Read',
        toolInput: { file_path: '/tmp/kookr-worktree/src/app.ts' },
      },
      expected: '/tmp/kookr-worktree/src/app.ts',
    },
    {
      name: 'tool_use nested array path key',
      event: {
        type: 'tool_use',
        sessionId: 'session-1',
        toolName: 'MultiEdit',
        toolInput: {
          edits: [
            { path: 'relative/path.ts' },
            { filePath: '/tmp/kookr-worktree/src/feature.ts' },
          ],
        },
      },
      expected: '/tmp/kookr-worktree/src/feature.ts',
    },
    {
      name: 'tool_use command path',
      event: {
        type: 'tool_use',
        sessionId: 'session-1',
        toolName: 'Bash',
        toolInput: {
          command: 'pnpm --dir /tmp/kookr-worktree test',
        },
      },
      expected: '/tmp/kookr-worktree',
    },
    {
      name: 'tool_use cmd alias path',
      event: {
        type: 'tool_use',
        sessionId: 'session-1',
        toolName: 'Shell',
        toolInput: {
          cmd: 'git -C /tmp/kookr-worktree status --short',
        },
      },
      expected: '/tmp/kookr-worktree',
    },
    {
      name: 'tool_result structured response path',
      event: {
        type: 'tool_result',
        sessionId: 'session-1',
        toolName: 'Write',
        toolUseId: 'toolu-1',
        toolResponse: {
          metadata: {
            workingDirectory: '/tmp/kookr-worktree',
          },
        },
      },
      expected: '/tmp/kookr-worktree',
    },
    {
      name: 'tool_error command path',
      event: {
        type: 'tool_error',
        sessionId: 'session-1',
        toolName: 'Bash',
        toolUseId: 'toolu-1',
        toolInput: {
          command: 'sed -n "1,20p" /tmp/kookr-worktree/src/app.ts',
        },
        error: 'command failed',
        isInterrupt: false,
      },
      expected: '/tmp/kookr-worktree/src/app.ts',
    },
    {
      name: 'permission_request structured workdir',
      event: {
        type: 'permission_request',
        sessionId: 'session-1',
        toolName: 'Bash',
        toolInput: {
          workdir: '/tmp/kookr-worktree',
          command: 'pnpm test',
        },
      },
      expected: '/tmp/kookr-worktree',
    },
    {
      name: 'permission_request command path',
      event: {
        type: 'permission_request',
        sessionId: 'session-1',
        toolName: 'Bash',
        toolInput: {
          command: 'cat /tmp/kookr-worktree/src/app.ts',
        },
      },
      expected: '/tmp/kookr-worktree/src/app.ts',
    },
  ] satisfies Array<{ name: string; event: AgentEvent; expected: string }>)(
    'infers $name',
    ({ event, expected }) => {
      expect(inferGitInfoPathFromEvent(event)).toBe(expected);
    },
  );

  it('strips trailing sentence punctuation from command paths', () => {
    expect(inferGitInfoPathFromEvent({
      type: 'tool_use',
      sessionId: 'session-1',
      toolName: 'Bash',
      toolInput: {
        command: 'cat /tmp/kookr-worktree/src/app.ts.',
      },
    })).toBe('/tmp/kookr-worktree/src/app.ts');
  });

  it('ignores relative paths, non-path keys, and bare root', () => {
    expect(inferGitInfoPathFromEvent({
      type: 'tool_use',
      sessionId: 'session-1',
      toolName: 'Write',
      toolInput: {
        file_path: 'src/app.ts',
        note: '/tmp/kookr-worktree/src/app.ts',
        path: '/',
      },
    })).toBeNull();
  });

  it('does not infer paths from supported event cwd', () => {
    expect(inferGitInfoPathFromEvent({
      type: 'tool_use',
      sessionId: 'session-1',
      toolName: 'Bash',
      toolInput: {
        command: 'pnpm test',
      },
      cwd: '/tmp/kookr-worktree',
    })).toBeNull();
  });

  it('does not infer paths from unsupported event types', () => {
    expect(inferGitInfoPathFromEvent({
      type: 'notification',
      sessionId: 'session-1',
      notificationType: 'info',
      message: 'working in /tmp/kookr-worktree',
      cwd: '/tmp/kookr-worktree',
    })).toBeNull();
  });
});
