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
 * Scope safety (issue #1394 Risks): the read-back is filtered to the projects
 * the Telegram user is allowed to spawn against, so an allowlisted-but-project-
 * scoped user cannot read the names/blockers of every task on the host.
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
 * signal, and `blocked_by` are declared dependency edges. `cwd` scopes the row
 * to a project (see {@link selectActiveTasks}).
 *
 * `blocked_by` uses the server's real `TaskDependencyEdge` string format
 * (`task:<id>` / `milestone:<id>`), not an object — see `contracts/task.ts`.
 */
export interface TaskSummaryRow {
  id: string;
  name?: string;
  status: string;
  cwd?: string;
  stuckReason?: string;
  pendingSignal?: { kind?: string } | null;
  blocked_by?: string[] | null;
}

/** Options for filtering the read-back — project scope (issue #1394). */
export interface TasksReplyOptions {
  /**
   * Absolute project directories the caller is allowed to see. When provided
   * (and non-empty) the read-back is restricted to tasks whose `cwd` is inside
   * one of these directories; when omitted, no project filter is applied.
   */
  allowedCwds?: string[];
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

/** Short task id for the reply — full UUIDs are noise on a phone. */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Strip the `task:` / `milestone:` prefix from a `TaskDependencyEdge`. */
function stripEdgePrefix(edge: string): string {
  return edge.replace(/^(?:task|milestone):/, '');
}

/**
 * True when `cwd` is the same as, or nested inside, one of the allowed project
 * directories. Path-boundary aware (`base` vs `base/…`) so `/a/b` does not
 * match `/a/bc`. Under-inclusive by design: a task running in a sibling
 * worktree of an allowed project is excluded, which errs toward never leaking
 * out-of-scope work rather than toward over-sharing.
 */
function isWithinAllowedProject(cwd: string | undefined, allowedCwds: string[]): boolean {
  if (!cwd) return false;
  return allowedCwds.some((base) => {
    const normalized = base.replace(/\/+$/, '');
    return cwd === normalized || cwd.startsWith(normalized + '/');
  });
}

/**
 * Select the active (non-terminal) tasks the caller may see, applying the
 * optional project-scope filter. Shared by {@link formatTasksReply} and the
 * caller's audit metric so the count the operator sees matches the count that
 * is logged.
 */
export function selectActiveTasks(rows: TaskSummaryRow[], opts: TasksReplyOptions = {}): TaskSummaryRow[] {
  const scoped =
    opts.allowedCwds && opts.allowedCwds.length > 0
      ? rows.filter((r) => isWithinAllowedProject(r.cwd, opts.allowedCwds!))
      : rows;
  return scoped.filter((r) => ACTIVE_STATUSES.has(r.status));
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
    .filter((edge): edge is string => typeof edge === 'string' && edge.length > 0)
    .map((edge) => shortId(stripEdgePrefix(edge)));
  if (blockers.length > 0) {
    return `blocked by ${blockers.join(', ')}`;
  }
  return null;
}

/**
 * Format the active-task read-back. Enumerates each active task's short id,
 * name, status, and most-relevant blocker; caps the row count with a "+N more"
 * line; runs each row through the secret redactor; and hard-truncates to
 * {@link TASKS_REPLY_MAX_CHARS}. A no-active-tasks state returns a clear
 * message rather than an empty reply.
 *
 * Redaction is applied per-row (not to the whole body) so a single
 * credential-shaped task name only masks its own row — a whole-body redactor
 * would collapse the entire listing to the sentinel the moment any one task
 * name contained a word like "token" or "secret".
 */
export function formatTasksReply(rows: TaskSummaryRow[], opts: TasksReplyOptions = {}): string {
  const active = selectActiveTasks(rows, opts);
  if (active.length === 0) {
    return 'No active tasks.';
  }

  const shown = active.slice(0, TASKS_REPLY_MAX_ROWS);
  const lines = shown.map((r) => {
    const name = r.name && r.name.trim().length > 0 ? r.name.trim() : '(unnamed)';
    const blocker = describeBlocker(r);
    const blockerSuffix = blocker ? ` — ${blocker}` : '';
    // Redact each row independently so one credential-shaped name doesn't blank
    // the whole read-back (redact.ts is all-or-nothing per string it sees).
    return redactCredentials(`• ${shortId(r.id)} [${r.status}] ${name}${blockerSuffix}`);
  });

  const header = `Active tasks (${active.length}):`;
  const overflow = active.length > shown.length ? [`…and ${active.length - shown.length} more`] : [];
  const body = [header, ...lines, ...overflow].join('\n');

  return body.length > TASKS_REPLY_MAX_CHARS ? body.slice(0, TASKS_REPLY_MAX_CHARS - 1) + '…' : body;
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
      cwd: typeof t.cwd === 'string' ? t.cwd : undefined,
      stuckReason: typeof t.stuckReason === 'string' ? t.stuckReason : undefined,
      pendingSignal:
        t.pendingSignal && typeof t.pendingSignal === 'object'
          ? { kind: (t.pendingSignal as { kind?: unknown }).kind as string | undefined }
          : null,
      blocked_by: Array.isArray(t.blocked_by)
        ? (t.blocked_by as unknown[]).filter((e): e is string => typeof e === 'string')
        : null,
    } satisfies TaskSummaryRow;
  });
}
