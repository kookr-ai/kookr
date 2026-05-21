import type { TaskStore } from './tasks.js';
import type { AgentEvent } from './types.js';
import type {
  GitHubFetcher,
  GitHubIssueState,
  GitHubPRState,
  GitHubReference,
  GitHubScannerConfig,
  GitHubStateChange,
} from './github-types.js';
import { GitHubStateStore } from './github-state-store.js';
import { extractRefsFromEvents, extractRefsFromPrompt, toGitHubReferences } from './github-reference-scanner.js';
import { diffPRState, diffIssueState } from './github-state-differ.js';
import { isSafeGithubProjectId, projectIdToOwnerRepo } from './project-identity.js';
import type { ProjectRepoHealth } from './project-summary.js';

/** How often the per-repo health batch (issues/PRs counts + pending list) is refetched. */
export const REPO_HEALTH_INTERVAL_MS = 600_000;
/** Watchdog: force-clear repoHealthInflight if a tick has not finished within this window. */
const REPO_HEALTH_WATCHDOG_MS = 60_000;

export type RepoHealthFetcher = (
  repos: ReadonlyArray<{ projectId: string; owner: string; repo: string }>,
  login: string | null,
) => Promise<Map<string, ProjectRepoHealth> | null>;

/** Resolves the authenticated `gh` login (e.g. "jeanibarz") or null if unauthed. */
export type GhUserLoginResolver = () => Promise<string | null>;

export interface GitHubScannerDeps {
  taskStore: TaskStore;
  stateStore: GitHubStateStore;
  fetcher: GitHubFetcher;
  config: GitHubScannerConfig;
  onChanges: (taskId: string, changes: GitHubStateChange[]) => void;
  /** Called when state is fetched for the first time (even with no changes). */
  onStateUpdate?: (taskId: string) => void;
  /**
   * Batch fetch for repo-wide stats. When omitted the third interval is not
   * armed and `getRepoHealthSnapshot()` returns an empty map. Bypasses the
   * circuit breaker by design — failures are idempotent and one whole-batch
   * miss costs only one GraphQL point.
   */
  repoHealthFetcher?: RepoHealthFetcher;
  /** Resolves the GitHub login used to scope "needs attention" PRs. Called once at start(). */
  ghUserLoginResolver?: GhUserLoginResolver;
  /** Called whenever the repo-health cache changes so the server can rebroadcast summaries. */
  onRepoHealthChanged?: () => void;
}

/**
 * GitHubScannerService orchestrates periodic reference extraction and state fetching.
 * It is wired into the server and runs on intervals.
 */
export class GitHubScannerService {
  private taskStore: TaskStore;
  private stateStore: GitHubStateStore;
  private fetcher: GitHubFetcher;
  private config: GitHubScannerConfig;
  private onChanges: (taskId: string, changes: GitHubStateChange[]) => void;
  private onStateUpdate?: (taskId: string) => void;
  private repoHealthFetcher?: RepoHealthFetcher;
  private ghUserLoginResolver?: GhUserLoginResolver;
  private ghUserLogin: string | null = null;
  private onRepoHealthChanged?: () => void;

  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private fetchInterval: ReturnType<typeof setInterval> | null = null;
  private repoHealthInterval: ReturnType<typeof setInterval> | null = null;
  private ghAvailable = false;
  private fetching = false;
  private repoHealthInflight = false;
  /** Generation counter — incremented on stop/reconfigure to cancel orphaned fetches. */
  private generation = 0;

  /** Repo-health cache: project id (`github.com/owner/repo`) → ProjectRepoHealth (view-model shape). */
  private repoHealth = new Map<string, ProjectRepoHealth>();
  /** The set of project ids the next repo-health tick should fetch (push-fed). */
  private trackedRepos = new Set<string>();

  // Cache: cwd → { owner, repo }
  private ownerRepoCache = new Map<string, { owner: string; repo: string } | null>();

  // Track which task prompts have been scanned to avoid re-scanning
  private scannedPrompts = new Set<string>();

  constructor(deps: GitHubScannerDeps) {
    this.taskStore = deps.taskStore;
    this.stateStore = deps.stateStore;
    this.fetcher = deps.fetcher;
    this.config = deps.config;
    this.onChanges = deps.onChanges;
    this.onStateUpdate = deps.onStateUpdate;
    this.repoHealthFetcher = deps.repoHealthFetcher;
    this.ghUserLoginResolver = deps.ghUserLoginResolver;
    this.onRepoHealthChanged = deps.onRepoHealthChanged;
  }

