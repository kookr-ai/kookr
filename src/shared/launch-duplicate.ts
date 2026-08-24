import type { AgentSelection } from './contracts/agent-types.js';

/**
 * Client-side launch-directory matching — same equality `kookr spawn` uses
 * (`taskMatchesSpawn` in `bin/kookr-spawn.js`).
 *
 * Two questions share this helper:
 * - Prompt-duplicate: an *active* task with the same *launch* working directory
 *   and the same authored prompt. Agent type is compared only when the new
 *   launch pinned a concrete agent; `round-robin` is treated as unpinned
 *   because no stored task carries that sentinel.
 * - Busy-directory: every active task already launched in that directory,
 *   regardless of prompt (`findLiveTasksInDirectory`).
 *
 * Trailing slashes on cwd are ignored (`/repo` ≡ `/repo/`). Prefer the compact
 * task-list cwd (the directory the operator launched in) over the dashboard
 * snapshot cwd, which follows the live session and can move into a worktree.
 *
 * Prompt compare uses both the typed text and a cwd-joined file-token rewrite,
 * matching the CLI's `normalizePromptFileReferences` so `Fix src/login.ts`
 * still hits a stored absolute path.
 */

/** Two cwds are equivalent if they differ only by trailing slashes. */
export function cwdEquivalent(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

export interface LaunchDuplicateCandidate {
  id?: string;
  taskId?: string;
  agentId?: string;
  status?: string | null;
  taskStatus?: string | null;
  cwd?: string | null;
  agentType?: string | null;
  userPrompt?: string | null;
  prompt?: string | null;
  description?: string | null;
  taskName?: string | null;
  /** ISO start time when present; used to pick the oldest live task in a directory. */
  startedAt?: string | null;
  effort?: string | null;
  model?: string | null;
}

export interface LaunchDuplicateQuery {
  prompt: string;
  cwd: string;
  agentType?: AgentSelection | string | null;
  effort?: string;
  model?: string;
}

/** Same terminal set `kookr spawn` uses (`TERMINAL_TASK_STATUSES`). */
function isTerminalLaunchStatus(status: string): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'terminated';
}

