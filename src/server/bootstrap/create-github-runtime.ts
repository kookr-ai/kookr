import { CircuitBreakerGitHubFetcher } from '../../adapters/circuit-breaker-github-fetcher.js';
import { fetchBatchRepoHealth, getGhUserLogin, ghCliFetcher } from '../../adapters/github-fetcher.js';
import type { CircuitBreaker } from '../../core/circuit-breaker.js';
import { formatGitHubAlert } from '../../core/github-alerts.js';
import type { GitHubFetcher } from '../../core/github-types.js';
import { DEFAULT_GITHUB_SCANNER_CONFIG, type GitHubStateChange } from '../../core/github-types.js';
import {
  GitHubScannerService,
  type GhUserLoginResolver,
  type NonCriticalTickPauseHook,
  type RepoHealthFetcher,
} from '../../core/github-scanner-service.js';
import { GitHubStateStore, taskRecordAuthorshipPersistence } from '../../core/github-state-store.js';
import { isTerminalStatus } from '../../core/task-status.js';
import type { TaskStore } from '../../core/tasks.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { finishedTaskPrReferences, PrDeliveryTracker, type PrDeliveryTrackerDeps } from '../pr-delivery-tracker.js';

/** Finished tasks whose PRs are re-tracked after a restart (issue #3915). */
const FINISHED_TASK_PR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface GitHubRuntimeDeps {
  taskStore: TaskStore;
  githubBreaker: CircuitBreaker;
  githubPollingIntervalSec: number;
  broadcastToAll: (msg: ServerMessage) => void;
  onRepoHealthChanged: () => void;
  fetcher?: GitHubFetcher;
  repoHealthFetcher?: RepoHealthFetcher;
  ghUserLoginResolver?: GhUserLoginResolver;
  /** Event-loop pressure gate for periodic scanner ticks (issue #1785). */
  nonCriticalTickPause?: NonCriticalTickPauseHook;
  /**
   * Delivery state of tracked PRs (issue #3915). When set, a tracker derives
   * it after every PR update and once a minute, and finished tasks' PRs are
   * re-tracked from their completion digest each time the scanner starts.
   */
  prDelivery?: Pick<PrDeliveryTrackerDeps, 'kookrDir' | 'resolveRepoPath' | 'git' | 'readText' | 'trainStateDir'> & {
    intervalMs?: number;
    now?: () => Date;
  };
}

export interface GitHubRuntime {
  githubStateStore: GitHubStateStore;
  githubScanner: GitHubScannerService;
  prDeliveryTracker: PrDeliveryTracker | null;
}

export function createGitHubRuntime(deps: GitHubRuntimeDeps): GitHubRuntime {
  // Authorship evidence lives on each task record, so attribution survives a
  // restart (issue #4077).
  const githubStateStore = new GitHubStateStore(taskRecordAuthorshipPersistence(deps.taskStore));
  const githubScannerConfig = {
    ...DEFAULT_GITHUB_SCANNER_CONFIG,
    stateFetchIntervalMs: deps.githubPollingIntervalSec * 1000,
    referenceExtractionIntervalMs: deps.githubPollingIntervalSec * 1000,
  };
  const fetcher = new CircuitBreakerGitHubFetcher(deps.fetcher ?? ghCliFetcher, deps.githubBreaker);

  const broadcastTaskState = (taskId: string, changes: GitHubStateChange[]): void => {
    const state = githubStateStore.getTaskState(taskId);
    deps.broadcastToAll({
      type: 'githubUpdate',
      taskId,
      prs: state.prs,
      issues: state.issues,
      changes,
    });
  };
  const prDeliveryTracker = deps.prDelivery
    ? new PrDeliveryTracker({
      ...deps.prDelivery,
      store: githubStateStore,
      onDeliveryChanged: (taskId) => broadcastTaskState(taskId, []),
    })
    : null;
  prDeliveryTracker?.start(deps.prDelivery?.intervalMs);
  const now = deps.prDelivery?.now ?? (() => new Date());

  const githubScanner = new GitHubScannerService({
    taskStore: deps.taskStore,
    stateStore: githubStateStore,
    fetcher,
    config: githubScannerConfig,
    repoHealthFetcher: deps.repoHealthFetcher ?? fetchBatchRepoHealth,
    ghUserLoginResolver: deps.ghUserLoginResolver ?? getGhUserLogin,
    onRepoHealthChanged: deps.onRepoHealthChanged,
    ...(deps.nonCriticalTickPause ? { nonCriticalTickPause: deps.nonCriticalTickPause } : {}),
    ...(prDeliveryTracker
      ? {
        onStarted: () => {
          const refs = finishedTaskPrReferences(
            deps.taskStore.viewTasks(), now(), FINISHED_TASK_PR_WINDOW_MS,
            (status) => isTerminalStatus(status as Parameters<typeof isTerminalStatus>[0]),
          );
          if (refs.length > 0) void githubScanner.trackReferences(refs);
        },
      }
      : {}),
    onStateUpdate: (taskId) => {
      broadcastTaskState(taskId, []);
      void prDeliveryTracker?.refresh();
    },
    onChanges: (taskId, changes) => {
      broadcastTaskState(taskId, changes);
      broadcastGitHubAlerts(deps.broadcastToAll, changes);
      void prDeliveryTracker?.refresh();
    },
  });

  return { githubStateStore, githubScanner, prDeliveryTracker };
}

function broadcastGitHubAlerts(
  broadcastToAll: (msg: ServerMessage) => void,
  changes: GitHubStateChange[],
): void {
  for (const change of changes) {
    const ref = change.ref;
    const label = `${ref.owner}/${ref.repo}#${ref.number}`;
    const alert = formatGitHubAlert(change, label);

    if (alert) {
      broadcastToAll({
        type: 'alert',
        agentId: ref.detectedFrom,
        summary: alert.summary,
        details: '',
        severity: alert.severity,
      });
    }
  }
}