  /** Start the periodic scanner. Idempotent — stops first if already running. Returns false if gh is not available. */
  async start(): Promise<boolean> {
    // Idempotent: stop existing intervals before starting
    if (this.scanInterval || this.fetchInterval) {
      this.stop();
    }

    this.ghAvailable = await this.fetcher.isAvailable();
    if (!this.ghAvailable) {
      console.warn('GitHub awareness disabled: gh CLI not authenticated. Run: gh auth login');
      return false;
    }

    // Resolve the authenticated login once for scoping "needs attention" lists.
    if (this.ghUserLoginResolver) {
      try {
        this.ghUserLogin = await this.ghUserLoginResolver();
        if (this.ghUserLogin) {
          console.log(`[github] resolved login: ${this.ghUserLogin}`);
        }
      } catch {
        this.ghUserLogin = null;
      }
    }

    console.log('GitHub PR awareness enabled (polling every', this.config.stateFetchIntervalMs / 1000, 's)');

    // Reference extraction runs on its own interval
    this.scanInterval = setInterval(() => {
      this.scanForReferences();
    }, this.config.referenceExtractionIntervalMs);

    // State fetching runs on its own interval
    this.fetchInterval = setInterval(() => {
      void this.fetchAllStates();
    }, this.config.stateFetchIntervalMs);

    if (this.repoHealthFetcher) {
      this.repoHealthInterval = setInterval(() => {
        void this.repoHealthTick();
      }, REPO_HEALTH_INTERVAL_MS);
      // Kick an immediate first fetch so the drawer is populated before the first 10-min interval elapses.
      void this.repoHealthTick();
    }

    return true;
  }

