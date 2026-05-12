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

export interface GitHubScannerDeps {
  taskStore: TaskStore;
  stateStore: GitHubStateStore;
  fetcher: GitHubFetcher;
  config: GitHubScannerConfig;
  onChanges: (taskId: string, changes: GitHubStateChange[]) => void;
  /** Called when state is fetched for the first time (even with no changes). */
  onStateUpdate?: (taskId: string) => void;
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

  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private fetchInterval: ReturnType<typeof setInterval> | null = null;
  private ghAvailable = false;
  private fetching = false;
  /** Generation counter — incremented on stop/reconfigure to cancel orphaned fetches. */
  private generation = 0;

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

    console.log('GitHub PR awareness enabled (polling every', this.config.stateFetchIntervalMs / 1000, 's)');

    // Reference extraction runs on its own interval
    this.scanInterval = setInterval(() => {
      this.scanForReferences();
    }, this.config.referenceExtractionIntervalMs);

    // State fetching runs on its own interval
    this.fetchInterval = setInterval(() => {
      void this.fetchAllStates();
    }, this.config.stateFetchIntervalMs);

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
