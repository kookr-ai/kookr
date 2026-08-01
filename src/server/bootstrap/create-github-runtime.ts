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
import { GitHubStateStore } from '../../core/github-state-store.js';
import type { TaskStore } from '../../core/tasks.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';

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
}

export interface GitHubRuntime {
  githubStateStore: GitHubStateStore;
  githubScanner: GitHubScannerService;
}

export function createGitHubRuntime(deps: GitHubRuntimeDeps): GitHubRuntime {
  const githubStateStore = new GitHubStateStore();
  const githubScannerConfig = {
    ...DEFAULT_GITHUB_SCANNER_CONFIG,
    stateFetchIntervalMs: deps.githubPollingIntervalSec * 1000,
    referenceExtractionIntervalMs: deps.githubPollingIntervalSec * 1000,
  };
  const fetcher = new CircuitBreakerGitHubFetcher(deps.fetcher ?? ghCliFetcher, deps.githubBreaker);

  const githubScanner = new GitHubScannerService({
    taskStore: deps.taskStore,
    stateStore: githubStateStore,
    fetcher,
    config: githubScannerConfig,
    repoHealthFetcher: deps.repoHealthFetcher ?? fetchBatchRepoHealth,
    ghUserLoginResolver: deps.ghUserLoginResolver ?? getGhUserLogin,
    onRepoHealthChanged: deps.onRepoHealthChanged,
    ...(deps.nonCriticalTickPause ? { nonCriticalTickPause: deps.nonCriticalTickPause } : {}),
    onStateUpdate: (taskId) => {
      const state = githubStateStore.getTaskState(taskId);
      deps.broadcastToAll({
        type: 'githubUpdate',
        taskId,
        prs: state.prs,
        issues: state.issues,
        changes: [],
      });
    },
    onChanges: (taskId, changes) => {
      const state = githubStateStore.getTaskState(taskId);
      deps.broadcastToAll({
        type: 'githubUpdate',
        taskId,
        prs: state.prs,
        issues: state.issues,
        changes,
      });

      broadcastGitHubAlerts(deps.broadcastToAll, changes);
    },
  });

  return { githubStateStore, githubScanner };
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
