/**
 * Shared task-reference matching for `kookr peek` and `kookr reply` (issue #4112).
 *
 * Task ids are 36-character UUIDs that people usually see and copy by their
 * first eight characters. Both commands resolve a reference against the agents
 * in `GET /api/snapshot`:
 *
 *   1. An exact `taskId` or `taskName` match wins, exactly as before.
 *   2. Otherwise, a reference of at least {@link MIN_TASK_ID_PREFIX_LENGTH}
 *      characters that is the prefix of exactly ONE task id resolves to it.
 *   3. A prefix shared by several task ids is ambiguous: the caller must fail
 *      and list them, never pick one (`kookr reply` types into a live agent).
 *
 * Terminal tasks count when checking whether a prefix is unique, so a prefix is
 * only accepted when no other listed task shares it, live or not.
 */

export const MIN_TASK_ID_PREFIX_LENGTH = 8;

export interface TaskRefAgent {
  taskId?: string;
  taskName?: string;
}

export type TaskRefMatch<T> =
  /** The ref equals a task id or task name. `agents` is non-empty. */
  | { kind: 'exact'; agents: T[] }
  /** The ref is the prefix of exactly one task id. `agents` carry that id. */
  | { kind: 'prefix'; taskId: string; agents: T[] }
  /** The ref is the prefix of several task ids (sorted). `agents` carry any of them. */
  | { kind: 'ambiguous-prefix'; taskIds: string[]; agents: T[] }
  | { kind: 'none' };

export function matchTaskRef<T extends TaskRefAgent>(agents: readonly T[], ref: string): TaskRefMatch<T> {
  const exact = agents.filter((a) => a.taskId === ref || a.taskName === ref);
  if (exact.length > 0) return { kind: 'exact', agents: exact };
  if (ref.length < MIN_TASK_ID_PREFIX_LENGTH) return { kind: 'none' };

  const prefixed = agents.filter((a) => a.taskId !== undefined && a.taskId.startsWith(ref));
  const taskIds = [...new Set(prefixed.map((a) => a.taskId as string))].sort();
  if (taskIds.length === 0) return { kind: 'none' };
  if (taskIds.length === 1) return { kind: 'prefix', taskId: taskIds[0], agents: prefixed };
  return { kind: 'ambiguous-prefix', taskIds, agents: prefixed };
}
