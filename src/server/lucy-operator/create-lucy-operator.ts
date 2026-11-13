/**
 * Builds Lucy's operator conversation from the server's own parts: the configuration
 * resolved at start-up, the OpenRouter stream, and a look source over the task list,
 * the findings, the quota and the projects.
 *
 * Returns what the route needs: nothing when the setting is off (the route answers
 * 404), a reason when it is on but unusable (503), or the service.
 */

import { createOpenRouterChatStream } from '../../adapters/llm/openrouter-chat-stream.js';
import { listOperatorAsks } from '../../core/operator-asks.js';
import { listProjectSummaries } from '../routes/project-routes.js';
import type { LucyOperatorRouteDeps } from '../routes/lucy-operator-routes.js';
import type { RouteDeps } from '../routes/shared.js';
import type { LucyLookSource } from '../../core/lucy-operator/tools.js';
import { renderTerminalScreenTextIsolated } from '../terminal-snapshot-worker.js';
import { createLucyLookSource } from './look-source.js';
import { createLucyOperator } from './service.js';
import { buildLucyLaunchController } from './launch-wiring.js';

/** Connect her look-ups to the server's stores. Exported so the connections can be tested one by one. */
export function buildLucyLookSource(deps: RouteDeps): LucyLookSource {
  return createLucyLookSource({
    getTasks: () => deps.taskStore.viewTasks(),
    // `inspectActive` only reads; `getAll` would also bring expired snoozes back as a side effect.
    getFindings: () => deps.queue.inspectActive(),
    getLifetimeSpendUsd: () => deps.taskStore.getLifetimeSpendUsd(),
    // The same list the panel and the spoken briefing use, so she and the card agree on what is waiting.
    getAsks: () => (deps.asks?.service ? listOperatorAsks(deps.asks.service.all(), Date.now(), (taskId) => deps.taskStore.getTask(taskId)?.name) : []),
    getQuota: () => deps.getQuotaStatus?.() ?? null,
    getReferences: (taskId) => deps.githubStateStore.getReferences(taskId),
    readTerminalStream: async (task) => {
      const session = [...task.sessions].reverse().find((s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted');
      if (session && typeof deps.adapter.captureDisplay === 'function') {
        try {
          return { text: await deps.adapter.captureDisplay(session.tmuxSession), live: true };
        } catch {
          // The session may be going away; the saved tail below is the fallback, as for GET /api/tasks/:id/tail.
        }
      }
      const stored = await deps.taskTailStore?.getByTaskId(task.id);
      return stored ? { text: stored.text, live: false } : null;
    },
    renderScreenText: renderTerminalScreenTextIsolated,
    listProjects: deps.ledgerAnalytics && deps.projectConfigStore ? () => listProjectSummaries(deps) : undefined,
  });
}

export function buildLucyOperator(deps: RouteDeps): LucyOperatorRouteDeps['lucyOperator'] {
  const config = deps.lucyOperatorConfig;
  if (!config || !config.enabled) return undefined;
  if (!config.ok) return { unavailableReason: config.reason };

  const model = createOpenRouterChatStream(config.model);
  const service = createLucyOperator({
    model,
    modelName: config.model.model,
    source: buildLucyLookSource(deps),
    // Launching is a second switch: she can answer questions without ever being able to propose a task.
    ...(config.launch ? { launch: buildLucyLaunchController(deps, model, deps.lucyInteractionLog) } : {}),
    log: deps.lucyInteractionLog,
  });
  // Lucy live (Talk) is built before the routes; it finds the service here when a turn starts.
  deps.lucyOperatorHolder?.set(service);
  return { service };
}
