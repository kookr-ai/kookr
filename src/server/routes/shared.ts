import type { TaskStore } from '../../core/tasks.js';
import type { Monitor } from '../../core/monitor.js';
import type { AttentionQueue } from '../../core/attention-queue.js';
import type { AgentAdapter } from '../../adapters/agent-adapter.js';
import type { TerminalBackend } from '../../adapters/terminal-backend.js';
import type { HookFileWatcher } from '../hook-watcher.js';
import type { Watchdog } from '../../core/watchdog.js';
import type { DeferredInteractionLogWriter } from '../../core/interaction-log.js';
import type { GitHubScannerService } from '../../core/github-scanner-service.js';
import type { GitHubStateStore } from '../../core/github-state-store.js';
import type { BuildInfo } from '../../core/build-info.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import type { ShadowDetectorRegistry } from '../../core/shadow-detector.js';
import type { HttpPushTracker } from '../../core/http-push-tracker.js';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { OssAttemptStore } from '../../core/oss-attempt-store.js';
import type { LedgerAnalytics } from '../../core/ledger-analytics.js';
import type { OssRefresher } from '../oss-refresh.js';
import type { SkillDiscoveryStateHolder } from '../../core/skill-tracked-repo-discovery.js';
import type { PrLessonsStateHolder } from '../../core/pr-lessons-discovery.js';
import type { KookrSettings } from '../../core/settings-store.js';
import type { CircuitBreakerRegistry } from '../../core/circuit-breaker.js';
import type { AutonomyOrchestrator } from '../autonomy-orchestrator.js';
import type { SnoozeSuppressionTracker } from '../../core/snooze-suppression.js';
import type { ScheduleRunner } from '../schedule-runner.js';
import type { ScheduleService } from '../schedule-service.js';
import type { LaunchServiceDeps } from '../launch-service.js';
import type { DiagnosticRunner } from '../diagnostic-runner.js';
import type { CrashRecoveryResult } from '../crash-recovery.js';
import type { RalphCycler } from '../../core/ralph-cycler.js';
import type { TokenTracker } from '../../core/token-tracker.js';
import type { RalphLoopService } from '../ralph-loop-service.js';

export interface RouteDeps {
  taskStore: TaskStore;
  monitor: Monitor;
  queue: AttentionQueue;
  adapter: AgentAdapter;
  hookWatcher: HookFileWatcher;
  watchdog: Watchdog;
  interactionLog: DeferredInteractionLogWriter;
  githubScanner: GitHubScannerService;
  githubStateStore: GitHubStateStore;
  buildInfo: BuildInfo;
  serverStartedAt: string;
  serverCwd: string;
  /** Port this server bound to. Surfaced via `/api/deploy/status` so the dashboard can detect dev (non-prod) instances and avoid silently triggering prod deploys. */
  serverPort: number;
  frontendDir: string;
  broadcastToAll: (msg: ServerMessage) => void;
  shadowRegistry?: ShadowDetectorRegistry;
  httpPushTracker?: HttpPushTracker;
  launchServiceDeps: LaunchServiceDeps;
  sttUrl?: string;
  projectConfigStore?: ProjectConfigStore;
  ossAttemptStore?: OssAttemptStore;
  ledgerAnalytics?: LedgerAnalytics;
  ossRefresher?: OssRefresher;
  /** Invoked after a mutation that may change the OSS attempt view. */
  broadcastOssAttempts?: () => void;
  skillDiscoveryState?: SkillDiscoveryStateHolder;
  prLessonsState?: PrLessonsStateHolder;
  /** Invoked after a mutation that may change project summaries. */
  broadcastProjectSummaries?: () => void;
  settings?: {
    get: () => KookrSettings;
    getLoadedFromDefaults: () => boolean;
    update: (settings: KookrSettings) => Promise<string[]>;
  };
  circuitBreakerRegistry?: CircuitBreakerRegistry;
  autonomyOrchestrator?: AutonomyOrchestrator;
  suppressionTracker?: SnoozeSuppressionTracker;
  scheduleService?: ScheduleService;
  scheduleRunner?: ScheduleRunner;
  diagnosticRunner?: DiagnosticRunner;
  /**
   * V8 terminal backend — exposed to routes so `/api/health` can report its
   * stats (attached sessions, pending writers, last error, etc.).
   */
  terminalBackend?: TerminalBackend;
  /** Result of the crash-recovery startup phase; fetched once by the frontend on mount. */
  startupRecoverySummary?: CrashRecoveryResult | null;
  /** Ralph iteration cycler — drives the loop state machine on Stop events. */
  ralphCycler?: RalphCycler;
  /** Token tracker — used by ralph routes to read cumulative cost. */
  tokenTracker?: TokenTracker;
  /** Singleton Ralph loop orchestration service. */
  ralphLoopService: RalphLoopService;
}
