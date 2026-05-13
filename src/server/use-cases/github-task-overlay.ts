import type { AgentState } from '../../core/monitor.js';
import type { GitHubReference } from '../../core/github-types.js';
import { isSafeGithubProjectId, projectIdToOwnerRepo } from '../../core/project-identity.js';

export interface GithubTaskOverlayLink {
  kind: 'issue' | 'pr';
  number: number;
  taskId: string;
  taskName?: string;
}

export interface GithubTaskOverlay {
  tiedOpenIssueNumbers: Set<number>;
  tiedOpenPrNumbers: Set<number>;
  links: GithubTaskOverlayLink[];
}

export interface BuildOverlayInput {
  agents: AgentState[];
  getReferences: (taskId: string) => GitHubReference[];
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
export function buildGithubTaskOverlay(input: BuildOverlayInput): Map<string, GithubTaskOverlay> {
  const out = new Map<string, GithubTaskOverlay>();

  for (const agent of input.agents) {
    if (agent.taskStatus !== 'inProgress') continue;
    if (agent.snoozedUntil) continue;
    if (!agent.taskId || !agent.projectId) continue;
    if (!isSafeGithubProjectId(agent.projectId)) continue;
    const ownerRepo = projectIdToOwnerRepo(agent.projectId);
    if (!ownerRepo) continue;

    let overlay = out.get(agent.projectId);
    if (!overlay) {
      overlay = { tiedOpenIssueNumbers: new Set(), tiedOpenPrNumbers: new Set(), links: [] };
      out.set(agent.projectId, overlay);
    }

    const seenForTask = new Set<string>();
    for (const ref of input.getReferences(agent.taskId)) {
      if (ref.owner !== ownerRepo.owner || ref.repo !== ownerRepo.repo) continue;
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
