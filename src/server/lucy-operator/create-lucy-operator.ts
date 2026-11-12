/**
 * Builds Lucy's operator conversation from the server's own parts: the configuration
 * resolved at start-up, the OpenRouter stream, and a look source over the task list,
 * the findings, the quota and the projects.
 *
 * Returns what the route needs: nothing when the setting is off (the route answers
 * 404), a reason when it is on but unusable (503), or the service.
 */

import { createOpenRouterChatStream } from '../../adapters/llm/openrouter-chat-stream.js';
import { listProjectSummaries } from '../routes/project-routes.js';
import type { LucyOperatorRouteDeps } from '../routes/lucy-operator-routes.js';
import type { RouteDeps } from '../routes/shared.js';
import type { LucyLookSource } from '../../core/lucy-operator/tools.js';
import { createLucyLookSource } from './look-source.js';
import { createLucyOperator } from './service.js';

/** Connect her look-ups to the server's stores. Exported so the connections can be tested one by one. */
export function buildLucyLookSource(deps: RouteDeps): LucyLookSource {
  return createLucyLookSource({
    getTasks: () => deps.taskStore.viewTasks(),
    // `inspectActive` only reads; `getAll` would also bring expired snoozes back as a side effect.
    getFindings: () => deps.queue.inspectActive(),
    getLifetimeSpendUsd: () => deps.taskStore.getLifetimeSpendUsd(),
    getQuota: () => deps.getQuotaStatus?.() ?? null,
    getReferences: (taskId) => deps.githubStateStore.getReferences(taskId),
    listProjects: deps.ledgerAnalytics && deps.projectConfigStore ? () => listProjectSummaries(deps) : undefined,
  });
}

export function buildLucyOperator(deps: RouteDeps): LucyOperatorRouteDeps['lucyOperator'] {
  const config = deps.lucyOperatorConfig;
  if (!config || !config.enabled) return undefined;
  if (!config.ok) return { unavailableReason: config.reason };

  return {
    service: createLucyOperator({
      model: createOpenRouterChatStream(config.model),
      modelName: config.model.model,
      source: buildLucyLookSource(deps),
      log: deps.lucyInteractionLog,
    }),
  };
}
