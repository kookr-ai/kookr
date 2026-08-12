/**
 * Shared settings-mutation helper (RFC: rfc-cross-agent-task-migration).
 *
 * The `PUT /api/settings` route owns the canonical validate → update → audit →
 * broadcast sequence for a whole-settings change. Cross-agent migration's "set
 * as default" toggle is a server-side (non-route) caller that needs the SAME
 * sequence for the single `defaultAgentType` field — calling `settings.update()`
 * directly would skip the audit trail and the snapshot broadcast. This helper
 * reproduces that sequence for the migrate path. (The `PUT /api/settings` route
 * keeps its own inline sequence, since it validates the entire settings object,
 * not just this field; a future refactor could route its default-agent write
 * through here too.)
 */

import type { AgentType } from '../shared/contracts/agent-types.js';
import type { RouteDeps } from './routes/shared.js';
import { createSnapshotMessage } from './use-cases/get-snapshot.js';
import { validateSettingsWithWarnings } from '../core/settings-store.js';
import { resolveLifecycleActor } from './actor-attribution.js';
import {
  appendSettingsMutationAudit,
  buildSettingsMutationAuditRow,
} from '../core/settings-mutation-audit.js';
import { resolveSafeModeStatus } from '../core/automation-kill-switch.js';

export interface DefaultAgentUpdateResult {
  updated: boolean;
  reason?: string;
}

/**
 * Persist `agent` as the new default agent through the full settings path
 * (validated, audited, broadcast). Merges onto current settings so unrelated
 * fields are preserved; server-managed fields (e.g. `roundRobinIndex`) are kept
 * by `settings.update()`. Returns `{ updated: false, reason }` when settings are
 * not configured.
 */
export async function applyDefaultAgentUpdate(
  deps: RouteDeps,
  agent: AgentType,
  actorHeader?: string,
): Promise<DefaultAgentUpdateResult> {
  if (!deps.settings) return { updated: false, reason: 'settings_not_configured' };

  const prev = deps.settings.get();
  if (prev.defaultAgentType === agent) return { updated: true };

  const { settings: validated } = validateSettingsWithWarnings({
    ...(prev as unknown as Record<string, unknown>),
    defaultAgentType: agent,
  });
  await deps.settings.update(validated);

  // Durable settings-mutation audit (issue #1710). Best-effort.
  const actor = resolveLifecycleActor('api', actorHeader);
  const auditRow = buildSettingsMutationAuditRow({
    previous: prev as unknown as Record<string, unknown>,
    next: deps.settings.get() as unknown as Record<string, unknown>,
    actor: { source: 'api', actorId: actor.actorId },
  });
  await appendSettingsMutationAudit(deps.auditLogPath, auditRow);

  const committed = deps.settings.get();
  deps.broadcastToAll(
    createSnapshotMessage({
      monitor: deps.monitor,
      serverCwd: deps.serverCwd,
      sttUrl: deps.sttUrl,
      activityMetaProvider: deps.hookIngestion,
      getMaxActiveTasks: deps.getMaxActiveTasks,
      relationTaskStore: deps.taskStore,
      safeMode: resolveSafeModeStatus({
        automationKillSwitch: committed.automationKillSwitch,
        safeModeSince: committed.safeModeSince,
        loadError: deps.settings?.getLoadError?.(),
      }),
    }),
  );
  // Confirm the committed value actually took (validation could normalize it).
  return { updated: deps.settings.get().defaultAgentType === agent };
}
