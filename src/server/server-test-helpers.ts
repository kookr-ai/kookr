import type { Server } from 'node:http';
import type { Hono } from 'hono';

import type { TaskStore } from '../core/tasks.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { Monitor } from '../core/monitor.js';
import type { TokenTracker } from '../core/token-tracker.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import type { DeferredTelemetryLogWriter } from '../core/telemetry.js';
import type { GitHubScannerService } from '../core/github-scanner-service.js';
import type { OssAttemptStore } from '../core/oss-attempt-store.js';
import type { ProjectConfigStore } from '../core/project-config-store.js';
import type { ProjectSidebarStore } from '../core/project-sidebar-store.js';
import type { CircuitBreakerRegistry } from '../core/circuit-breaker.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { HookFileWatcher } from './hook-watcher.js';
import type { Watchdog } from '../core/watchdog.js';
import type { ServerMessage } from '../shared/protocol.js';
import type { RemoteLaunchBroker } from '../remote/launch-broker.js';
import type { ControllerLeaseManager } from '../remote/controller-lease.js';
import type { RemoteInputAdapter } from './remote-input-adapter.js';
import type { ActivityLedger } from '../core/activity-ledger.js';

/** Full server surface for tests and local helpers. */
export interface KookrServerInternal {
  close(): Promise<void>;
  broadcastToAll(msg: ServerMessage): void;
  httpServer: Server;
  taskStore: TaskStore;
  queue: AttentionQueue;
  monitor: Monitor;
  adapter: AgentAdapter;
  hookWatcher: HookFileWatcher;
  tokenTracker: TokenTracker;
  interactionLog: DeferredInteractionLogWriter;
  telemetryLog: DeferredTelemetryLogWriter;
  githubScanner: GitHubScannerService;
  watchdog: Watchdog;
  ossAttemptStore: OssAttemptStore;
  projectConfigStore: ProjectConfigStore;
  projectSidebarStore: ProjectSidebarStore;
  circuitBreakerRegistry: CircuitBreakerRegistry;
  remoteLaunchBroker?: RemoteLaunchBroker;
  controllerLeaseManager?: ControllerLeaseManager | null;
  remoteInputAdapter?: RemoteInputAdapter | null;
  app: Hono;
  activityLedger: ActivityLedger;
}
