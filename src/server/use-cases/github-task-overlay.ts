import type { AgentState } from '../../shared/contracts/agent-state.js';
import type { GitHubReference } from '../../core/github-types.js';
import type { GithubTaskOverlayEntry } from '../../core/project-summary.js';
import { projectIdToOwnerRepo } from '../../core/project-identity.js';

export type GithubTaskOverlay = GithubTaskOverlayEntry;

export interface BuildGithubTaskOverlayInput {
  agents: AgentState[];
  /**
   * Per-task GitHub reference accessor. Bound at call sites to
   * `GitHubStateStore.getReferences(taskId)`. Must return an array (empty when
   * no refs) — uncaught throws will abort overlay computation for all projects.
   */
  getTaskGithubReferences: (taskId: string) => GitHubReference[];
  /**
   * Verified open/closed state accessor, bound to
   * `GitHubStateStore.isRefOpen(ref)`. When provided, a reference only counts
   * toward the "open issues/PRs tied to active tasks" sets if GitHub has
   * CONFIRMED it open (`true`). Closed/merged (`false`) and never-fetched
   * (`undefined` — including bogus refs to nonexistent items) are excluded,
   * so the tied counts can no longer exceed the repo's real open counts.
   * When omitted (legacy callers/tests), every project-matching ref counts.
   */
  getRefOpenState?: (ref: GitHubReference) => boolean | undefined;
}

/**
 * Join active-agent GitHub references against their projects to produce a
 * per-project overlay of "issues/PRs currently being processed by Kookr".
 *
 * An agent counts when its task is `inProgress`, not snoozed, and assigned to a
 * GitHub project. Each unique issue or PR number that agent references in its
 * own project's repo contributes once to the tied set; the same number observed
 * by two active agents is still counted once (Set semantics) but both agents
 * appear in `links`.
 *
 * Refs that resolve to a different `(owner, repo)` than the agent's project are
 * ignored — a task linking to an upstream issue in a fork project would not
 * inflate the upstream's overlay.
 */
export function buildGithubTaskOverlay(input: BuildGithubTaskOverlayInput): Map<string, GithubTaskOverlay> {
  const out = new Map<string, GithubTaskOverlay>();

  for (const agent of input.agents) {
    if (agent.taskStatus !== 'inProgress') continue;
    if (agent.snoozedUntil) continue;
    if (!agent.taskId || !agent.projectId) continue;

    // projectIdToOwnerRepo already enforces `isSafeGithubProjectId` and
    // returns lowercase owner/repo. GitHub URLs are case-insensitive but the
    // ref scanner stores owner/repo verbatim from the captured URL — compare
    // lowercase on both sides so `Octo/Cat` ↔ `octo/cat` matches correctly.
    const ownerRepo = projectIdToOwnerRepo(agent.projectId);
    if (!ownerRepo) continue;

    let overlay = out.get(agent.projectId);
    if (!overlay) {
      overlay = { tiedOpenIssueNumbers: new Set(), tiedOpenPrNumbers: new Set(), links: [] };
      out.set(agent.projectId, overlay);
    }

    const seenForTask = new Set<string>();
    for (const ref of input.getTaskGithubReferences(agent.taskId)) {
      if (ref.owner.toLowerCase() !== ownerRepo.owner) continue;
      if (ref.repo.toLowerCase() !== ownerRepo.repo) continue;
      // Honest counting (data-trust fix): when an open-state accessor is
      // wired, only refs GitHub has verified open contribute. A scanned ref
      // that is closed, merged, or was never successfully fetched (e.g. a
      // prose "#123" pointing at nothing) must not inflate the counts.
      if (input.getRefOpenState && input.getRefOpenState(ref) !== true) continue;
      const dedupeKey = `${ref.type}:${ref.number}`;
      if (seenForTask.has(dedupeKey)) continue;
      seenForTask.add(dedupeKey);

      if (ref.type === 'issue') overlay.tiedOpenIssueNumbers.add(ref.number);
      else                       overlay.tiedOpenPrNumbers.add(ref.number);

      overlay.links.push({
        kind: ref.type,
        number: ref.number,
        taskId: agent.taskId,
        taskName: agent.taskName,
      });
    }
  }

  return out;
}
