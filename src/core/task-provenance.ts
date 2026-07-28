import type { TaskLaunchSource, TaskProvenance } from '../shared/contracts/task.js';

/**
 * The launch signals available at task-creation time from which provenance is
 * derived (issue #1583). All optional: a bare `createTask` with none of them
 * yields `unknown` provenance.
 */
export interface TaskProvenanceInputs {
  /** Set when this task was spawned by another task. */
  parentTaskId?: string;
  /** Where the launch originated, when the caller declared one. */
  launchSource?: TaskLaunchSource;
  /** Set only for `launchSource === 'schedule'` fires. */
  scheduleId?: string;
}

/** Explicit fallback provenance for legacy/unknown creations (issue #1583). */
export const UNKNOWN_PROVENANCE: TaskProvenance = { kind: 'unknown' };

/**
 * Derive a task's immutable launch provenance (issue #1583) from the signals
 * present at creation. Precedence is deliberate:
 *
 *  1. `parentTaskId` wins. A child spawn — including the
 *     `kookr-spawn-child-task` HTTP path — carries BOTH a parent id and
 *     `launchSource: 'api'`; parent provenance is the more specific origin, so
 *     the rollup attributes the child to its parent rather than to `api`.
 *  2. `schedule` launches map to `{ kind: 'schedule', sourceId: scheduleId }`.
 *  3. Any other declared `launchSource` (api/ui/cli/websocket/remote-*) is a
 *     `manual` creation; its `sourceId` is the launcher identity.
 *  4. No signal at all ⇒ explicit `unknown` (never an omitted field).
 */
export function deriveTaskProvenance(inputs: TaskProvenanceInputs): TaskProvenance {
  const { parentTaskId, launchSource, scheduleId } = inputs;
  if (parentTaskId !== undefined) {
    return { kind: 'parent', sourceId: parentTaskId };
  }
  if (launchSource === 'schedule') {
    return scheduleId !== undefined
      ? { kind: 'schedule', sourceId: scheduleId }
      : { kind: 'schedule' };
  }
  if (launchSource !== undefined) {
    return { kind: 'manual', sourceId: launchSource };
  }
  return { ...UNKNOWN_PROVENANCE };
}
