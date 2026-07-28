import { describe, test, expect } from 'vitest';
import type { Task } from '../core/task-read-model.js';
import type { TaskStatus } from '../core/task-status.js';
import type { AgentType } from '../core/agent-types.js';
import { collectBootTranscriptRegistrations } from './boot-transcript-registration.js';

function makeTask(overrides: {
  id: string;
  status: TaskStatus;
  sessions: Array<{ transcriptPath?: string; agentType?: AgentType }>;
}): Task {
  return {
    id: overrides.id,
    prompt: 'p',
    cwd: '/tmp',
    agentType: 'claude-code',
    status: overrides.status,
    createdAt: new Date(0),
    sessions: overrides.sessions.map((s, i) => ({
      tmuxSession: `${overrides.id}-s${i}`,
      agentType: s.agentType ?? 'claude-code',
      cwd: '/tmp',
      createdAt: new Date(0),
      ...(s.transcriptPath ? { transcriptPath: s.transcriptPath } : {}),
    })),
  } as unknown as Task;
}

describe('collectBootTranscriptRegistrations', () => {
  test('registers non-terminal Claude Code sessions with a transcript', () => {
    const tasks = [
      makeTask({ id: 'active', status: 'inProgress', sessions: [{ transcriptPath: '/t/active.jsonl' }] }),
      makeTask({ id: 'open', status: 'open', sessions: [{ transcriptPath: '/t/open.jsonl' }] }),
    ];
    expect(collectBootTranscriptRegistrations(tasks)).toEqual([
      { transcriptPath: '/t/active.jsonl', taskId: 'active' },
      { transcriptPath: '/t/open.jsonl', taskId: 'open' },
    ]);
  });

  test('does NOT register terminal tasks (completed / terminated / cancelled)', () => {
    const tasks = [
      makeTask({ id: 'done', status: 'completed', sessions: [{ transcriptPath: '/t/done.jsonl' }] }),
      makeTask({ id: 'term', status: 'terminated', sessions: [{ transcriptPath: '/t/term.jsonl' }] }),
      makeTask({ id: 'cancel', status: 'cancelled', sessions: [{ transcriptPath: '/t/cancel.jsonl' }] }),
    ];
    expect(collectBootTranscriptRegistrations(tasks)).toEqual([]);
  });

  test('skips non-Claude transcript formats (Codex / Grok rollouts)', () => {
    const tasks = [
      makeTask({
        id: 'mixed',
        status: 'inProgress',
        sessions: [
          { transcriptPath: '/t/claude.jsonl', agentType: 'claude-code' },
          { transcriptPath: '/t/codex-rollout.jsonl', agentType: 'codex-cli' },
          { transcriptPath: '/t/grok.jsonl', agentType: 'grok-build' },
        ],
      }),
    ];
    expect(collectBootTranscriptRegistrations(tasks)).toEqual([
      { transcriptPath: '/t/claude.jsonl', taskId: 'mixed' },
    ]);
  });

  test('treats a missing agentType as Claude Code (historical default)', () => {
    const tasks = [
      makeTask({ id: 'legacy', status: 'inProgress', sessions: [{ transcriptPath: '/t/legacy.jsonl', agentType: undefined }] }),
    ];
    expect(collectBootTranscriptRegistrations(tasks)).toEqual([
      { transcriptPath: '/t/legacy.jsonl', taskId: 'legacy' },
    ]);
  });

  test('skips sessions without a transcript path', () => {
    const tasks = [
      makeTask({ id: 't', status: 'inProgress', sessions: [{}, { transcriptPath: '/t/has.jsonl' }] }),
    ];
    expect(collectBootTranscriptRegistrations(tasks)).toEqual([
      { transcriptPath: '/t/has.jsonl', taskId: 't' },
    ]);
  });
});
