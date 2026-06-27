import type {
  GitHubReference,
  GitHubPRState,
  GitHubIssueState,
  TaskGitHubState,
  GitHubStateChange,
} from './github-types.js';

/**
 * In-memory store for GitHub state per task.
 * Tracks known references, their current state, and recent changes.
 */
export class GitHubStateStore {
  private references = new Map<string, GitHubReference>(); // key: "taskId:type:owner/repo#number"
  private prStates = new Map<string, GitHubPRState>();
  private issueStates = new Map<string, GitHubIssueState>();
  private recentChanges = new Map<string, GitHubStateChange[]>(); // per task

  private refKey(ref: GitHubReference): string {
    return `${ref.taskId}:${ref.type}:${ref.owner}/${ref.repo}#${ref.number}`;
  }

  private findStateKey(
    type: GitHubReference['type'],
    ref: { owner: string; repo: string; number: number; taskId?: string },
  ): string | null {
    for (const storedRef of this.references.values()) {
      if (
        storedRef.type === type
        && storedRef.owner === ref.owner
        && storedRef.repo === ref.repo
        && storedRef.number === ref.number
        && (!ref.taskId || storedRef.taskId === ref.taskId)
      ) {
        return this.refKey(storedRef);
      }
    }
    return null;
  }

  /** Add a new reference (deduplicates by task, type, owner, repo, and number). */
  addReference(ref: GitHubReference): boolean {
    const key = this.refKey(ref);
    if (this.references.has(key)) return false;
    this.references.set(key, ref);
    return true;
  }

  /** Get all references for a task. */
  getReferences(taskId: string): GitHubReference[] {
    return Array.from(this.references.values()).filter((r) => r.taskId === taskId);
  }

  /** Get all known references. */
  getAllReferences(): GitHubReference[] {
    return Array.from(this.references.values());
  }

  /** Get PR references that need fetching. */
  getPRReferences(): GitHubReference[] {
    return Array.from(this.references.values()).filter((r) => r.type === 'pr');
  }

  /** Get issue references that need fetching. */
  getIssueReferences(): GitHubReference[] {
    return Array.from(this.references.values()).filter((r) => r.type === 'issue');
  }

  /** Update PR state. Returns the previous state (for diffing). */
  updatePRState(state: GitHubPRState): GitHubPRState | null {
    const key = this.refKey(state.ref);
    const prev = this.prStates.get(key) ?? null;
    this.prStates.set(key, state);
    return prev;
  }

  /** Update issue state. Returns the previous state (for diffing). */
  updateIssueState(state: GitHubIssueState): GitHubIssueState | null {
    const key = this.refKey(state.ref);
    const prev = this.issueStates.get(key) ?? null;
    this.issueStates.set(key, state);
    return prev;
  }

  /** Get current PR state. */
  getPRState(ref: { owner: string; repo: string; number: number; taskId?: string }): GitHubPRState | null {
    const key = this.findStateKey('pr', ref);
    return key ? this.prStates.get(key) ?? null : null;
  }

  /** Get current issue state. */
  getIssueState(ref: { owner: string; repo: string; number: number; taskId?: string }): GitHubIssueState | null {
    const key = this.findStateKey('issue', ref);
    return key ? this.issueStates.get(key) ?? null : null;
  }

  /**
   * Verified open/closed state for a reference, regardless of which task it
   * was detected from. Returns:
   * - `true`  — last fetched state says the issue/PR is open (draft PRs count as open)
   * - `false` — last fetched state says it is closed or merged
   * - `undefined` — never successfully fetched (unknown, possibly nonexistent)
   *
   * Used by the project-summary overlay so "open issues/PRs tied to active
   * tasks" only counts items GitHub has confirmed open.
   */
  isRefOpen(ref: { type: GitHubReference['type']; owner: string; repo: string; number: number }): boolean | undefined {
    // Scan every tracked (taskId, ref) entry for this item — the same ref can
    // be tracked under several tasks and state may have been fetched for any
    // of them. First entry with fetched state wins (states for the same item
    // agree modulo fetch timing).
    for (const storedRef of this.references.values()) {
      if (
        storedRef.type !== ref.type
        || storedRef.owner !== ref.owner
        || storedRef.repo !== ref.repo
        || storedRef.number !== ref.number
      ) continue;
      const key = this.refKey(storedRef);
      if (ref.type === 'issue') {
        const state = this.issueStates.get(key);
        if (state) return state.status === 'open';
      } else {
        const state = this.prStates.get(key);
        if (state) return state.status === 'open' || state.status === 'draft';
      }
    }
    return undefined;
  }

  /** Record a state change for a task. */
  addChange(taskId: string, change: GitHubStateChange): void {
    const changes = this.recentChanges.get(taskId) ?? [];
    changes.push(change);
    this.recentChanges.set(taskId, changes);
  }

  /** Get and clear recent changes for a task. */
  consumeChanges(taskId: string): GitHubStateChange[] {
    const changes = this.recentChanges.get(taskId) ?? [];
    this.recentChanges.delete(taskId);
    return changes;
  }

  /** Get recent changes without clearing. */
  peekChanges(taskId: string): GitHubStateChange[] {
    return this.recentChanges.get(taskId) ?? [];
  }

  /** Get aggregate state for a task (for API/WebSocket). */
  getTaskState(taskId: string): TaskGitHubState {
    const refs = this.getReferences(taskId);
    const prs: GitHubPRState[] = [];
    const issues: GitHubIssueState[] = [];

    for (const ref of refs) {
      const key = this.refKey(ref);
      if (ref.type === 'pr') {
        const state = this.prStates.get(key);
        if (state) prs.push(state);
      } else {
        const state = this.issueStates.get(key);
        if (state) issues.push(state);
      }
    }

    return {
      taskId,
      prs,
      issues,
      lastScanAt: refs.length > 0 ? new Date(Math.max(...refs.map((r) => r.detectedAt.getTime()))) : null,
      changes: this.peekChanges(taskId),
    };
  }

  /** Get all task IDs that have GitHub references. */
  getTaskIdsWithReferences(): string[] {
    const taskIds = new Set<string>();
    for (const ref of this.references.values()) {
      taskIds.add(ref.taskId);
    }
    return Array.from(taskIds);
  }

  /** Remove all references for a task. */
  removeTask(taskId: string): void {
    for (const [key, ref] of this.references) {
      if (ref.taskId === taskId) {
        this.references.delete(key);
        this.prStates.delete(key);
        this.issueStates.delete(key);
      }
    }
    this.recentChanges.delete(taskId);
  }
}
