/**
 * Which of a task's tracked pull requests the task opened itself, and which it
 * only mentioned (#4024 item 4 slice 3; design note
 * docs/rfc/rfc-reading-pane-changes-tab.md). The reading pane's Pull request
 * tab lists the task's own PRs first, and the Changes tab falls back to an own
 * PR's file list once the worktree is removed. Dashboard and server use this
 * one rule.
 *
 * GitHub does not say which task opened a PR, so the rule works from what
 * Kookr recorded:
 * - A PR cited in the task's prompt is never the task's own.
 * - When the task's branch is known and a PR's head is that branch, those PRs
 *   are the task's own, and no other.
 * - Otherwise a PR the agent mentioned counts as its own when it was opened
 *   at or after the task was created. The branch alone cannot rule a PR out:
 *   it is the branch of the session's directory, and an agent that works in a
 *   worktree it created itself can leave it pointing at another checkout.
 */

/** `GitHubReference.detectedFrom` of a reference found in the task's prompt. */
const PROMPT_DETECTED_FROM = 'prompt';

export interface OwnPullRequestCandidate {
  ref: { detectedFrom: string };
  /** Head branch. */
  branch: string;
  /** When the PR was opened; a `Date` on the server, an ISO string once sent as JSON. */
  createdAt?: Date | string;
}

export interface OwnPullRequestTask {
  /** The task's current branch, when known. */
  branch?: string | null;
  /** When the task was created. */
  createdAt?: Date | string | null;
}

function epochMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Splits `prs` into the task's own and the ones it only mentioned, keeping their order. */
export function splitOwnPullRequests<T extends OwnPullRequestCandidate>(
  prs: readonly T[],
  task: OwnPullRequestTask,
): { own: T[]; mentioned: T[] } {
  const candidates = prs.filter((pr) => pr.ref.detectedFrom !== PROMPT_DETECTED_FROM);
  const branch = task.branch?.trim() || null;
  let own = branch ? candidates.filter((pr) => pr.branch.trim() === branch) : [];
  if (own.length === 0) {
    const taskCreatedMs = epochMs(task.createdAt);
    own = taskCreatedMs === null
      ? []
      : candidates.filter((pr) => {
        const openedMs = epochMs(pr.createdAt);
        return openedMs !== null && openedMs >= taskCreatedMs;
      });
  }
  const ownSet = new Set<T>(own);
  return { own, mentioned: prs.filter((pr) => !ownSet.has(pr)) };
}
