import type { Task } from '../core/task-read-model.js';
import { isTerminalStatus } from '../core/task-status.js';

/** A transcript that should be registered with the token tracker at boot. */
export interface BootTranscriptRegistration {
  transcriptPath: string;
  taskId: string;
}

/**
 * Decide which persisted-task transcripts to register with the token tracker at
 * boot (issue #1620, change a).
 *
 * Historically the boot loop registered `session.transcriptPath` for EVERY
 * session of EVERY persisted task. On a long-lived prod host that meant the
 * token tracker re-scanned 100+ transcripts every 5s — including 10-day-old
 * terminal tasks and multi-hundred-MB Codex rollout files — which was the
 * dominant RSS allocation-churn driver.
 *
 * Two filters keep boot registration aligned with the event-path
 * (token-accounting-processor) behavior:
 *  - **Non-terminal tasks only.** A completed / terminated / cancelled task will
 *    never grow again, so there is nothing to re-scan.
 *  - **Claude Code transcripts only.** The token tracker parses Claude Code
 *    JSONL; Codex / Grok sessions are metered elsewhere and their rollout files
 *    are a different (and often huge) format. The event path only ever
 *    registers Claude `session_start` transcripts, so boot must match. A
 *    missing `agentType` is treated as Claude Code (the historical default) to
 *    avoid dropping legitimate older sessions.
 */
export function collectBootTranscriptRegistrations(tasks: Task[]): BootTranscriptRegistration[] {
  const registrations: BootTranscriptRegistration[] = [];
  for (const task of tasks) {
    if (isTerminalStatus(task.status)) continue;
    for (const session of task.sessions) {
      if (session.agentType && session.agentType !== 'claude-code') continue;
      if (!session.transcriptPath) continue;
      registrations.push({ transcriptPath: session.transcriptPath, taskId: task.id });
    }
  }
  return registrations;
}
