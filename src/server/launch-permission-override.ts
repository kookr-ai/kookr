import type { Task } from '../core/tasks.js';

/**
 * The adapter option that carries a task's own permission choice (issue #3686).
 *
 * Lucy's launch (issue #3676) can run a task with permission prompts forced on or all permissions
 * bypassed, whatever the install default is, and records that choice as
 * `metadata.launchPermissionOverride`. Every later session of the same task (promotion of a parked
 * launch, crash-recovery resume, a Ralph iteration) must start with the same choice, so a task
 * launched at Careful never comes back bypassed. Without a recorded choice this returns `{}` and
 * the adapter keeps the install default, exactly as before.
 */
export function launchPermissionOverrideOption(task: Pick<Task, 'metadata'>): { bypassPermissions?: boolean } {
  const override = task.metadata?.launchPermissionOverride;
  return override === undefined ? {} : { bypassPermissions: override === 'bypass' };
}

/**
 * The permission choice an operator relaunch starts with (issue #3697).
 *
 * A relaunch (the dashboard's Relaunch, the WS `relaunch` message, a launch carrying
 * `parentTaskId` with `userInitiatedRelaunch`) creates a new task, which would otherwise get the
 * install default: on an install that bypasses permissions, relaunching a Careful task would run
 * it bypassed. So when the caller set no choice of its own and the parent task was launched with
 * prompts forced on, the relaunch keeps prompts on too.
 *
 * Only `prompt` is inherited, never `bypass`: `parentTaskId` and the prompt come from the client,
 * so inheriting `bypass` would let a client get every permission bypassed for a prompt of its own.
 */
export function relaunchPermissionOverride(
  opts: { parentTaskId?: string; userInitiatedRelaunch?: boolean },
  bypassPermissions: boolean | undefined,
  getTask: (id: string) => Pick<Task, 'metadata'> | undefined,
): boolean | undefined {
  if (bypassPermissions !== undefined) return bypassPermissions;
  if (opts.userInitiatedRelaunch !== true || !opts.parentTaskId) return undefined;
  return getTask(opts.parentTaskId)?.metadata?.launchPermissionOverride === 'prompt' ? false : undefined;
}
