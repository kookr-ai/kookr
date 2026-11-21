import type { Task } from '../core/tasks.js';
import { selectSessionJobs, type ProcessInfo, type SessionJob } from '../core/long-running-jobs.js';

/**
 * Snapshot the worker jobs running under each task's live session (issue
 * #4237): what a reclaim would kill along with the agent. One process-table
 * read per call, and one GPU query only when some task has a job at all.
 *
 * Fail-open in the "no jobs" direction: a task whose session root cannot be
 * resolved, a missing `/proc`, or any error yields no entry, which leaves the
 * reclaim exactly as it was before this check existed.
 */
export type SessionJobSnapshotter = (tasks: readonly Task[]) => Promise<Map<string, SessionJob[]>>;

export interface SessionJobSnapshotDeps {
  /** Root pid of a session's process tree (`TerminalBackend.getSessionRootPid`). */
  getSessionRootPid: (sessionId: string) => Promise<number | null>;
  /** Whole-host process table (`readProcessTable` from `adapters/process-tree.ts`). */
  readProcessTable: () => ProcessInfo[];
  /** Pids currently using the GPU (`readGpuComputePids`); empty when unknown. */
  readGpuPids: () => Promise<ReadonlySet<number>>;
  now?: () => number;
}

/** The task's live session id: the first session not yet completed or aborted. */
export function liveSessionIdOf(task: Pick<Task, 'sessions'>): string | undefined {
  return task.sessions.find((s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted')?.tmuxSession;
}

export function createSessionJobSnapshotter(deps: SessionJobSnapshotDeps): SessionJobSnapshotter {
  return async (tasks) => {
    const out = new Map<string, SessionJob[]>();
    const roots: Array<{ taskId: string; rootPid: number }> = [];
    for (const task of tasks) {
      const sessionId = liveSessionIdOf(task);
      if (!sessionId) continue;
      try {
        const rootPid = await deps.getSessionRootPid(sessionId);
        if (rootPid !== null && rootPid > 1) roots.push({ taskId: task.id, rootPid });
      } catch {
        // Unknown root — no jobs visible for this task.
      }
    }
    if (roots.length === 0) return out;

    let table: ProcessInfo[];
    try {
      table = deps.readProcessTable();
    } catch {
      return out;
    }
    const nowMs = (deps.now ?? Date.now)();
    const withoutGpu = roots.map(({ taskId, rootPid }) => ({
      taskId,
      rootPid,
      jobs: selectSessionJobs(rootPid, table, { nowMs }),
    }));
    if (!withoutGpu.some((r) => r.jobs.length > 0)) return out;

    let gpuPids: ReadonlySet<number> = new Set();
    try {
      gpuPids = await deps.readGpuPids();
    } catch {
      gpuPids = new Set();
    }
    for (const { taskId, rootPid, jobs } of withoutGpu) {
      const final = gpuPids.size > 0 ? selectSessionJobs(rootPid, table, { nowMs, gpuPids }) : jobs;
      if (final.length > 0) out.set(taskId, final);
    }
    return out;
  };
}
