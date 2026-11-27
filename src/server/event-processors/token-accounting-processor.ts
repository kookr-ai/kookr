import type { Task } from '../../core/tasks.js';
import type { AgentEvent } from '../../core/types.js';
import { deriveSubagentTranscriptPath } from '../../core/subagent-transcript-path.js';

type TokenOwnerTask = Pick<Task, 'id' | 'agentType'>;

interface TaskSessionLookup {
  findTaskBySession(tmuxName: string): TokenOwnerTask | null | undefined;
}

interface TranscriptRegistry {
  register(transcriptPath: string, taskId: string): void;
  /** Stop tracking one transcript. Optional so narrow test doubles keep working. */
  unregister?(transcriptPath: string): void;
}

/**
 * Running subagents whose transcript path was guessed at SubagentStart. Bounded:
 * an entry leaves at SubagentStop, and a lost stop is evicted oldest-first.
 */
const MAX_GUESSED_SUBAGENT_PATHS = 2_000;

export interface TokenAccountingProcessorDeps {
  taskLookup: TaskSessionLookup;
  transcriptRegistry: TranscriptRegistry;
}

export interface TokenAccountingEvent {
  tmuxName: string;
  event: AgentEvent;
}

export interface TokenAccountingProcessor {
  process(input: TokenAccountingEvent): void;
}

export function createTokenAccountingProcessor({
  taskLookup,
  transcriptRegistry,
}: TokenAccountingProcessorDeps): TokenAccountingProcessor {
  // Pending transcript registrations: if session_start arrives before the task
  // is findable (race between hook event and task creation), retry on next event.
  const pendingTranscriptRegistrations = new Map<string, string>();

  // The shared TokenTracker parses the Claude Code transcript schema
  // (`message.usage` with `input_tokens`/`output_tokens`/…). Grok Build writes a
  // different JSONL schema and is metered by its own adapter at stop time
  // (issue #1581); registering a Grok transcript here would only yield phantom
  // all-zero usage (empty Claude-format buckets), which the periodic/stop token
  // scans then write over the adapter's real counts. Skip non-Claude transcripts.
  const registerClaudeTranscript = (task: TokenOwnerTask, transcriptPath: string): void => {
    // opencode hook payloads carry no token counts; its usage is read from the per-session
    // opencode DB by the adapter on stop (opencode-usage-scanner), so skip it here.
    if (task.agentType === 'grok-build' || task.agentType === 'opencode') return;
    transcriptRegistry.register(transcriptPath, task.id);
  };

  // `${tmuxName}\u0000${agentId}` -> the transcript path guessed at SubagentStart.
  const guessedSubagentPaths = new Map<string, string>();
  const subagentKey = (tmuxName: string, agentId: string): string => `${tmuxName}\u0000${agentId}`;

  return {
    process({ tmuxName, event }) {
      // Token tracking runs for ALL parentages: a cross-session child writing to
      // the same Kookr hook file still has tokens that should roll up to the
      // parent task. The token tracker is path-keyed, so a child SessionStart
      // with a distinct transcriptPath registers a separate transcript that
      // findTaskBySession associates with the parent task. See
      // rfc-activity-log-reliability §3.
      if (event.type === 'session_start' && event.transcriptPath) {
        const task = taskLookup.findTaskBySession(tmuxName);
        if (task) {
          registerClaudeTranscript(task, event.transcriptPath);
        } else {
          pendingTranscriptRegistrations.set(tmuxName, event.transcriptPath);
        }
      }

      // Follow a subagent from its start, so its tokens are counted while it
      // runs. SubagentStop is the only hook that reports the subagent's own
      // transcript path, and waiting for it added a whole subagent's tokens to
      // the parent task in one step when it finished (one measured stop: 41,925
      // output tokens at once), which made the live token rate and the task's
      // live cost jump. The path is worked out from the parent session's
      // transcript; the file may not exist yet, or ever (see
      // `deriveSubagentTranscriptPath`), and the tracker treats that as empty.
      if (event.type === 'subagent_start') {
        const guessed = deriveSubagentTranscriptPath(event.transcriptPath, event.agentId);
        const parentTask = guessed ? taskLookup.findTaskBySession(tmuxName) : null;
        if (guessed && parentTask) {
          registerClaudeTranscript(parentTask, guessed);
          if (guessedSubagentPaths.size >= MAX_GUESSED_SUBAGENT_PATHS) {
            const oldest = guessedSubagentPaths.keys().next().value;
            if (oldest !== undefined) guessedSubagentPaths.delete(oldest);
          }
          guessedSubagentPaths.set(subagentKey(tmuxName, event.agentId), guessed);
        }
      }

      // Register subagent transcripts so their tokens are summed into the parent
      // task (rfc-cost-comparison-panel.md R13). `tokenTracker.register` is
      // idempotent on path, so multiple SubagentStop events for the same
      // isSidechain transcript, or a path already registered at SubagentStart,
      // do not double-count.
      if (event.type === 'subagent_stop') {
        const key = subagentKey(tmuxName, event.agentId);
        const guessed = guessedSubagentPaths.get(key);
        guessedSubagentPaths.delete(key);
        if (event.agentTranscriptPath) {
          // The guess was wrong (for example a workflow agent, stored one level
          // deeper): stop watching a file that will never exist.
          if (guessed && guessed !== event.agentTranscriptPath) {
            transcriptRegistry.unregister?.(guessed);
          }
          const parentTask = taskLookup.findTaskBySession(tmuxName);
          if (parentTask) {
            registerClaudeTranscript(parentTask, event.agentTranscriptPath);
          }
        }
      }

      // Retry pending registration on any subsequent event.
      if (pendingTranscriptRegistrations.has(tmuxName)) {
        const task = taskLookup.findTaskBySession(tmuxName);
        if (task) {
          registerClaudeTranscript(task, pendingTranscriptRegistrations.get(tmuxName)!);
          pendingTranscriptRegistrations.delete(tmuxName);
        }
      }
    },
  };
}
