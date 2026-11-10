import { describe, expect, test } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionInfo, Task } from '../core/tasks.js';
import {
  buildResumeContext,
  buildTaskResumeContext,
  hasResumableSession,
  pickResumableSession,
} from './resume-context.js';

function session(partial: Partial<SessionInfo> & { tmuxSession: string }): SessionInfo {
  return {
    agentType: 'claude-code',
    cwd: '/repo',
    createdAt: new Date(),
    ...partial,
  };
}

function taskWith(sessions: SessionInfo[]): Task {
  return { id: 't1', sessions } as unknown as Task;
}

describe('buildResumeContext', () => {
  test('no provider session id → not resumable, with reason', async () => {
    const { resumeContext, fallbackReason } = await buildResumeContext(session({ tmuxSession: 'a' }));
    expect(resumeContext).toBeUndefined();
    expect(fallbackReason).toBe('no claudeSessionId persisted');
  });

  test('provider session id, no transcript path → resumes by id alone', async () => {
    const { resumeContext, fallbackReason } = await buildResumeContext(
      session({ tmuxSession: 'a', claudeSessionId: 'sess-1' }),
    );
    expect(resumeContext).toEqual({ sessionId: 'sess-1' });
    expect(fallbackReason).toBeUndefined();
  });

  // The agent reports transcriptPath on its own session_start hook, so a path
  // with nothing behind it means the conversation was never persisted. Resuming
  // it anyway is worse than launching fresh: `claude --resume` answers "No
  // conversation found with session ID: <id>" and exits, so the replacement
  // worker dies on startup and the task is reaped as hung.
  test('recorded transcript that is absent → not resumable, with a reason naming the path and id', async () => {
    const { resumeContext, fallbackReason } = await buildResumeContext(
      session({ tmuxSession: 'a', claudeSessionId: 'sess-1', transcriptPath: '/does/not/exist.jsonl' }),
    );
    expect(resumeContext).toBeUndefined();
    expect(fallbackReason).toContain('/does/not/exist.jsonl');
    expect(fallbackReason).toContain('sess-1');
  });

  // The inference "no file ⇒ no conversation" only holds for claude-code. The
  // opencode adapter resolves a resume against its own session database, so an
  // absent transcript path must not discard a conversation that is still there.
  test('a non-claude session with an absent transcript still resumes by id', async () => {
    const { resumeContext, fallbackReason } = await buildResumeContext(
      session({
        tmuxSession: 'a',
        agentType: 'opencode',
        claudeSessionId: 'ses_abc',
        transcriptPath: '/does/not/exist.jsonl',
      }),
    );
    // Resume is not refused, and the recorded path is passed through untouched:
    // non-claude behavior is exactly what it was before the pre-flight existed.
    expect(resumeContext).toEqual({
      sessionId: 'ses_abc',
      transcriptPath: '/does/not/exist.jsonl',
    });
    expect(fallbackReason).toBeUndefined();
  });

  test('existing transcript path is preserved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'resume-ctx-'));
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '{}');
    try {
      const { resumeContext } = await buildResumeContext(
        session({ tmuxSession: 'a', claudeSessionId: 'sess-1', transcriptPath }),
      );
      expect(resumeContext).toEqual({ sessionId: 'sess-1', transcriptPath });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('pickResumableSession / hasResumableSession', () => {
  test('returns the newest session carrying a provider session id', () => {
    const task = taskWith([
      session({ tmuxSession: 'old', claudeSessionId: 'sess-old' }),
      session({ tmuxSession: 'mid' }), // no provider id (e.g. died before SessionStart)
      session({ tmuxSession: 'new', claudeSessionId: 'sess-new' }),
    ]);
    expect(pickResumableSession(task)?.tmuxSession).toBe('new');
    expect(hasResumableSession(task)).toBe(true);
  });

  test('a task whose newest session has an id, older ones not, still picks the newest id', () => {
    const task = taskWith([
      session({ tmuxSession: 'a', claudeSessionId: 'sess-a' }),
      session({ tmuxSession: 'b' }),
    ]);
    // Newest WITH an id, scanning back from the end.
    expect(pickResumableSession(task)?.tmuxSession).toBe('a');
  });

  test('no session with a provider id → not resumable', () => {
    const task = taskWith([session({ tmuxSession: 'a' }), session({ tmuxSession: 'b' })]);
    expect(pickResumableSession(task)).toBeUndefined();
    expect(hasResumableSession(task)).toBe(false);
  });

  test('empty session list → not resumable', () => {
    expect(hasResumableSession(taskWith([]))).toBe(false);
  });
});

describe('buildTaskResumeContext', () => {
  test('builds a context from the newest recoverable session', async () => {
    const task = taskWith([
      session({ tmuxSession: 'old', claudeSessionId: 'sess-old' }),
      session({ tmuxSession: 'new', claudeSessionId: 'sess-new' }),
    ]);
    const { resumeContext, fallbackReason } = await buildTaskResumeContext(task);
    expect(resumeContext).toEqual({ sessionId: 'sess-new' });
    expect(fallbackReason).toBeUndefined();
  });

  test('no session carries a conversation id → no context, and a reason saying so', async () => {
    const { resumeContext, fallbackReason } = await buildTaskResumeContext(
      taskWith([session({ tmuxSession: 'a' })]),
    );
    expect(resumeContext).toBeUndefined();
    expect(fallbackReason).toBe('no session carries a provider conversation id');
  });

  // Regression guard for the reopen path: the newest session looks resumable by
  // id, so hasResumableSession() says yes and reopenTask arms resume — but the
  // conversation is not on disk. The caller must get a reason, not a context.
  test('newest session has an id but no transcript on disk → reason, not a doomed context', async () => {
    const { resumeContext, fallbackReason } = await buildTaskResumeContext(
      taskWith([
        session({ tmuxSession: 'a', claudeSessionId: 'sess-ghost', transcriptPath: '/nope/ghost.jsonl' }),
      ]),
    );
    expect(resumeContext).toBeUndefined();
    expect(fallbackReason).toContain('ghost.jsonl');
  });
});
