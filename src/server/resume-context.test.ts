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

  test('stale transcript path is dropped but the session id still resumes', async () => {
    const { resumeContext } = await buildResumeContext(
      session({ tmuxSession: 'a', claudeSessionId: 'sess-1', transcriptPath: '/does/not/exist.jsonl' }),
    );
    expect(resumeContext).toEqual({ sessionId: 'sess-1' });
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
    expect(await buildTaskResumeContext(task)).toEqual({ sessionId: 'sess-new' });
  });

  test('returns undefined when nothing is resumable', async () => {
    expect(await buildTaskResumeContext(taskWith([session({ tmuxSession: 'a' })]))).toBeUndefined();
  });
});
