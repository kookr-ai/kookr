/**
 * Builds Lucy's operator conversation from the server's own parts: the configuration
 * resolved at start-up, the OpenRouter stream, and a look source over the task list,
 * the findings, the quota, the terminals and the projects.
 *
 * Returns what the route needs: nothing when the setting is off (the route answers
 * 404), a reason when it is on but unusable (503), or the service.
 */

import { createOpenRouterChatStream } from '../../adapters/llm/openrouter-chat-stream.js';
import { listProjectSummaries } from '../routes/project-routes.js';
import type { LucyOperatorRouteDeps } from '../routes/lucy-operator-routes.js';
import type { RouteDeps } from '../routes/shared.js';
import { createLucyLookSource } from './look-source.js';
import { createLucyOperator } from './service.js';

export function buildLucyOperator(deps: RouteDeps): LucyOperatorRouteDeps['lucyOperator'] {
  const config = deps.lucyOperatorConfig;
  if (!config || !config.enabled) return undefined;
  if (!config.ok) return { unavailableReason: config.reason };

  const source = createLucyLookSource({
    getTasks: () => deps.taskStore.viewTasks(),
    getFindings: () => deps.queue.getAll(),
    getLifetimeSpendUsd: () => deps.taskStore.getLifetimeSpendUsd(),
    getQuota: () => deps.getQuotaStatus?.() ?? null,
    captureDisplay: typeof deps.adapter.captureDisplay === 'function' ? (sessionId) => deps.adapter.captureDisplay(sessionId) : undefined,
    getStoredTail: deps.taskTailStore ? (taskId) => deps.taskTailStore!.getByTaskId(taskId) : undefined,
    getReferences: (taskId) => deps.githubStateStore.getReferences(taskId),
    listProjects: deps.ledgerAnalytics && deps.projectConfigStore ? () => listProjectSummaries(deps) : undefined,
  });

  return {
    service: createLucyOperator({
      model: deps.lucyOperatorModel ?? createOpenRouterChatStream(config.model),
      modelName: config.model.model,
      source,
      log: deps.lucyInteractionLog,
    }),
  };
}
