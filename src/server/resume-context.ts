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
 * Performs a transcript-existence pre-flight, and treats a recorded-but-absent
 * transcript as NOT resumable.
 *
 * That pre-flight is load-bearing rather than advisory, because `transcriptPath`
 * is not a path Kookr guesses: the agent reports it on its `session_start` hook,
 * so it is the provider's own answer for where this conversation lives. If the
 * agent named a path and nothing is there, the conversation was never persisted
 * (for example a session spawned with transcript saving suppressed) or has since
 * been deleted — either way there is nothing to resume.
 *
 * Handing such an id to the adapter anyway does not degrade gracefully. Claude
 * Code answers `No conversation found with session ID: <id>` and exits
 * immediately, so the replacement worker dies on startup and the task is reaped
 * as hung instead of being recovered. Reporting a `fallbackReason` here lets the
 * caller launch fresh from the original prompt, which at least runs.
 *
 * A session that never recorded a `transcriptPath` at all is still resumed by id
 * alone: there is no evidence against it, and the id may well be valid.
 *
 * Scoped to `claude-code`, because the inference only holds where a local
 * transcript file *is* the conversation. The opencode adapter also consumes a
 * `ResumeContext` (`opencode --session <ses_id>`) but resolves it against its own
 * per-task session database, with its own guard for a database it cannot read —
 * so an absent transcript path says nothing about whether that conversation is
 * recoverable, and refusing resume there would discard a live conversation.
 */
export async function buildResumeContext(
  session: SessionInfo,
): Promise<{ resumeContext: ResumeContext | undefined; fallbackReason: string | undefined }> {
  if (!session.claudeSessionId) {
    return { resumeContext: undefined, fallbackReason: 'no claudeSessionId persisted' };
  }
  if (
    session.agentType === 'claude-code' &&
    session.transcriptPath &&
    !(await fileExists(session.transcriptPath))
  ) {
    return {
      resumeContext: undefined,
      fallbackReason: `transcript missing at ${session.transcriptPath} — conversation ${session.claudeSessionId} was never persisted or has been deleted`,
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
 * Build the resume context for a task's newest recoverable session. Convenience
 * wrapper over {@link pickResumableSession} + {@link buildResumeContext} for the
 * reopen/relaunch path.
 *
 * Returns the `fallbackReason` alongside the context so the caller can say why a
 * reopen that the operator expected to resume launched fresh instead. An
 * operator who presses Reopen and silently gets a blank restart has no way to
 * tell that apart from a resume that worked, which is exactly the confusion this
 * path exists to remove.
 */
export async function buildTaskResumeContext(
  task: Task,
): Promise<{ resumeContext: ResumeContext | undefined; fallbackReason: string | undefined }> {
  const session = pickResumableSession(task);
  if (!session) {
    return { resumeContext: undefined, fallbackReason: 'no session carries a provider conversation id' };
  }
  return buildResumeContext(session);
}
