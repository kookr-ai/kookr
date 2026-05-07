import type { AgentState } from '../core/monitor.js';
import { endsWithProtectedSuffix, deriveParentRepoFromProtected } from '../core/worktree-protection.js';

/**
 * Derive a local cwd for a project by picking the most recent agent matching
 * its projectId. Worktree-protected suffixes are stripped so callers pre-fill
 * with the parent repo rather than a transient worktree path.
 * Returns null when no agent for the project has a cwd yet.
 */
export function deriveProjectCwd(agents: AgentState[], projectId: string): string | null {
  let best: AgentState | null = null;
  for (const agent of agents) {
    if (agent.projectId !== projectId || !agent.cwd) continue;
    if (!best) { best = agent; continue; }
    const a = agent.startedAt ?? '';
    const b = best.startedAt ?? '';
    if (a > b) best = agent;
  }
  if (!best?.cwd) return null;
  return endsWithProtectedSuffix(best.cwd)
    ? deriveParentRepoFromProtected(best.cwd)
    : best.cwd;
}
