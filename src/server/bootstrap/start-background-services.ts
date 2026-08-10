import type { OssAttemptStore } from '../../core/oss-attempt-store.js';
import type { LedgerAnalytics } from '../../core/ledger-analytics.js';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { GitHubScannerService } from '../../core/github-scanner-service.js';
import { clearAllTimers, startLifecycleTimers, type TimerDeps, type TimerHandles } from '../lifecycle-timers.js';
import { startLedgerWatcher } from '../ledger-watcher.js';
import type { ScheduleRunner } from '../schedule-runner.js';
import type { IdleRefineryRunner } from '../idle-refinery-runner.js';
import type { PostRecoveryService } from '../post-recovery-service.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import type { ResourceStatusService } from '../resource-status-service.js';
import type { ResourceWatchdogService } from '../resource-watchdog-service.js';
import type { FindingEvidenceReviewSampler } from '../finding-evidence-review-sampler.js';
import type { ScheduledWorktreeReclaimRunner } from '../scheduled-worktree-reclaim-runner.js';

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
  /**
   * Idle-slot idea refinery runner (issue #2144). Started after the server is
   * listening (alongside the schedule runner) and stopped on shutdown. Optional
   * for older wiring/tests that don't construct one.
   */
  idleRefineryRunner?: Pick<IdleRefineryRunner, 'start' | 'stop'>;
  /**
   * Post-recovery critical-schedule re-arm + queue-fill kick (issue #2196).
   * Optional for older wiring/tests.
   */
  postRecoveryService?: Pick<PostRecoveryService, 'start' | 'stop'>;
  timerDeps: TimerDeps;
  resourceStatusService?: ResourceStatusService;
  /** Host-pressure actuator (issue #1724). No-op when disabled via env. */
  resourceWatchdogService?: Pick<ResourceWatchdogService, 'start' | 'stop'>;
  findingEvidenceReviewSampler?: Pick<FindingEvidenceReviewSampler, 'start' | 'stop'>;
  /** Unattended worktree-reclaim scheduler (issue #1578). No-op unless configured. */
  scheduledWorktreeReclaimRunner?: Pick<ScheduledWorktreeReclaimRunner, 'start' | 'stop'>;
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
  deps.resourceWatchdogService?.start();

  return {
    timerHandles,
    startAfterListen(): void {
      deps.scheduleRunner.start();
      deps.idleRefineryRunner?.start();
      deps.postRecoveryService?.start();
      deps.findingEvidenceReviewSampler?.start();
      deps.scheduledWorktreeReclaimRunner?.start();
    },
    async stop(): Promise<void> {
      clearAllTimers(timerHandles);
      await deps.scheduleRunner.stop();
      await deps.idleRefineryRunner?.stop();
      await deps.postRecoveryService?.stop();
      deps.githubScanner.stop();
      deps.resourceStatusService?.stop();
      deps.resourceWatchdogService?.stop();
      deps.findingEvidenceReviewSampler?.stop();
      await deps.scheduledWorktreeReclaimRunner?.stop();
      ledgerWatcher.close();
    },
  };
}