  /** Stop all periodic scanning. Increments generation to cancel in-flight fetches. */
  stop(): void {
    this.generation++;
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.fetchInterval) {
      clearInterval(this.fetchInterval);
      this.fetchInterval = null;
    }
    if (this.repoHealthInterval) {
      clearInterval(this.repoHealthInterval);
      this.repoHealthInterval = null;
    }
  }

  /**
   * Reconfigure the scanner with new settings.
   * Preserves ownerRepoCache, scannedPrompts, and stateStore.
   * Restarts intervals if currently running.
   */
  reconfigure(partial: Partial<GitHubScannerConfig>): void {
    this.config = { ...this.config, ...partial };
    // If running, restart intervals with new config
    if (this.scanInterval || this.fetchInterval) {
      this.stop();
      // Re-arm intervals without re-checking gh availability (already known)
      if (this.ghAvailable) {
        console.log('GitHub PR awareness reconfigured (polling every', this.config.stateFetchIntervalMs / 1000, 's)');
        this.scanInterval = setInterval(() => {
          this.scanForReferences();
        }, this.config.referenceExtractionIntervalMs);
        this.fetchInterval = setInterval(() => {
          void this.fetchAllStates();
        }, this.config.stateFetchIntervalMs);
        if (this.repoHealthFetcher) {
          this.repoHealthInterval = setInterval(() => {
            void this.repoHealthTick();
          }, REPO_HEALTH_INTERVAL_MS);
        }
      }
    }
  }

  /** Whether the gh CLI is available and scanning is active. */
  isActive(): boolean {
    return this.ghAvailable && this.scanInterval !== null;
  }

  /** Get the state store (for API endpoints). */
  getStateStore(): GitHubStateStore {
    return this.stateStore;
  }

  /** Refresh GitHub references for one task on demand. Used by click-time coordinator checks. */
  async refreshTaskState(taskId: string): Promise<void> {
    if (!this.ghAvailable) return;
    await this.processTaskPrompt(taskId);
    await this.fetchReferences(this.stateStore.getReferences(taskId));
  }

  /**
   * Process events from an agent — called on every hook event.
   * Does a quick regex-only scan for immediate reference detection.
   */
  async processEventsImmediate(agentId: string, events: AgentEvent[], taskId: string): Promise<void> {
    if (!this.ghAvailable) return;

    const ownerRepo = await this.resolveOwnerRepo(agentId, taskId);
    const refs = extractRefsFromEvents(events, ownerRepo?.owner, ownerRepo?.repo);
    const ghRefs = toGitHubReferences(refs, agentId, taskId);

    const newRefs: GitHubReference[] = [];
    for (const ref of ghRefs) {
      if (this.stateStore.addReference(ref)) {
        newRefs.push(ref);
        if (ref.type === 'pr') {
          // Only infer projectId from PR references if not already set explicitly (e.g., by playbook launch)
          const task = this.taskStore.getTask(taskId);
          if (task && !task.projectId) {
            this.taskStore.setProjectId(taskId, `github.com/${ref.owner}/${ref.repo}`.toLowerCase());
          }
        }
        console.log(`GitHub: detected ${ref.type} ${ref.owner}/${ref.repo}#${ref.number} from ${agentId}`);
      }
    }

    // If we found new refs, trigger an immediate fetch
    if (newRefs.length > 0) {
      void this.fetchReferences(newRefs);
    }
  }

  /**
   * Scan a task's prompt text for issue/PR references.
   * Called at task creation time to detect references like "fix issue #18" or "resolve #42".
   */
  async processTaskPrompt(taskId: string): Promise<void> {
    if (!this.ghAvailable) return;
    if (this.scannedPrompts.has(taskId)) return;
    this.scannedPrompts.add(taskId);

    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    const ownerRepo = await this.resolveOwnerRepoFromCwd(task.cwd);
    const refs = extractRefsFromPrompt(task.prompt);

    // Fill in owner/repo from git remote for refs that don't have it
    const allExtracted = refs.map((ref) => ({
      ...ref,
      owner: ref.owner ?? ownerRepo?.owner,
      repo: ref.repo ?? ownerRepo?.repo,
    }));
    const fullRefs = toGitHubReferences(allExtracted, 'prompt', taskId);

    const newRefs: GitHubReference[] = [];
    for (const ref of fullRefs) {
      if (this.stateStore.addReference(ref)) {
        newRefs.push(ref);
        console.log(`GitHub: detected ${ref.type} ${ref.owner}/${ref.repo}#${ref.number} from task prompt`);
      }
    }

    if (newRefs.length > 0) {
      void this.fetchReferences(newRefs);
    }
  }

  /** Scan all active tasks for GitHub references. */
  private scanForReferences(): void {
    // For Phase 1, the event-driven processEventsImmediate handles most detection.
    // This periodic scan is a safety net / will be the entry point for Haiku in Phase 2.
  }

  /** Fetch current state for all known references and emit changes. */
  private async fetchAllStates(): Promise<void> {
    await this.fetchReferences(this.stateStore.getAllReferences());
  }

  /** Fetch current state for the provided references and emit changes. */
  private async fetchReferences(refs: GitHubReference[]): Promise<void> {
    // Prevent concurrent fetches — if one is already running, skip
    if (this.fetching) return;
    this.fetching = true;
    const gen = this.generation;

    try {
      const uniqueRefs = dedupeRefs(refs);
      if (uniqueRefs.length === 0) return;

      if (this.fetcher.fetchStates) {
        try {
          const batch = await this.fetcher.fetchStates(uniqueRefs);
          if (this.generation !== gen) return;

          for (const current of batch.prs) {
            this.applyPRState(current);
          }
          for (const current of batch.issues) {
            this.applyIssueState(current);
          }
        } catch (err) {
          console.error('GitHub: error fetching batched state:', err);
        }
        return;
      }

      for (const ref of uniqueRefs) {
        if (this.generation !== gen) return;
        try {
          if (ref.type === 'pr') {
            const current = await this.fetcher.fetchPRState(ref);
            if (!current || this.generation !== gen) continue;
            this.applyPRState(current);
          } else {
            const current = await this.fetcher.fetchIssueState(ref);
            if (!current || this.generation !== gen) continue;
            this.applyIssueState(current);
          }
        } catch (err) {
          console.error(`GitHub: error fetching ${ref.type} ${ref.owner}/${ref.repo}#${ref.number}:`, err);
        }
      }
    } finally {
      this.fetching = false;
    }
  }

  private applyPRState(current: GitHubPRState): void {
    const prev = this.stateStore.updatePRState(current);
    const changes = diffPRState(prev, current);
    this.emitStateResult(current.ref.taskId, changes, !prev);
  }

  private applyIssueState(current: GitHubIssueState): void {
    const prev = this.stateStore.updateIssueState(current);
    const changes = diffIssueState(prev, current);
    this.emitStateResult(current.ref.taskId, changes, !prev);
  }

  private emitStateResult(taskId: string, changes: GitHubStateChange[], firstFetch: boolean): void {
    if (changes.length > 0) {
      for (const change of changes) {
        this.stateStore.addChange(taskId, change);
      }
      this.onChanges(taskId, changes);
    } else if (firstFetch) {
      // First fetch — no changes but notify so frontend gets the initial state
      this.onStateUpdate?.(taskId);
    }
  }

  /**
   * Update the set of project ids the next repo-health tick should fetch.
   * Pushed from the server's broadcastProjectSummaries path; the scanner does
   * not query presentation state itself. Ids that fail safe-validation are
   * silently dropped here so the batch never poisons.
   */
  setTrackedGithubRepos(projectIds: ReadonlyArray<string>): void {
    const next = new Set<string>();
    for (const id of projectIds) {
      if (isSafeGithubProjectId(id)) next.add(id);
    }
    // If any new repo appeared in the set, kick a tick so the drawer
    // doesn't have to wait up to 10 min for its first data.
    let hasNew = false;
    for (const id of next) {
      if (!this.trackedRepos.has(id)) { hasNew = true; break; }
    }
    this.trackedRepos = next;
    if (hasNew && this.repoHealthFetcher && this.ghAvailable) {
      void this.repoHealthTick();
    }
  }

  /** Read-only view of the current repo-health cache. Passed to project-summary computation. */
  getRepoHealthSnapshot(): ReadonlyMap<string, ProjectRepoHealth> {
    return this.repoHealth;
  }

  /** Visible for tests. */
  isRepoHealthInflight(): boolean {
    return this.repoHealthInflight;
  }

  /**
   * One periodic batch fetch. Returns silently when no fetcher is wired or
   * no repos are tracked. Re-entrant calls are skipped; a 60 s watchdog
   * guarantees the inflight flag never sticks.
   */
  private async repoHealthTick(): Promise<void> {
    if (!this.repoHealthFetcher) return;
    if (this.repoHealthInflight) return;
    if (this.trackedRepos.size === 0) {
      if (this.repoHealth.size > 0) {
        this.repoHealth = new Map();
        this.onRepoHealthChanged?.();
      }
      return;
    }

    this.repoHealthInflight = true;
    const watchdog = setTimeout(() => {
      console.warn('[github] repo-health tick watchdog fired; clearing inflight flag');
      this.repoHealthInflight = false;
    }, REPO_HEALTH_WATCHDOG_MS);
    watchdog.unref?.();

    try {
      const batch: Array<{ projectId: string; owner: string; repo: string }> = [];
      for (const id of this.trackedRepos) {
        const parsed = projectIdToOwnerRepo(id);
        if (parsed) batch.push({ projectId: id, owner: parsed.owner, repo: parsed.repo });
      }
      if (batch.length === 0) return;

      const fresh = await this.repoHealthFetcher(batch, this.ghUserLogin);
      if (fresh === null) return; // whole-batch failure — preserve previous cache

      // Eviction-race fix: re-read the tracked set at write time and only
      // commit entries for repos still in it.
      const currentTracked = this.trackedRepos;
      const next = new Map<string, ProjectRepoHealth>();
      for (const [projectId, prev] of this.repoHealth) {
        if (!currentTracked.has(projectId)) continue;
        if (fresh.has(projectId)) continue; // about to overwrite
        next.set(projectId, prev);
      }
      for (const [projectId, entry] of fresh) {
        if (!currentTracked.has(projectId)) continue;
        next.set(projectId, entry);
      }
      this.repoHealth = next;
      this.onRepoHealthChanged?.();
    } catch (err) {
      console.warn('[github] repo-health tick error:', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(watchdog);
      this.repoHealthInflight = false;
    }
  }

  /** Resolve owner/repo for a task from its working directory. */
  private async resolveOwnerRepo(agentId: string, taskId: string): Promise<{ owner: string; repo: string } | null> {
    const task = this.taskStore.getTask(taskId);
    if (!task) return null;
    return this.resolveOwnerRepoFromCwd(task.cwd);
  }

  /** Resolve owner/repo from a working directory path. */
  private async resolveOwnerRepoFromCwd(cwd: string): Promise<{ owner: string; repo: string } | null> {
    if (this.ownerRepoCache.has(cwd)) {
      return this.ownerRepoCache.get(cwd) ?? null;
    }

    const result = await this.fetcher.inferOwnerRepo(cwd);
    this.ownerRepoCache.set(cwd, result);
    return result;
  }
}

function dedupeRefs(refs: GitHubReference[]): GitHubReference[] {
  const seen = new Set<string>();
  const unique: GitHubReference[] = [];
  for (const ref of refs) {
    const key = `${ref.taskId}:${ref.type}:${ref.owner}/${ref.repo}#${ref.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}
