import type {
  GitHubReference,
  GitHubPRState,
  GitHubIssueState,
  TaskGitHubState,
  GitHubStateChange,
} from './github-types.js';
import type { TaskStore } from './tasks.js';

/**
 * In-memory store for GitHub state per task.
 * Tracks known references, their current state, and recent changes.
 */
export class GitHubStateStore {
  private references = new Map<string, GitHubReference>(); // key: "taskId:type:owner/repo#number"
  private prStates = new Map<string, GitHubPRState>();
  private issueStates = new Map<string, GitHubIssueState>();
  private recentChanges = new Map<string, GitHubStateChange[]>(); // per task
  /**
   * Authorship evidence per task (issue #3678): `owner/repo:branch` keys of the
   * branches its own `git push` reported pushing, and `owner/repo#number` keys
   * of the PRs its own `gh pr create` printed. Owner and repo are lower case.
   */
  private authorship = new Map<string, { branches: Set<string>; prs: Set<string> }>();
  /** Whether {@link authorshipPersistence} has been read into {@link authorship}. */
  private authorshipLoaded = false;

  /**
   * @param authorshipPersistence where authorship evidence outlives a restart
   *   (issue #4077). Without it the evidence is in memory only.
   */
  constructor(private readonly authorshipPersistence?: AuthorshipPersistence) {}

  /**
   * Read the persisted evidence once, on the first authorship read or write
   * (issue #4077). It is lazy because the server builds this store before it
   * loads its tasks; both first uses (the scanner's hook events and the
   * delivery sweeps) come after that load.
   */
  private ensureAuthorshipLoaded(): void {
    if (this.authorshipLoaded || !this.authorshipPersistence) return;
    this.authorshipLoaded = true;
    try {
      for (const { taskId, authorship } of this.authorshipPersistence.load()) {
        this.restoreAuthorship(taskId, authorship);
      }
    } catch (err) {
      console.warn('[github-state] could not load persisted authorship:', err instanceof Error ? err.message : err);
    }
  }

  /** Merge one task's persisted evidence; ignores anything that is not arrays of strings. */
  private restoreAuthorship(taskId: string, persisted: unknown): void {
    if (typeof persisted !== 'object' || persisted === null) return;
    const { pushedBranches, createdPrs } = persisted as Partial<Record<keyof PersistedAuthorship, unknown>>;
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
    const branches = strings(pushedBranches);
    const prs = strings(createdPrs);
    if (branches.length === 0 && prs.length === 0) return;
    const entry = this.authorshipEntry(taskId);
    for (const b of branches) entry.branches.add(b);
    for (const pr of prs) entry.prs.add(pr);
  }

  private authorshipEntry(taskId: string): { branches: Set<string>; prs: Set<string> } {
    let entry = this.authorship.get(taskId);
    if (!entry) {
      entry = { branches: new Set(), prs: new Set() };
      this.authorship.set(taskId, entry);
    }
    return entry;
  }

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