// Mirror of bin/kookr-spawn.js FILE_REFERENCE_PATTERN. Existing relative file
// tokens under cwd are stored as absolute paths on `userPrompt`.
const FILE_REFERENCE_PATTERN =
  /(^|[\s([{'"`])((?:\.\.?\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|(?:\.\.?\/)?[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+)(?=$|[\s)\]}'"`:;,.!?])/g;

/** Join cwd + relative path, resolving `.` / `..` without touching the filesystem. */
export function joinLaunchCwd(cwd: string, relative: string): string {
  const isAbs = cwd.startsWith('/');
  const parts = [...cwd.replace(/\/+$/, '').split('/'), ...relative.split('/')];
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  return isAbs ? `/${joined}` : joined;
}

/**
 * Browser-safe stand-in for the CLI/server file-token rewrite. Always joins
 * relative tokens to `cwd` (no `existsSync`). Compare against both the typed
 * prompt and this expansion so a stored absolute path still matches.
 */
export function expandLaunchPromptPaths(prompt: string, cwd: string): string {
  if (!prompt || !cwd) return prompt;
  return prompt.replace(FILE_REFERENCE_PATTERN, (match, prefix: string, candidate: string) => {
    if (candidate.startsWith('/')) return match;
    return `${prefix}${joinLaunchCwd(cwd, candidate)}`;
  });
}

function storedEqualsPrompt(stored: string, prompt: string, expanded: string): boolean {
  if (stored === prompt || stored.trim() === prompt) return true;
  if (expanded !== prompt && (stored === expanded || stored.trim() === expanded)) return true;
  return false;
}

function promptMatches(task: LaunchDuplicateCandidate, prompt: string, cwd: string): boolean {
  const expanded = expandLaunchPromptPaths(prompt, cwd);
  const authored = typeof task.userPrompt === 'string' ? task.userPrompt : null;
  if (authored !== null && storedEqualsPrompt(authored, prompt, expanded)) return true;

  // Dashboard snapshot: `description` is displayPromptForTask (userPrompt,
  // guardrails stripped). Treat it like the CLI's userPrompt field.
  const description = typeof task.description === 'string' ? task.description : null;
  if (description !== null && storedEqualsPrompt(description, prompt, expanded)) return true;

  const raw = typeof task.prompt === 'string' ? task.prompt : null;
  if (raw !== null) {
    if (storedEqualsPrompt(raw, prompt, expanded)) return true;
    if (raw.startsWith(prompt) || raw.endsWith(prompt)) return true;
    if (expanded !== prompt && (raw.startsWith(expanded) || raw.endsWith(expanded))) return true;
  }
  return false;
}

/**
 * Overlay compact-list launch cwds onto snapshot rows. Dashboard `agent.cwd`
 * follows the live session (often a worktree); the compact row keeps the
 * directory the operator actually launched in.
 */
export function withLaunchTaskCwds(
  tasks: readonly LaunchDuplicateCandidate[],
  launchCwdByTaskId: Readonly<Record<string, string>>,
): LaunchDuplicateCandidate[] {
  return tasks.map((task) => {
    const id = task.taskId ?? task.id;
    const launchCwd = id ? launchCwdByTaskId[id] : undefined;
    return launchCwd ? { ...task, cwd: launchCwd } : task;
  });
}

/**
 * Does an existing task look like the launch the operator is about to send?
 * Mirrors `taskMatchesSpawn` in `bin/kookr-spawn.js`.
 */
export function taskMatchesLaunchDuplicate(
  task: LaunchDuplicateCandidate,
  query: LaunchDuplicateQuery,
): boolean {
  if (!task || typeof task !== 'object') return false;
  const status = typeof (task.taskStatus ?? task.status) === 'string'
    ? (task.taskStatus ?? task.status)
    : null;
  if (status && isTerminalLaunchStatus(status)) return false;
  if (!cwdEquivalent(task.cwd, query.cwd)) return false;
  const pinned = query.agentType && query.agentType !== 'round-robin' ? query.agentType : null;
  if (pinned && typeof task.agentType === 'string' && task.agentType !== pinned) return false;
  // Older snapshots do not expose durable pins. Comparing undefined as the
  // unpinned value keeps pinned and unpinned intents distinct while the server
  // remains the authoritative deduplication boundary.
  if ((task.effort ?? undefined) !== (query.effort ?? undefined)) return false;
  if ((task.model ?? undefined) !== (query.model ?? undefined)) return false;
  return promptMatches(task, query.prompt, query.cwd);
}

/**
 * First active task in `tasks` that matches prompt + cwd + (optional) agent.
 * Empty prompt or cwd never matches — the launch form is incomplete.
 */
export function findActiveLaunchDuplicate(
  tasks: readonly LaunchDuplicateCandidate[],
  query: LaunchDuplicateQuery,
): LaunchDuplicateCandidate | undefined {
  const prompt = query.prompt.trim();
  const cwd = query.cwd.trim();
  if (!prompt || !cwd) return undefined;
  return tasks.find((task) => taskMatchesLaunchDuplicate(task, { ...query, prompt, cwd }));
}

function isLiveLaunchTask(task: LaunchDuplicateCandidate): boolean {
  if (!task || typeof task !== 'object') return false;
  const status = typeof (task.taskStatus ?? task.status) === 'string'
    ? (task.taskStatus ?? task.status)
    : null;
  return !(status && isTerminalLaunchStatus(status));
}

/**
 * Active tasks whose *launch* directory is this cwd (trailing slashes ignored).
 *
 * Prompt is ignored — this is the busy-directory warning, not prompt-duplicate
 * matching. Prefer compact-list cwd (via {@link withLaunchTaskCwds}) so a
 * session that later moved into a linked worktree still counts against the
 * directory the operator launched in.
 *
 * Oldest first when `startedAt` is present so "Open existing" has a stable pick.
 * Empty cwd never matches. Does not change `kookr spawn` defaults.
 */
export function findLiveTasksInDirectory(
  tasks: readonly LaunchDuplicateCandidate[],
  cwd: string,
): LaunchDuplicateCandidate[] {
  const trimmed = cwd.trim();
  if (!trimmed) return [];
  return tasks
    .filter((task) => isLiveLaunchTask(task) && cwdEquivalent(task.cwd, trimmed))
    .sort((a, b) => {
      const aTime = typeof a.startedAt === 'string' ? a.startedAt : '';
      const bTime = typeof b.startedAt === 'string' ? b.startedAt : '';
      if (aTime && bTime && aTime !== bTime) return aTime < bTime ? -1 : 1;
      return 0;
    });
}
