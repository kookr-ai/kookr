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
