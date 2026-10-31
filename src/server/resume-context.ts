/**
 * Shared helpers for resuming a provider conversation when a task's terminal
 * (process) has died but its conversation is still recoverable.
 *
 * "Terminal/process liveness is not the same thing as conversation
 * recoverability." (docs/rfc/rfc-restore-lost-agent-sessions.md) Kookr persists
 * the parent provider conversation id (`claudeSessionId`) and the transcript
 * path on each session. When those are present, a replacement worker can be
 * launched with `adapter.launch(..., resumeContext)` so the agent continues the
 * existing conversation (`claude --resume <id> --fork-session`) instead of
 * starting over from the initial prompt.
 *
 * Two callers share this logic:
 *  - crash recovery (automatic, on boot — see crash-recovery.ts), and
 *  - user-initiated reopen (manual, from the dashboard — see
 *    task-lifecycle-commands.ts + agent-lifecycle.ts promotion).
 *
 * Adapters that do not yet support resume (Codex CLI, Grok Build) ignore the
 * `ResumeContext` and launch fresh with a warning, so passing a context is
 * always safe.
 */
import { access } from 'node:fs/promises';
import type { SessionInfo, Task } from '../core/tasks.js';
import type { ResumeContext } from '../adapters/agent-adapter.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether the given session is resumable, and if so build a
 * {@link ResumeContext} to hand to `adapter.launch()`. Returns `undefined`
 * context with a `fallbackReason` when resume is not applicable, so the caller
 * can surface the reason.
 *
 * Performs a best-effort transcript-existence pre-flight. A stale transcript
 * path must not force a fresh launch when the provider session id is still
 * known: Claude Code can validate the id itself, and preserving the
 * conversation is more important than trusting Kookr's cached path.
 */
export async function buildResumeContext(
  session: SessionInfo,
): Promise<{ resumeContext: ResumeContext | undefined; fallbackReason: string | undefined }> {
  if (!session.claudeSessionId) {
    return { resumeContext: undefined, fallbackReason: 'no claudeSessionId persisted' };
  }
  if (session.transcriptPath && !(await fileExists(session.transcriptPath))) {
    return {
      resumeContext: { sessionId: session.claudeSessionId },
      fallbackReason: undefined,
    };
  }
  return {
    resumeContext: {
      sessionId: session.claudeSessionId,
      ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
    },
    fallbackReason: undefined,
  };
}

/**
 * The newest session on this task whose provider conversation is recoverable —
 * i.e. it carries a persisted `claudeSessionId` and has not already been
 * replaced by a later resumed session. Sessions are appended in launch order,
 * so the last match is the most recent conversation to continue from.
 *
 * Returns `undefined` when the task has never produced a resumable provider
 * conversation (e.g. a brand-new task, or one that died before the agent
 * emitted SessionStart), in which case the caller should launch fresh.
 */
export function pickResumableSession(task: Task): SessionInfo | undefined {
  for (let i = task.sessions.length - 1; i >= 0; i--) {
    const session = task.sessions[i];
    if (session && session.claudeSessionId) return session;
  }
  return undefined;
}

/** True when the task has at least one session with a recoverable conversation. */
export function hasResumableSession(task: Task): boolean {
  return pickResumableSession(task) !== undefined;
}

/**
 * Build the resume context for a task's newest recoverable session, or
 * `undefined` when none is resumable. Convenience wrapper over
 * {@link pickResumableSession} + {@link buildResumeContext} for the
 * reopen/relaunch path.
 */
export async function buildTaskResumeContext(task: Task): Promise<ResumeContext | undefined> {
  const session = pickResumableSession(task);
  if (!session) return undefined;
  const { resumeContext } = await buildResumeContext(session);
  return resumeContext;
}
