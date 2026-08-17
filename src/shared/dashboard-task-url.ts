/**
 * Single contract for dashboard task deep links (`/?task=<id>`).
 *
 * Telegram already emits this form. Finding webhooks and the dashboard copy
 * control must use the same builder so a tap / paste lands on the named task.
 */

export const DASHBOARD_TASK_QUERY = 'task';

/** Absolute dashboard URL that selects `taskId` on first paint. */
export function dashboardTaskUrl(baseUrl: string, taskId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/?${DASHBOARD_TASK_QUERY}=${encodeURIComponent(taskId)}`;
}

/**
 * Read `task` from a query string (`?task=…` or `task=…`).
 * Empty / whitespace-only values are treated as absent.
 */
export function parseDashboardTaskId(search: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const raw = params.get(DASHBOARD_TASK_QUERY);
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Drop the `task` query from a path+search+hash string, leaving other params
 * and the hash intact. Used after the first snapshot so a later refresh does
 * not re-apply a deep link over a manual selection.
 */
export function stripDashboardTaskQuery(pathSearchHash: string): string {
  const url = new URL(pathSearchHash, 'http://kookr.invalid');
  if (!url.searchParams.has(DASHBOARD_TASK_QUERY)) return pathSearchHash;
  url.searchParams.delete(DASHBOARD_TASK_QUERY);
  return `${url.pathname}${url.search}${url.hash}`;
}
