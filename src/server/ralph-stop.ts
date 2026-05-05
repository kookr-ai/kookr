import { createHash } from 'node:crypto';
import type { AgentEvent } from '../core/types.js';
import type { Task } from '../core/tasks.js';

function isStopEvent(event: AgentEvent): event is Extract<AgentEvent, { type: 'stop' | 'stop_failure' }> {
  return event.type === 'stop' || event.type === 'stop_failure';
}

export function isStopFromMainTaskSession(
  task: Task,
  terminalSessionId: string,
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'stop' | 'stop_failure' }> {
  if (!isStopEvent(event)) return false;
  const loop = task.ralphLoop;
  if (!loop) return false;
  if (!loop.ownerSessionId || terminalSessionId !== loop.ownerSessionId) return false;
  if (!loop.ownerRuntimeSessionId || event.sessionId !== loop.ownerRuntimeSessionId) return false;
  if (loop.ownerTranscriptPath && event.transcriptPath && event.transcriptPath !== loop.ownerTranscriptPath) {
    return false;
  }

  const session = task.sessions.find((s) => s.tmuxSession === terminalSessionId);
  if (!session) return false;

  return true;
}

export function ralphStopFingerprint(
  terminalSessionId: string,
  events: AgentEvent[],
  event: Extract<AgentEvent, { type: 'stop' | 'stop_failure' }>,
): string {
  const eventIndex = events.lastIndexOf(event);
  const stopIndex = eventIndex >= 0 ? eventIndex : Math.max(0, events.length - 1);
  const source = event.turnId
    ? `turn:${event.turnId}`
    : event.hookLineId
      ? `hook-line:${event.hookLineId}`
      : `window-index:${stopIndex}`;
  const digest = createHash('sha256')
    .update(event.type)
    .update('\0')
    .update(event.sessionId)
    .update('\0')
    .update(event.lastMessage)
    .digest('hex');
  return `${terminalSessionId}:${source}:${digest}`;
}
