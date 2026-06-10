import { CircuitBreakerGitHubFetcher } from '../../adapters/circuit-breaker-github-fetcher.js';
import { fetchBatchRepoHealth, getGhUserLogin, ghCliFetcher } from '../../adapters/github-fetcher.js';
import type { CircuitBreaker } from '../../core/circuit-breaker.js';
import { formatGitHubAlert } from '../../core/github-alerts.js';
import type { GitHubFetcher } from '../../core/github-types.js';
import { DEFAULT_GITHUB_SCANNER_CONFIG, type GitHubStateChange } from '../../core/github-types.js';
import { GitHubScannerService, type GhUserLoginResolver, type RepoHealthFetcher } from '../../core/github-scanner-service.js';
import { GitHubStateStore } from '../../core/github-state-store.js';
import type { TaskStore } from '../../core/tasks.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { GitHubChangeAgentRelay, type GitHubAgentRelayMode } from '../use-cases/github-agent-relay.js';
import type { UserInputDeliveryService } from '../user-input-delivery-service.js';

export interface GitHubRuntimeDeps {
  taskStore: TaskStore;
  githubBreaker: CircuitBreaker;
  githubPollingIntervalSec: number;
  broadcastToAll: (msg: ServerMessage) => void;
  onRepoHealthChanged: () => void;
  fetcher?: GitHubFetcher;
  repoHealthFetcher?: RepoHealthFetcher;
  ghUserLoginResolver?: GhUserLoginResolver;
  userInputDelivery?: Pick<UserInputDeliveryService, 'submitMessage'>;
  isIdleForInput?: (sessionId: string) => boolean;
  getGitHubAgentRelayMode?: () => GitHubAgentRelayMode;
}

export interface GitHubRuntime {
  githubStateStore: GitHubStateStore;
  githubScanner: GitHubScannerService;
  githubAgentRelay: GitHubChangeAgentRelay | null;
}

export function createGitHubRuntime(deps: GitHubRuntimeDeps): GitHubRuntime {
  const githubStateStore = new GitHubStateStore();
  const githubScannerConfig = {
    ...DEFAULT_GITHUB_SCANNER_CONFIG,
    stateFetchIntervalMs: deps.githubPollingIntervalSec * 1000,
    referenceExtractionIntervalMs: deps.githubPollingIntervalSec * 1000,
  };
  const fetcher = new CircuitBreakerGitHubFetcher(deps.fetcher ?? ghCliFetcher, deps.githubBreaker);
  const relayMode = deps.getGitHubAgentRelayMode?.() ?? 'off';
  const githubAgentRelay = deps.userInputDelivery && deps.isIdleForInput && deps.getGitHubAgentRelayMode
    ? new GitHubChangeAgentRelay({
        taskStore: deps.taskStore,
        githubStateStore,
        userInputDelivery: deps.userInputDelivery,
        isIdleForInput: deps.isIdleForInput,
        getMode: deps.getGitHubAgentRelayMode,
        logger: console,
      })
    : null;

  if (relayMode !== 'off') {
    console.log(`[github-agent-relay] mode=${relayMode} armed=pr_merged,pr_conflicting cap=4/task/hour`);
  }

  const githubScanner = new GitHubScannerService({
    taskStore: deps.taskStore,
    stateStore: githubStateStore,
    fetcher,
    config: githubScannerConfig,
    repoHealthFetcher: deps.repoHealthFetcher ?? fetchBatchRepoHealth,
    ghUserLoginResolver: deps.ghUserLoginResolver ?? getGhUserLogin,
    onRepoHealthChanged: deps.onRepoHealthChanged,
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
      githubAgentRelay?.onChanges(taskId, changes);
    },
  });

  return { githubStateStore, githubScanner, githubAgentRelay };
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
