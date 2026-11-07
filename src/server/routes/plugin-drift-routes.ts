import type { Hono } from 'hono';
import type { TaskStore } from '../../core/tasks.js';
import { isTerminalStatus } from '../../core/task-status.js';
import {
  ConfigEpochStore,
  computeConfigDrift,
  type SessionEpochView,
} from '../plugin-manager/config-epoch.js';
import type { ConfigDriftSurface } from '../../shared/contracts/plugins.js';
import { EXTERNAL_TUI_COVERAGE_NOTE } from '../../shared/contracts/plugins.js';

/**
 * Deps for the config-epoch reload-drift surface (RFC "Surfacing reload drift").
 * Separate from `DeployRouteDeps` (which deliberately does NOT touch task state):
 * the drift read needs the task list to see which Kookr-managed sessions started
 * before the latest config change, so it is registered with task access rather
 * than widening the deploy/plugin slice.
 */
export interface PluginDriftRouteDeps {
  taskStore: TaskStore;
  /** Kookr data dir; the epoch store lives here (same file the mutation routes bump). */
  kookrDir?: string;
  serverCwd: string;
}

/**
 * `GET /api/plugins/config-drift` — the reload-drift surface. Reports the current
 * config epoch and the non-terminal Kookr-managed Claude sessions that started
 * under an older epoch (so "N sessions started before your last change" has a
 * concrete list + a restart target). The restart action itself is the dashboard's
 * existing relaunch flow, keyed by the returned task ids; external TUIs are stated
 * as out of coverage.
 */
export function registerPluginDriftRoutes(app: Hono, deps: PluginDriftRouteDeps): void {
  const epochStore = new ConfigEpochStore(deps.kookrDir ?? deps.serverCwd);

  app.get('/api/plugins/config-drift', async (c) => {
    try {
      const currentEpoch = await epochStore.current();
      const sessions: SessionEpochView[] = deps.taskStore.getAllTasks().map((task) => ({
        taskId: task.id,
        agentType: task.agentType,
        isTerminal: isTerminalStatus(task.status),
        configEpochAtStart: task.configEpochAtStart,
        startedAt: task.createdAt.toISOString(),
        ...(task.name ? { title: task.name } : {}),
      }));
      return c.json<ConfigDriftSurface>(computeConfigDrift(currentEpoch, sessions));
    } catch (err) {
      // Degrade, don't 500: an empty drift surface is a safe "nothing to restart".
      console.error(
        `[plugins] config-drift read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json<ConfigDriftSurface>({
        currentEpoch: 0,
        staleSessions: [],
        staleCount: 0,
        externalCoverageNote: EXTERNAL_TUI_COVERAGE_NOTE,
      });
    }
  });
}
