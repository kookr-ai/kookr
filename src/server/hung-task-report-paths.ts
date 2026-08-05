/**
 * Canonical on-disk naming for hung-task reap reports, shared by the writer
 * (`hung-task-reaper`) and the delete-time sweeper
 * (`TaskLifecycleCommands.gcHungTaskReports`) so the two can never drift. A
 * report lives at `<reportsDir>/hung-task-<taskId>-<slug>.md` (written directly,
 * no tmp+rename). Keeping the
 * convention in one place means a change to the filename shape updates the
 * sweeper's match in lockstep, instead of silently orphaning reports (issue
 * #2126).
 */

/**
 * Filename prefix for a task's reap reports: `hung-task-<taskId>-`. The
 * trailing `-` is a hard id boundary — matching on this prefix can never sweep
 * the reports of a different task whose id merely starts with `taskId`.
 */
export function hungTaskReportPrefix(taskId: string): string {
  return `hung-task-${taskId}-`;
}

/** Basename of a single reap report: `hung-task-<taskId>-<slug>.md`. */
export function hungTaskReportBasename(taskId: string, slug: string): string {
  return `${hungTaskReportPrefix(taskId)}${slug}.md`;
}
