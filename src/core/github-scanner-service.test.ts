import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubScannerService } from './github-scanner-service.js';
import { GitHubStateStore } from './github-state-store.js';
import { TaskStore } from './tasks.js';
import { DEFAULT_GITHUB_SCANNER_CONFIG } from './github-types.js';
import type { GitHubFetcher, GitHubIssueState, GitHubPRState, GitHubReference } from './github-types.js';
import type { AgentEvent } from './types.js';

function createMockFetcher(available = true): GitHubFetcher {
  return {
    isAvailable: vi.fn().mockResolvedValue(available),
    inferOwnerRepo: vi.fn().mockResolvedValue(null),
    fetchPRState: vi.fn().mockResolvedValue(null),
    fetchIssueState: vi.fn().mockResolvedValue(null),
  };
}

describe('GitHubScannerService', () => {
  let taskStore: TaskStore;
  let stateStore: GitHubStateStore;
  let onChanges: ReturnType<typeof vi.fn>;
  let scanner: GitHubScannerService | null;

  beforeEach(() => {
    vi.useFakeTimers();
    taskStore = new TaskStore();
    stateStore = new GitHubStateStore();
    onChanges = vi.fn();
    scanner = null;
  });

  afterEach(() => {
    scanner?.stop();
    vi.useRealTimers();
  });

  describe('start()', () => {
    it('returns false when gh CLI is unavailable', async () => {
      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher: createMockFetcher(false),
        config: DEFAULT_GITHUB_SCANNER_CONFIG,
        onChanges,
      });
      const result = await scanner.start();
      expect(result).toBe(false);
      expect(scanner.isActive()).toBe(false);
    });

    it('returns true when gh CLI is available', async () => {
      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher: createMockFetcher(true),
        config: DEFAULT_GITHUB_SCANNER_CONFIG,
        onChanges,
      });
      const result = await scanner.start();
      expect(result).toBe(true);
      expect(scanner.isActive()).toBe(true);
    });

    it('is idempotent — calling start twice does not double intervals', async () => {
      const fetcher = createMockFetcher(true);
      // Pre-seed a PR reference so fetchPRState gets called on each tick
      stateStore.addReference({
        type: 'pr', owner: 'test', repo: 'repo', number: 1,
        url: 'https://github.com/test/repo/pull/1',
        taskId: 'task-1', detectedAt: new Date(), detectedFrom: 'agent-1',
      });
      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: { ...DEFAULT_GITHUB_SCANNER_CONFIG, stateFetchIntervalMs: 1000, referenceExtractionIntervalMs: 5000 },
        onChanges,
      });
      await scanner.start();
      await scanner.start(); // should stop + restart, not double
      expect(scanner.isActive()).toBe(true);

      // Advance by one interval tick — if intervals doubled, fetchPRState would fire twice
      (fetcher.fetchPRState as ReturnType<typeof vi.fn>).mockClear();
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetcher.fetchPRState).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop()', () => {
    it('marks scanner as inactive', async () => {
      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher: createMockFetcher(true),
        config: DEFAULT_GITHUB_SCANNER_CONFIG,
        onChanges,
      });
      await scanner.start();
      expect(scanner.isActive()).toBe(true);
      scanner.stop();
      expect(scanner.isActive()).toBe(false);
    });
  });

  describe('reconfigure()', () => {
    it('updates config and restarts intervals when running', async () => {
      const fetcher = createMockFetcher(true);
      // Pre-seed a PR reference so fetchPRState gets called on each tick
      stateStore.addReference({
        type: 'pr', owner: 'test', repo: 'repo', number: 1,
        url: 'https://github.com/test/repo/pull/1',
        taskId: 'task-1', detectedAt: new Date(), detectedFrom: 'agent-1',
      });
      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: { ...DEFAULT_GITHUB_SCANNER_CONFIG, stateFetchIntervalMs: 1000 },
        onChanges,
      });
      await scanner.start();
      expect(scanner.isActive()).toBe(true);

      // Reconfigure to a longer interval
      scanner.reconfigure({ stateFetchIntervalMs: 5000 });
      expect(scanner.isActive()).toBe(true);

      // Advance by the old interval (1000ms) — should NOT trigger a fetch
      // because the new 5000ms interval should be in effect
      (fetcher.fetchPRState as ReturnType<typeof vi.fn>).mockClear();
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetcher.fetchPRState).toHaveBeenCalledTimes(0);

      // Advance to the new interval (4000ms more, 5000ms total) — should trigger
      await vi.advanceTimersByTimeAsync(4000);
      expect(fetcher.fetchPRState).toHaveBeenCalledTimes(1);
    });

    it('updates config without starting when not running', async () => {
      const fetcher = createMockFetcher(true);
      stateStore.addReference({
        type: 'pr', owner: 'test', repo: 'repo', number: 1,
        url: 'https://github.com/test/repo/pull/1',
        taskId: 'task-1', detectedAt: new Date(), detectedFrom: 'agent-1',
      });
      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: { ...DEFAULT_GITHUB_SCANNER_CONFIG, stateFetchIntervalMs: 60_000 },
        onChanges,
      });
      // Not started — reconfigure should not start it
      scanner.reconfigure({ stateFetchIntervalMs: 2000 });
      expect(scanner.isActive()).toBe(false);

      // Now start — should use the reconfigured interval (2000ms)
      await scanner.start();
      (fetcher.fetchPRState as ReturnType<typeof vi.fn>).mockClear();

      // Advance by 1999ms — should NOT trigger yet
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetcher.fetchPRState).toHaveBeenCalledTimes(0);

      // Advance 1 more ms to hit 2000ms — should trigger
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher.fetchPRState).toHaveBeenCalledTimes(1);
    });
  });

  describe('processEventsImmediate()', () => {
    function makePRRef(overrides?: Partial<GitHubReference>): GitHubReference {
      return {
        type: 'pr', owner: 'acme', repo: 'app', number: 99,
        url: 'https://github.com/acme/app/pull/99',
        taskId: 'task-1', detectedAt: new Date(), detectedFrom: 'agent-1',
        ...overrides,
      };
    }

    it('extracts a PR URL from tool_result events, adds reference, and triggers fetch', async () => {
      const fetcher = createMockFetcher(true);
      // Create a task so resolveOwnerRepo can look it up
      const task = taskStore.createTask({ prompt: 'do stuff', cwd: '/tmp' });
      // fetchPRState returns a valid state so we can verify onChanges
      const prState: GitHubPRState = {
        ref: makePRRef({ taskId: task.id }),
        title: 'Fix bug',
        status: 'open',
        mergeable: 'MERGEABLE',
        author: 'alice',
        branch: 'fix-bug',
        baseBranch: 'main',
        reviewDecision: null,
        reviewers: [],
        unresolvedThreads: [],
        totalComments: 0,
        checks: [],
        lastFetchedAt: new Date(),
      };
      (fetcher.fetchPRState as ReturnType<typeof vi.fn>).mockResolvedValue(prState);
      (fetcher.inferOwnerRepo as ReturnType<typeof vi.fn>).mockResolvedValue({ owner: 'acme', repo: 'app' });

      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: DEFAULT_GITHUB_SCANNER_CONFIG,
        onChanges,
      });
      await scanner.start();

      // Build the gh pr create tool_use/tool_result pair that contains a PR URL
      const events: AgentEvent[] = [
        {
          type: 'tool_use',
          sessionId: 'sess-1',
          toolName: 'Bash',
          toolInput: { command: 'gh pr create --title "Fix bug"' },
          toolUseId: 'tool-1',
        },
        {
          type: 'tool_result',
          sessionId: 'sess-1',
          toolName: 'Bash',
          toolResponse: 'Created PR https://github.com/acme/app/pull/99',
          toolUseId: 'tool-1',
        },
      ];

      await scanner.processEventsImmediate('agent-1', events, task.id);

      // Reference should be in the state store
      const refs = stateStore.getReferences(task.id);
      expect(refs).toHaveLength(1);
      expect(refs[0].owner).toBe('acme');
      expect(refs[0].repo).toBe('app');
      expect(refs[0].number).toBe(99);
      expect(taskStore.getTask(task.id)?.projectId).toBe('github.com/acme/app');

      // fetchPRState should have been called (immediate fetch triggered)
      // Need to flush the microtask queue for the void fetchAllStates() call
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher.fetchPRState).toHaveBeenCalled();
    });

    it('is a no-op when gh is not available', async () => {
      const fetcher = createMockFetcher(false);
      const task = taskStore.createTask({ prompt: 'do stuff', cwd: '/tmp' });
      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: DEFAULT_GITHUB_SCANNER_CONFIG,
        onChanges,
      });
      await scanner.start(); // returns false because gh unavailable

      const events: AgentEvent[] = [
        {
          type: 'tool_use',
          sessionId: 'sess-1',
          toolName: 'Bash',
          toolInput: { command: 'gh pr create --title "Fix bug"' },
          toolUseId: 'tool-1',
        },
        {
          type: 'tool_result',
          sessionId: 'sess-1',
          toolName: 'Bash',
          toolResponse: 'Created PR https://github.com/acme/app/pull/99',
          toolUseId: 'tool-1',
        },
      ];

      await scanner.processEventsImmediate('agent-1', events, task.id);

      // No reference should be added
      expect(stateStore.getReferences(task.id)).toHaveLength(0);
      expect(fetcher.fetchPRState).not.toHaveBeenCalled();
    });
  });

  describe('processTaskPrompt()', () => {
    it('extracts issue reference from prompt and adds it to stateStore', async () => {
      const fetcher = createMockFetcher(true);
      (fetcher.inferOwnerRepo as ReturnType<typeof vi.fn>).mockResolvedValue({ owner: 'acme', repo: 'app' });
      const task = taskStore.createTask({ prompt: 'fix issue #42', cwd: '/tmp' });

      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: DEFAULT_GITHUB_SCANNER_CONFIG,
        onChanges,
      });
      await scanner.start();

      await scanner.processTaskPrompt(task.id);

      const refs = stateStore.getReferences(task.id);
      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('issue');
      expect(refs[0].number).toBe(42);
      expect(refs[0].owner).toBe('acme');
      expect(refs[0].repo).toBe('app');
    });

    it('is idempotent — second call for same taskId does not re-scan', async () => {
      const fetcher = createMockFetcher(true);
      (fetcher.inferOwnerRepo as ReturnType<typeof vi.fn>).mockResolvedValue({ owner: 'acme', repo: 'app' });
      const task = taskStore.createTask({ prompt: 'fix issue #42', cwd: '/tmp' });

      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: DEFAULT_GITHUB_SCANNER_CONFIG,
        onChanges,
      });
      await scanner.start();

      await scanner.processTaskPrompt(task.id);
      const refsAfterFirst = stateStore.getReferences(task.id);
      expect(refsAfterFirst).toHaveLength(1);

      // Call again — should not duplicate
      await scanner.processTaskPrompt(task.id);
      const refsAfterSecond = stateStore.getReferences(task.id);
      expect(refsAfterSecond).toHaveLength(1);

      // inferOwnerRepo should only be called once (prompt scan was skipped on 2nd call)
      expect(fetcher.inferOwnerRepo).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when gh is not available', async () => {
      const fetcher = createMockFetcher(false);
      const task = taskStore.createTask({ prompt: 'fix issue #42', cwd: '/tmp' });

      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: DEFAULT_GITHUB_SCANNER_CONFIG,
        onChanges,
      });
      await scanner.start();

      await scanner.processTaskPrompt(task.id);

      expect(stateStore.getReferences(task.id)).toHaveLength(0);
      expect(fetcher.inferOwnerRepo).not.toHaveBeenCalled();
    });
  });

  describe('fetchAllStates (via timer tick)', () => {
    function makePRRef(taskId: string, number: number): GitHubReference {
      return {
        type: 'pr', owner: 'acme', repo: 'app', number,
        url: `https://github.com/acme/app/pull/${number}`,
        taskId, detectedAt: new Date(), detectedFrom: 'agent-1',
      };
    }

    function makePRState(ref: GitHubReference): GitHubPRState {
      return {
        ref,
        title: `PR #${ref.number}`,
        status: 'open',
        mergeable: 'MERGEABLE',
        author: 'alice',
        branch: 'feature',
        baseBranch: 'main',
        reviewDecision: null,
        reviewers: [],
        unresolvedThreads: [],
        totalComments: 0,
        checks: [],
        lastFetchedAt: new Date(),
      };
    }

    function makeIssueRef(taskId: string, number: number): GitHubReference {
      return {
        type: 'issue', owner: 'acme', repo: 'app', number,
        url: `https://github.com/acme/app/issues/${number}`,
        taskId, detectedAt: new Date(), detectedFrom: 'agent-1',
      };
    }

    function makeIssueState(ref: GitHubReference): GitHubIssueState {
      return {
        ref,
        title: `Issue #${ref.number}`,
        status: 'open',
        author: 'alice',
        labels: [],
        commentCount: 0,
        lastFetchedAt: new Date(),
      };
    }

    it('uses batched fetchStates once per tick when the fetcher supports it', async () => {
      const fetcher = createMockFetcher(true);
      const prRef = makePRRef('task-1', 1);
      const issueRef = makeIssueRef('task-1', 2);
      stateStore.addReference(prRef);
      stateStore.addReference(issueRef);
      fetcher.fetchStates = vi.fn().mockResolvedValue({
        prs: [makePRState(prRef)],
        issues: [makeIssueState(issueRef)],
      });

      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: { ...DEFAULT_GITHUB_SCANNER_CONFIG, stateFetchIntervalMs: 1000 },
        onChanges,
      });
      await scanner.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(fetcher.fetchStates).toHaveBeenCalledTimes(1);
      expect(fetcher.fetchStates).toHaveBeenCalledWith([prRef, issueRef]);
      expect(fetcher.fetchPRState).not.toHaveBeenCalled();
      expect(fetcher.fetchIssueState).not.toHaveBeenCalled();
      expect(stateStore.getTaskState('task-1').prs).toHaveLength(1);
      expect(stateStore.getTaskState('task-1').issues).toHaveLength(1);
    });

    it('backs off batched state fetches when GitHub returns a rate-limit diagnostic', async () => {
      const fetcher = createMockFetcher(true);
      const ref = makePRRef('task-1', 1);
      stateStore.addReference(ref);
      fetcher.fetchStates = vi.fn()
        .mockResolvedValueOnce({
          prs: [],
          issues: [],
          rateLimit: {
            kind: 'rate-limited',
            retryAfterMs: 5_000,
            message: 'RATE_LIMITED: API rate limit exceeded',
          },
        })
        .mockResolvedValueOnce({
          prs: [makePRState(ref)],
          issues: [],
        });

      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: { ...DEFAULT_GITHUB_SCANNER_CONFIG, stateFetchIntervalMs: 1000 },
        onChanges,
      });
      await scanner.start();

      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await vi.advanceTimersByTimeAsync(1000);
      expect(fetcher.fetchStates).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4000);
      expect(fetcher.fetchStates).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(fetcher.fetchStates).toHaveBeenCalledTimes(2);
      expect(stateStore.getTaskState('task-1').prs).toHaveLength(1);

      consoleWarn.mockRestore();
    });

    it('fetches only newly detected refs immediately instead of refetching all known refs', async () => {
      const fetcher = createMockFetcher(true);
      fetcher.fetchStates = vi.fn().mockResolvedValue({ prs: [], issues: [] });
      const task = taskStore.createTask({ prompt: 'do stuff', cwd: '/tmp' });
      const existingRef = makePRRef(task.id, 1);
      stateStore.addReference(existingRef);
      (fetcher.inferOwnerRepo as ReturnType<typeof vi.fn>).mockResolvedValue({ owner: 'acme', repo: 'app' });

      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: DEFAULT_GITHUB_SCANNER_CONFIG,
        onChanges,
      });
      await scanner.start();

      const events: AgentEvent[] = [
        {
          type: 'tool_use',
          sessionId: 'sess-1',
          toolName: 'Bash',
          toolInput: { command: 'gh pr create --title "Fix"' },
          toolUseId: 'tool-99',
        },
        {
          type: 'tool_result',
          sessionId: 'sess-1',
          toolName: 'Bash',
          toolResponse: 'Created PR https://github.com/acme/app/pull/99',
          toolUseId: 'tool-99',
        },
      ];
      await scanner.processEventsImmediate('agent-1', events, task.id);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetcher.fetchStates).toHaveBeenCalledTimes(1);
      expect(fetcher.fetchStates).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'pr', owner: 'acme', repo: 'app', number: 99 }),
      ]);
    });

    it('concurrent fetch guard: second call returns immediately while first is in progress', async () => {
      const fetcher = createMockFetcher(true);
      const ref = makePRRef('task-1', 1);
      stateStore.addReference(ref);

      // fetchPRState returns a promise that we control manually
      let resolveFetch!: (v: GitHubPRState) => void;
      (fetcher.fetchPRState as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise<GitHubPRState>((resolve) => { resolveFetch = resolve; }),
      );

      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: { ...DEFAULT_GITHUB_SCANNER_CONFIG, stateFetchIntervalMs: 1000 },
        onChanges,
      });
      await scanner.start();

      // First tick fires and starts a fetch (which hangs on our controlled promise)
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetcher.fetchPRState).toHaveBeenCalledTimes(1);

      // Second tick fires while the first is still in progress — should be skipped
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetcher.fetchPRState).toHaveBeenCalledTimes(1); // still 1, no duplicate

      // Resolve the first fetch to unblock
      resolveFetch(makePRState(ref));
      await vi.advanceTimersByTimeAsync(0); // flush microtasks

      // Third tick should proceed normally now
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetcher.fetchPRState).toHaveBeenCalledTimes(2);
    });

    it('per-ref error handling: one failing ref does not prevent fetching others', async () => {
      const fetcher = createMockFetcher(true);
      const ref1 = makePRRef('task-1', 1);
      const ref2 = makePRRef('task-1', 2);
      stateStore.addReference(ref1);
      stateStore.addReference(ref2);

      // First ref throws, second returns normally
      (fetcher.fetchPRState as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('API rate limit'))
        .mockResolvedValueOnce(makePRState(ref2));

      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: { ...DEFAULT_GITHUB_SCANNER_CONFIG, stateFetchIntervalMs: 1000 },
        onChanges,
      });
      await scanner.start();

      // Suppress expected console.error
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await vi.advanceTimersByTimeAsync(1000);

      // Both refs should have been attempted
      expect(fetcher.fetchPRState).toHaveBeenCalledTimes(2);
      // The error was logged
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('error fetching pr'),
        expect.any(Error),
      );

      consoleError.mockRestore();
    });

    it('generation guard: stop() mid-fetch causes remaining refs to be skipped', async () => {
      const fetcher = createMockFetcher(true);
      const ref1 = makePRRef('task-1', 1);
      const ref2 = makePRRef('task-1', 2);
      stateStore.addReference(ref1);
      stateStore.addReference(ref2);

      // First ref fetch calls stop() as a side effect, then resolves
      (fetcher.fetchPRState as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(async () => {
          scanner!.stop();
          return makePRState(ref1);
        })
        .mockResolvedValueOnce(makePRState(ref2));

      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: { ...DEFAULT_GITHUB_SCANNER_CONFIG, stateFetchIntervalMs: 1000 },
        onChanges,
      });
      await scanner.start();

      await vi.advanceTimersByTimeAsync(1000);

      // First ref was fetched, but second should be skipped due to generation change
      expect(fetcher.fetchPRState).toHaveBeenCalledTimes(1);
      expect(scanner.isActive()).toBe(false);
    });
  });

  describe('repo-health tick', () => {
    it('skips invalid project ids and never calls the fetcher when no tracked repos are set', async () => {
      const repoHealthFetcher = vi.fn();
      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher: createMockFetcher(true),
        config: DEFAULT_GITHUB_SCANNER_CONFIG,
        onChanges,
        repoHealthFetcher,
      });
      await scanner.start();
      // setTrackedGithubRepos silently filters unsafe ids
      scanner.setTrackedGithubRepos(['github.com/owner/..', 'local/foo']);
      await vi.advanceTimersByTimeAsync(1);
      expect(repoHealthFetcher).not.toHaveBeenCalled();
      expect(scanner.getRepoHealthSnapshot().size).toBe(0);
    });

    it('drops cached entries for repos that left the tracked set', async () => {
      const initial = new Map([
        ['github.com/a/b', {
          openIssues: 1, openPullRequests: 2,
          pendingReviewPrs: [], repoUrl: 'https://github.com/a/b',
          lastFetchedAt: '2025-01-01T00:00:00Z',
        }],
      ]);
      const repoHealthFetcher = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(new Map());
      const onRepoHealthChanged = vi.fn();
      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher: createMockFetcher(true),
        config: DEFAULT_GITHUB_SCANNER_CONFIG,
        onChanges,
        repoHealthFetcher,
        onRepoHealthChanged,
      });
      await scanner.start();

      scanner.setTrackedGithubRepos(['github.com/a/b']);
      await vi.runOnlyPendingTimersAsync();
      // Resolve the awaited first tick
      await Promise.resolve();
      await Promise.resolve();
      // Sanity: first tick populated the cache (via the immediate kick from start())
      // We don't strictly need to assert here, but it confirms the setup.

      // Now unpin the repo entirely
      scanner.setTrackedGithubRepos([]);
      // Next tick should observe empty tracked set and clear the cache
      await vi.advanceTimersByTimeAsync(600_000);
      await Promise.resolve();
      expect(scanner.getRepoHealthSnapshot().size).toBe(0);
    });

    it('returns the result map via getRepoHealthSnapshot after a successful batch', async () => {
      const fresh = new Map([
        ['github.com/cli/cli', {
          openIssues: 10, openPullRequests: 5,
          pendingReviewPrs: [],
          repoUrl: 'https://github.com/cli/cli',
          lastFetchedAt: '2025-01-01T00:00:00Z',
        }],
      ]);
      const repoHealthFetcher = vi.fn().mockResolvedValue(fresh);
      const onRepoHealthChanged = vi.fn();
      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher: createMockFetcher(true),
        config: DEFAULT_GITHUB_SCANNER_CONFIG,
        onChanges,
        repoHealthFetcher,
        onRepoHealthChanged,
      });
      await scanner.start();
      scanner.setTrackedGithubRepos(['github.com/cli/cli']);
      // The first kick was at start() with empty tracked set; trigger another tick now
      await vi.advanceTimersByTimeAsync(600_000);
      // Flush awaited microtasks from inside the tick
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const snap = scanner.getRepoHealthSnapshot();
      expect(snap.get('github.com/cli/cli')?.openIssues).toBe(10);
      expect(onRepoHealthChanged).toHaveBeenCalled();
    });

    it('preserves cache on whole-batch failure (fetcher returns null)', async () => {
      const ok = new Map([
        ['github.com/cli/cli', {
          openIssues: 3, openPullRequests: 1,
          pendingReviewPrs: [],
          repoUrl: 'https://github.com/cli/cli',
          lastFetchedAt: '2025-01-01T00:00:00Z',
        }],
      ]);
      const repoHealthFetcher = vi.fn()
        .mockResolvedValueOnce(ok)
        .mockResolvedValueOnce(null); // second tick: whole-batch failure
      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher: createMockFetcher(true),
        config: DEFAULT_GITHUB_SCANNER_CONFIG,
        onChanges,
        repoHealthFetcher,
      });
      await scanner.start();
      scanner.setTrackedGithubRepos(['github.com/cli/cli']);
      await vi.advanceTimersByTimeAsync(600_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // Second tick (null) must not blow away the cache
      await vi.advanceTimersByTimeAsync(600_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(scanner.getRepoHealthSnapshot().get('github.com/cli/cli')?.openIssues).toBe(3);
    });

    it('preserves cache and suppresses repo-health polling during rate-limit backoff', async () => {
      const ok = new Map([
        ['github.com/cli/cli', {
          openIssues: 3, openPullRequests: 1,
          pendingReviewPrs: [],
          repoUrl: 'https://github.com/cli/cli',
          lastFetchedAt: '2025-01-01T00:00:00Z',
        }],
      ]);
      const updated = new Map([
        ['github.com/cli/cli', {
          openIssues: 4, openPullRequests: 1,
          pendingReviewPrs: [],
          repoUrl: 'https://github.com/cli/cli',
          lastFetchedAt: '2025-01-01T00:10:00Z',
        }],
      ]);
      const repoHealthFetcher = vi.fn()
        .mockResolvedValueOnce(ok)
        .mockResolvedValueOnce({
          kind: 'rate-limited',
          retryAfterMs: 1_200_000,
          message: 'RATE_LIMITED: API rate limit exceeded',
        })
        .mockResolvedValueOnce(updated);
      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher: createMockFetcher(true),
        config: DEFAULT_GITHUB_SCANNER_CONFIG,
        onChanges,
        repoHealthFetcher,
      });
      await scanner.start();
      scanner.setTrackedGithubRepos(['github.com/cli/cli']);

      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await vi.advanceTimersByTimeAsync(600_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(scanner.getRepoHealthSnapshot().get('github.com/cli/cli')?.openIssues).toBe(3);

      await vi.advanceTimersByTimeAsync(600_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(repoHealthFetcher).toHaveBeenCalledTimes(2);
      expect(scanner.getRepoHealthSnapshot().get('github.com/cli/cli')?.openIssues).toBe(3);

      await vi.advanceTimersByTimeAsync(600_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(repoHealthFetcher).toHaveBeenCalledTimes(3);
      expect(scanner.getRepoHealthSnapshot().get('github.com/cli/cli')?.openIssues).toBe(4);

      consoleWarn.mockRestore();
    });
  });

  describe('start() with pre-seeded reference triggers fetch and onChanges', () => {
    it('fetches PR state on timer tick and fires onChanges for first-fetch changes', async () => {
      const fetcher = createMockFetcher(true);
      const ref: GitHubReference = {
        type: 'pr', owner: 'acme', repo: 'app', number: 7,
        url: 'https://github.com/acme/app/pull/7',
        taskId: 'task-1', detectedAt: new Date(), detectedFrom: 'agent-1',
      };
      stateStore.addReference(ref);

      // Return a PR state with a failing check — diffPRState on first fetch
      // generates a ci_failed change
      const prState: GitHubPRState = {
        ref,
        title: 'Add feature',
        status: 'open',
        mergeable: 'MERGEABLE',
        author: 'bob',
        branch: 'feat',
        baseBranch: 'main',
        reviewDecision: null,
        reviewers: [],
        unresolvedThreads: [],
        totalComments: 0,
        checks: [
          { name: 'CI', status: 'completed', conclusion: 'failure' },
        ],
        lastFetchedAt: new Date(),
      };
      (fetcher.fetchPRState as ReturnType<typeof vi.fn>).mockResolvedValue(prState);

      scanner = new GitHubScannerService({
        taskStore, stateStore,
        fetcher,
        config: { ...DEFAULT_GITHUB_SCANNER_CONFIG, stateFetchIntervalMs: 2000 },
        onChanges,
      });
      await scanner.start();

      // Advance timer to trigger fetchAllStates
      await vi.advanceTimersByTimeAsync(2000);

      // fetchPRState should have been called with the pre-seeded ref
      expect(fetcher.fetchPRState).toHaveBeenCalledWith(ref);

      // onChanges should fire with the ci_failed change from first-fetch diff
      expect(onChanges).toHaveBeenCalledTimes(1);
      expect(onChanges).toHaveBeenCalledWith(
        'task-1',
        expect.arrayContaining([
          expect.objectContaining({
            type: 'ci_failed',
            check: expect.objectContaining({ name: 'CI', conclusion: 'failure' }),
          }),
        ]),
      );
    });
  });
});