  /**
   * Record that a task pushed these branches or opened these PRs (issue
   * #3678). Idempotent: the scanner re-reads a sliding window of events.
   * Evidence that is new is also saved through the persistence (issue #4077).
   */
  recordAuthorship(taskId: string, evidence: AuthorshipEvidence): void {
    if (evidence.pushedBranches.length === 0 && evidence.createdPrs.length === 0) return;
    this.ensureAuthorshipLoaded();
    const entry = this.authorshipEntry(taskId);
    const before = entry.branches.size + entry.prs.size;
    for (const b of evidence.pushedBranches) entry.branches.add(branchKey(b.owner, b.repo, b.branch));
    for (const pr of evidence.createdPrs) entry.prs.add(prKey(pr.owner, pr.repo, pr.number));
    if (!this.authorshipPersistence || entry.branches.size + entry.prs.size === before) return;
    try {
      this.authorshipPersistence.save(taskId, { pushedBranches: [...entry.branches], createdPrs: [...entry.prs] });
    } catch (err) {
      console.warn(`[github-state] could not persist authorship for task ${taskId}:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Who pushed or opened this PR, as far as recorded (issue #3678): `'self'`
   * when `taskId` pushed its head branch or opened it, `'other'` when only
   * another task did, `'none'` when no task did.
   */
  authorshipOf(
    taskId: string,
    pr: { owner: string; repo: string; number: number; branch?: string },
  ): 'self' | 'other' | 'none' {
    this.ensureAuthorshipLoaded();
    const pk = prKey(pr.owner, pr.repo, pr.number);
    const bk = pr.branch ? branchKey(pr.owner, pr.repo, pr.branch) : null;
    const holds = (e: { branches: Set<string>; prs: Set<string> }): boolean =>
      e.prs.has(pk) || (bk !== null && e.branches.has(bk));
    const own = this.authorship.get(taskId);
    if (own && holds(own)) return 'self';
    for (const [id, e] of this.authorship) {
      if (id !== taskId && holds(e)) return 'other';
    }
    return 'none';
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

  /**
   * Update PR state. Returns the previous state (for diffing). A fetch never
   * carries `delivery` (the delivery tracker sets it, issue #3915), so the
   * previous one is kept while the PR's status and base branch are unchanged;
   * when either changes it is dropped until the tracker derives a new one.
   */
  updatePRState(state: GitHubPRState): GitHubPRState | null {
    const key = this.refKey(state.ref);
    const prev = this.prStates.get(key) ?? null;
    const keepDelivery = state.delivery === undefined
      && prev?.delivery !== undefined
      && prev.status === state.status
      && prev.baseBranch === state.baseBranch;
    this.prStates.set(key, keepDelivery ? { ...state, delivery: prev.delivery } : state);
    return prev;
  }

  /** Every fetched PR state, across tasks (each carries its task in `ref.taskId`). */
  getAllPRStates(): GitHubPRState[] {
    return Array.from(this.prStates.values());
  }

  /**
   * Set or clear the delivery state of one tracked PR (issue #3915). Returns
   * true when it changed, so the caller knows to broadcast.
   */
  setPRDelivery(ref: GitHubReference, delivery: GitHubPRState['delivery']): boolean {
    const key = this.refKey(ref);
    const state = this.prStates.get(key);
    if (!state) return false;
    if (JSON.stringify(state.delivery ?? null) === JSON.stringify(delivery ?? null)) return false;
    const next = { ...state };
    if (delivery) next.delivery = delivery;
    else delete next.delivery;
    this.prStates.set(key, next);
    return true;
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
    // Load first, so a later first read cannot bring the removed evidence back.
    this.ensureAuthorshipLoaded();
    this.authorship.delete(taskId);
  }
}

/**
 * One task's authorship evidence as stored on the task record (issue #4077):
 * the store's own keys, `owner/repo:branch` and `owner/repo#number`.
 */
export interface PersistedAuthorship {
  pushedBranches: string[];
  createdPrs: string[];
}

/** Where authorship evidence outlives a server restart (issue #4077). */
export interface AuthorshipPersistence {
  /** Every task's saved evidence. Malformed entries are ignored. */
  load(): Iterable<{ taskId: string; authorship: unknown }>;
  /** Save a task's evidence after it grew; receives the task's full evidence. */
  save(taskId: string, authorship: PersistedAuthorship): void;
}

/**
 * Authorship persistence on the task records (issue #4077): each task's
 * evidence is its `githubAuthorship` field, so it is saved and archived with
 * the task. Tasks without the field load nothing.
 */
export function taskRecordAuthorshipPersistence(
  taskStore: Pick<TaskStore, 'viewTasks' | 'addGithubAuthorship'>,
): AuthorshipPersistence {
  return {
    load: () => taskStore.viewTasks()
      .filter((task) => task.githubAuthorship !== undefined)
      .map((task) => ({ taskId: task.id, authorship: task.githubAuthorship })),
    save: (taskId, authorship) => taskStore.addGithubAuthorship(taskId, authorship),
  };
}

/** What one task's own commands showed it authored (issue #3678). */
export interface AuthorshipEvidence {
  pushedBranches: ReadonlyArray<{ owner: string; repo: string; branch: string }>;
  createdPrs: ReadonlyArray<{ owner: string; repo: string; number: number }>;
}

function branchKey(owner: string, repo: string, branch: string): string {
  return `${owner}/${repo}`.toLowerCase() + `:${branch}`;
}

function prKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}`.toLowerCase() + `#${number}`;
}
