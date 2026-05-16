import type { SessionInfo, Task } from '../../core/tasks.js';

type SessionActivityTask = Pick<Task, 'sessions'> & {
  sessions: Pick<SessionInfo, 'tmuxSession' | 'lastEventAt'>[];
};

interface SessionActivityTaskLookup {
  findTaskBySession(tmuxName: string): SessionActivityTask | null | undefined;
}

export interface SessionActivityProcessorDeps {
  taskLookup: SessionActivityTaskLookup;
  now?: () => number;
}

export interface SessionActivityProcessor {
  process(tmuxName: string): void;
}

export function createSessionActivityProcessor({
  taskLookup,
  now = Date.now,
}: SessionActivityProcessorDeps): SessionActivityProcessor {
  return {
    process(tmuxName) {
      // Persist lastEventAt in session metadata for watchdog restart recovery.
      const ownerTask = taskLookup.findTaskBySession(tmuxName);
      if (!ownerTask) return;
      const session = ownerTask.sessions.find((s) => s.tmuxSession === tmuxName);
      if (session) session.lastEventAt = now();
    },
  };
}
