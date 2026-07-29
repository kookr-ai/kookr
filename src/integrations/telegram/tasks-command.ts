/**
 * `/tasks` remote read-back command (issue #1394).
 *
 * After `/task` spawns work the only Telegram feedback was the spawn
 * confirmation — to learn whether an agent is blocked/waiting/done the
 * operator had to open the web dashboard. `/tasks` closes that gap: it reads
 * the server's `GET /api/tasks?view=compact` listing and replies with a
 * compact, length-bounded, secret-redacted summary of the active tasks and
 * each task's most-relevant blocker.
 *
 * The parse/format/fetch pieces are separated so the format path is unit
 * testable against a fake task list without any network or bot plumbing.
 */

import { redactCredentials } from './redact.js';

/** Hard ceiling on the reply body. Telegram's own limit is 4096 chars; we
 * stay well under it so the redactor and truncation notice always fit. */
export const TASKS_REPLY_MAX_CHARS = 3500;

/** Max active-task rows rendered before the reply is capped with a "+N more". */
export const TASKS_REPLY_MAX_ROWS = 20;

/**
 * The subset of `GET /api/tasks?view=compact` rows the `/tasks` summary reads.
 * Mirrors the compact API projection (`toCompactApiTask` + `attachStuckReason`
 * in `src/server/routes/task-routes.ts`): `stuckReason` is the per-row "why is
 * this occupying a slot" signal, `pendingSignal.kind` is the agent's own last
 * signal, and `blocked_by` are declared dependency edges.
 */
export interface TaskSummaryRow {
  id: string;
  name?: string;
  status: string;
  stuckReason?: string;
  pendingSignal?: { kind?: string } | null;
  blocked_by?: Array<{ taskId?: string } | string> | null;
}

/**
 * Statuses that count as "active" for the read-back — non-terminal work the
 * operator might be waiting on. Terminal statuses (completed, terminated,
 * cancelled) are excluded so the reply stays focused on live work.
 */
const ACTIVE_STATUSES = new Set(['open', 'pending', 'inProgress']);

/**
 * Recognize `/tasks`, including the `@botname` suffix Telegram appends in
 * groups (e.g. `/tasks@kookr_core_bot`). Trailing whitespace is tolerated so
 * `/tasks ` still matches; any non-whitespace argument does not (the command
 * takes no arguments).
 */
export function isTasksCommand(text: string): boolean {
  return /^\/tasks(@\w+)?\s*$/.test(text);
}

/**
 * Human-readable one-liner for a task's most-relevant blocker. Precedence is
 * most-severe/actionable first: an explicit `stuckReason` (permission blocked,
 * awaiting ack, hung, waiting on input) beats the agent's own `pendingSignal`,
 * which beats a declared `blocked_by` dependency. Returns null when the task
 * has no blocker signal — a plain running task.
 */
export function describeBlocker(row: TaskSummaryRow): string | null {
  if (row.stuckReason) {
    switch (row.stuckReason) {
      case 'permission_blocked':
        return 'blocked on permission';
      case 'awaiting_completion_ack':
        return 'awaiting completion ack';
      case 'hung_suspect':
        return 'possibly hung';
      case 'waiting_on_input':
        return 'waiting on input';
      default:
        return `blocked (${row.stuckReason})`;
    }
  }
  if (row.pendingSignal?.kind) {
    return `signal: ${row.pendingSignal.kind}`;
  }
  const blockers = (row.blocked_by ?? [])
    .map((edge) => (typeof edge === 'string' ? edge : edge?.taskId))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (blockers.length > 0) {
    return `blocked by ${blockers.map((id) => id.slice(0, 8)).join(', ')}`;
  }
  return null;
}

/** Short task id for the reply — full UUIDs are noise on a phone. */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Format the active-task read-back. Enumerates each active task's short id,
 * name, status, and most-relevant blocker; caps the row count with a "+N more"
 * line; runs the whole body through the secret redactor; and hard-truncates to
 * {@link TASKS_REPLY_MAX_CHARS}. A no-active-tasks state returns a clear
 * message rather than an empty reply.
 */
export function formatTasksReply(rows: TaskSummaryRow[]): string {
  const active = rows.filter((r) => ACTIVE_STATUSES.has(r.status));
  if (active.length === 0) {
    return 'No active tasks.';
  }

  const shown = active.slice(0, TASKS_REPLY_MAX_ROWS);
  const lines = shown.map((r) => {
    const name = r.name && r.name.trim().length > 0 ? r.name.trim() : '(unnamed)';
    const blocker = describeBlocker(r);
    const blockerSuffix = blocker ? ` — ${blocker}` : '';
    return `• ${shortId(r.id)} [${r.status}] ${name}${blockerSuffix}`;
  });

  const header = `Active tasks (${active.length}):`;
  const overflow = active.length > shown.length ? [`…and ${active.length - shown.length} more`] : [];
  const body = [header, ...lines, ...overflow].join('\n');

  // Redact BEFORE truncating so a credential-shaped task name past the char
  // limit can't slip the redactor (same ordering as the block-alert path).
  const redacted = redactCredentials(body);
  return redacted.length > TASKS_REPLY_MAX_CHARS
    ? redacted.slice(0, TASKS_REPLY_MAX_CHARS - 1) + '…'
    : redacted;
}

/**
 * Default production fetcher: GET `${baseUrl}/api/tasks?view=compact` and map
 * the rows to {@link TaskSummaryRow}. Never throws for a reachable-but-empty
 * server; a network/HTTP failure rejects so the caller can reply with an
 * error instead of a false "no tasks" state.
 */
export async function fetchTasksSummary(baseUrl: string): Promise<TaskSummaryRow[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/tasks?view=compact`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`GET /api/tasks returned HTTP ${res.status}`);
  }
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) {
    throw new Error('GET /api/tasks did not return an array');
  }
  return json.map((raw) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    return {
      id: String(t.id ?? t.taskId ?? ''),
      name: typeof t.name === 'string' ? t.name : undefined,
      status: String(t.status ?? ''),
      stuckReason: typeof t.stuckReason === 'string' ? t.stuckReason : undefined,
      pendingSignal:
        t.pendingSignal && typeof t.pendingSignal === 'object'
          ? { kind: (t.pendingSignal as { kind?: unknown }).kind as string | undefined }
          : null,
      blocked_by: Array.isArray(t.blocked_by) ? (t.blocked_by as TaskSummaryRow['blocked_by']) : null,
    } satisfies TaskSummaryRow;
  });
}
