/**
 * Where Claude Code writes a subagent's transcript, worked out from the parent
 * session's transcript path and the subagent id carried by the SubagentStart hook.
 *
 * Claude Code stores a session at `<project>/<session-id>.jsonl` and each of its
 * subagents at `<project>/<session-id>/subagents/agent-<agent-id>.jsonl`. The
 * SubagentStop hook reports that path itself, but only when the subagent ends.
 * Knowing it at the start lets the token tracker follow a subagent while it
 * runs, so its tokens are counted as they are spent instead of all at once when
 * it finishes.
 *
 * This is a best guess, not a contract. Agents started by a workflow live one
 * level deeper (`subagents/workflows/<run>/agent-<id>.jsonl`), so for them the
 * guessed file never appears; the caller must treat a missing file as normal
 * and still register the path SubagentStop reports.
 */

const TRANSCRIPT_EXTENSION = '.jsonl';
/** Agent ids are short hex-like tokens. Anything else is refused, so a hook payload cannot name another path. */
const SAFE_AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function deriveSubagentTranscriptPath(
  parentTranscriptPath: string | undefined | null,
  agentId: string | undefined | null,
): string | null {
  if (!parentTranscriptPath || !agentId) return null;
  if (!parentTranscriptPath.endsWith(TRANSCRIPT_EXTENSION)) return null;
  if (!SAFE_AGENT_ID.test(agentId)) return null;
  const sessionDir = parentTranscriptPath.slice(0, -TRANSCRIPT_EXTENSION.length);
  if (sessionDir === '' || sessionDir.endsWith('/')) return null;
  return `${sessionDir}/subagents/agent-${agentId}${TRANSCRIPT_EXTENSION}`;
}
