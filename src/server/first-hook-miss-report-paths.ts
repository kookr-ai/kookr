/**
 * Canonical on-disk naming for first-hook-miss reap reports, shared by the
 * writer (`first-hook-deadline-sweep`) and the delete-time sweeper
 * (`TaskLifecycleCommands.gcFirstHookMissReports`) so the two can never drift.
 * A report lives at `<reportsDir>/first-hook-miss-<taskId>-<slug>.md` (written
 * directly, no tmp+rename). Keeping the convention in one place means a change
 * to the filename shape updates the sweeper's match in lockstep, instead of
 * silently orphaning reports (issue #2227).
 */

/**
 * Filename prefix for a task's first-hook-miss reports: `first-hook-miss-<taskId>-`.
 * The trailing `-` is a hard id boundary — matching on this prefix can never
 * sweep the reports of a different task whose id merely starts with `taskId`.
 */
export function firstHookMissReportPrefix(taskId: string): string {
  return `first-hook-miss-${taskId}-`;
}

/** Basename of a single first-hook-miss report: `first-hook-miss-<taskId>-<slug>.md`. */
export function firstHookMissReportBasename(taskId: string, slug: string): string {
  return `${firstHookMissReportPrefix(taskId)}${slug}.md`;
}
