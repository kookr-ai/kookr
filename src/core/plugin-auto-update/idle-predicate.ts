/**
 * Idle predicate for fleet-aware auto-update (RFC Layer 4 / R6).
 *
 * "Idle for plugin P" = there is NO non-terminal task that depends on P. A task
 * depends on P when either:
 *   - its loadout is unknown/unrecorded (conservative: it counts as depending on
 *     EVERYTHING — we cannot prove it is safe to mutate P underneath it), OR
 *   - its recorded loadout INCLUDES P (P is in the bypass allowlist, or
 *     explicitly enabled in the normal-mode overrides).
 *
 * A recorded loadout that explicitly disables P, or simply does not mention P,
 * does NOT depend on P (the agent is not running with P), so it never blocks P's
 * update.
 *
 * Pure and dependency-free so it is unit-testable without a TaskStore. The
 * caller supplies a minimal per-task view; terminality is part of the view so
 * the "non-terminal" half of the rule is testable too.
 */
import type { TaskLoadoutRecord } from '../../shared/contracts/plugins.js';

/** The minimal per-task view the idle predicate reads. */
export interface IdlePredicateTaskView {
  id: string;
  /** A terminal task cannot be using the plugin — it never blocks an update. */
  isTerminal: boolean;
  /**
   * The loadout recorded at the task's first spawn, or `undefined` when none was
   * recorded (feature off, nothing attached, or not yet spawned). `undefined`
   * ⇒ depends on everything (conservative).
   */
  loadout: TaskLoadoutRecord | undefined;
}

/**
 * Whether a recorded loadout INCLUDES a plugin (i.e. the task runs with it
 * enabled). True when the bypass allowlist (`enabledSet`) contains the id, or
 * the normal-mode override enables it. An explicit `false`, or an absent id, is
 * NOT included. Pure — exported for tests.
 */
export function loadoutIncludesPlugin(loadout: TaskLoadoutRecord, pluginId: string): boolean {
  const resolved = loadout.resolved;
  if (resolved.enabledSet?.includes(pluginId)) return true;
  return resolved.enabledOverrides[pluginId] === true;
}

/**
 * The ids of the non-terminal tasks that depend on `pluginId` (busy holders).
 * Empty ⇒ the plugin is idle. Sorted for stable audit output. Pure.
 */
export function busyTasksForPlugin(
  pluginId: string,
  tasks: readonly IdlePredicateTaskView[],
): string[] {
  const busy: string[] = [];
  for (const task of tasks) {
    if (task.isTerminal) continue;
    // Unknown loadout ⇒ depends on everything (conservative).
    if (task.loadout === undefined) {
      busy.push(task.id);
      continue;
    }
    if (loadoutIncludesPlugin(task.loadout, pluginId)) busy.push(task.id);
  }
  return busy.sort();
}

/** True when no non-terminal task depends on `pluginId`. Pure. */
export function isPluginIdle(
  pluginId: string,
  tasks: readonly IdlePredicateTaskView[],
): boolean {
  return busyTasksForPlugin(pluginId, tasks).length === 0;
}
