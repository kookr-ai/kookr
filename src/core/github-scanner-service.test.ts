import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubScannerService } from './github-scanner-service.js';
import { GitHubStateStore } from './github-state-store.js';
import { TaskStore } from './tasks.js';
import { DEFAULT_GITHUB_SCANNER_CONFIG } from './github-types.js';
import type { GitHubFetcher, GitHubPRState, GitHubReference } from './github-types.js';
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

      // Build a tool_result event that contains a PR URL
      const events: AgentEvent[] = [
        {
          type: 'tool_result',
          sessionId: 'sess-1',
          toolName: 'Bash',
          toolResponse: 'Created PR https://github.com/acme/app/pull/99',
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
          type: 'tool_result',
          sessionId: 'sess-1',
          toolName: 'Bash',
          toolResponse: 'Created PR https://github.com/acme/app/pull/99',
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
        expect.stringContaining('error fetching PR'),
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
