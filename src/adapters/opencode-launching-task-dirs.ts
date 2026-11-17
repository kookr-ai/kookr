/**
 * Per-task opencode data dirs that a launch is using right now, shared by every opencode adapter in this process.
 *
 * The host TUI adapter and the container adapter keep their task data under the same root, but only the host adapter
 * runs the retention sweep, and it only knows about its own sessions. A container launch marks its task dir here, so
 * the sweep's "is this task active?" check sees that launch too (#4085). Keyed by the task dir path, like the sweep's
 * task-dir lock in opencode-task-data.ts, so two adapters over the same data root always agree.
 *
 * The protocol is the host adapter's own: a launch marks its dir first, then waits for `waitForTaskDirUnlocked`. A
 * removal that has not yet made its active check sees the mark and skips the dir; one already past it is waited for.
 */
const launching = new Map<string, number>();

/** Mark `dir` as used by a launch. The returned release is idempotent; a dir stays marked while any launch holds it. */
export function markTaskDirLaunching(dir: string): () => void {
  launching.set(dir, (launching.get(dir) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (launching.get(dir) ?? 1) - 1;
    if (left > 0) launching.set(dir, left);
    else launching.delete(dir);
  };
}

/** True while a launch holds `dir` (see `markTaskDirLaunching`). */
export function isTaskDirLaunching(dir: string): boolean {
  return launching.has(dir);
}
