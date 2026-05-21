import type { OssAttemptStore } from '../../core/oss-attempt-store.js';
import type { LedgerAnalytics } from '../../core/ledger-analytics.js';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { GitHubScannerService } from '../../core/github-scanner-service.js';
import { clearAllTimers, startLifecycleTimers, type TimerDeps, type TimerHandles } from '../lifecycle-timers.js';
import { startLedgerWatcher } from '../ledger-watcher.js';
import type { ScheduleRunner } from '../schedule-runner.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import type { ResourceStatusService } from '../resource-status-service.js';
import type { FindingEvidenceReviewSampler } from '../finding-evidence-review-sampler.js';

export interface BackgroundServicesDeps {
  ossAttemptStore: OssAttemptStore;
  ledgerAnalytics: LedgerAnalytics;
  projectConfigStore: ProjectConfigStore;
  broadcastProjectSummaries: () => void;
  /** Optional — wired by the server so ledger ingestion can repaint the OSS dashboard. */
  broadcastOssAttempts?: () => void;
  broadcastToAll: (msg: ServerMessage) => void;
  githubScanner: GitHubScannerService;
  githubPollingEnabled: boolean;
  scheduleRunner: ScheduleRunner;
  timerDeps: TimerDeps;
  resourceStatusService?: ResourceStatusService;
  findingEvidenceReviewSampler?: Pick<FindingEvidenceReviewSampler, 'start' | 'stop'>;
}

export interface BackgroundServices {
  timerHandles: TimerHandles;
  startAfterListen(): void;
  stop(): Promise<void>;
}

export function startBackgroundServices(deps: BackgroundServicesDeps): BackgroundServices {
  const ledgerWatcher = startLedgerWatcher({
    ossAttemptStore: deps.ossAttemptStore,
    ledgerAnalytics: deps.ledgerAnalytics,
    projectConfigStore: deps.projectConfigStore,
    broadcastProjectSummaries: deps.broadcastProjectSummaries,
    broadcastOssAttempts: deps.broadcastOssAttempts,
    broadcastToAll: deps.broadcastToAll,
  });

  const timerHandles = startLifecycleTimers(deps.timerDeps);

  if (deps.githubPollingEnabled) {
    void deps.githubScanner.start();
  } else {
    console.log('[settings] GitHub polling disabled by user settings');
  }

  deps.resourceStatusService?.start();

  return {
    timerHandles,
    startAfterListen(): void {
      deps.scheduleRunner.start();
      deps.findingEvidenceReviewSampler?.start();
    },
    async stop(): Promise<void> {
      clearAllTimers(timerHandles);
      await deps.scheduleRunner.stop();
      deps.githubScanner.stop();
      deps.resourceStatusService?.stop();
      deps.findingEvidenceReviewSampler?.stop();
      ledgerWatcher.close();
    },
  };
}
