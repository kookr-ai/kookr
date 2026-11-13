/**
 * Connects Lucy's launch controller (issue #3676) to the server's own parts: the launch
 * service, the admission checks `POST /api/tasks` applies, the project list, the settings,
 * and the model that writes the task description.
 */

import { join } from 'node:path';
import { appendAuditRow } from '../../core/audit-log.js';
import { nowISO } from '../../core/interaction-log.js';
import type { LucyModelPort } from '../../core/lucy-operator/model-port.js';
import type { LaunchableProject } from '../../core/lucy-operator/launch-proposal.js';
import { DEFAULT_LUCY_AUTONOMY, LUCY_OPERATOR_ACTOR_ID } from '../../shared/contracts/lucy-launch.js';
import { MAX_ACTIVE_TASKS } from '../config.js';
import { launchTask, snapshotCapacityLedger } from '../launch-service.js';
import { evaluateDiskAdmission, evaluateTaskAdmission, readAdmissionControlConfigFromEnv, readDiskAdmissionConfigFromEnv } from '../task-admission.js';
import { listProjectSummaries } from '../routes/project-routes.js';
import type { RouteDeps } from '../routes/shared.js';
import type { LucyInteractionLog } from '../lucy-interaction-log.js';
import { createLucyLaunchController, type LucyLaunchBroadcast, type LucyLaunchController } from './launch-controller.js';

/** Why a launch would be refused right now, in one sentence, or null. Mirrors the checks `POST /api/tasks` makes. */
export function lucyLaunchRoomCheck(deps: RouteDeps): () => string | null {
  const admissionConfig = readAdmissionControlConfigFromEnv();
  const diskConfig = readDiskAdmissionConfigFromEnv();
  return () => {
    const status = deps.getLatestResourceStatus?.() ?? null;
    const admission = evaluateTaskAdmission({ config: admissionConfig, eventLoopDelayP95Ms: status?.server.eventLoopDelayP95Ms ?? null });
    if (!admission.admit) return 'Kookr is too busy to start a task right now.';
    const dataDirectory = status?.host?.dataDirectory;
    const sample = dataDirectory
      ? {
          diskFreePercent: dataDirectory.diskFreePercent,
          diskFreeBytes: dataDirectory.diskFreeBytes,
          diskFreeInodes: dataDirectory.diskFreeInodes,
          diskTotalInodes: dataDirectory.diskTotalInodes,
          path: dataDirectory.path,
          sampledAt: status?.sampledAt,
        }
      : null;
    if (sample && deps.diskAdmissionTracker) deps.diskAdmissionTracker.observe(sample, diskConfig);
    const disk = evaluateDiskAdmission({
      config: diskConfig,
      sample,
      ...(deps.diskAdmissionTracker ? { critical: deps.diskAdmissionTracker.isCritical(), pressureCause: deps.diskAdmissionTracker.getPressureCause() } : {}),
    });
    if (!disk.admit) return 'Kookr is low on disk space, so it is not starting tasks right now.';
    // A full board queues a launch instead of refusing it; she refuses, so a task never starts later without anyone expecting it.
    const maxActive = deps.launchServiceDeps.getMaxActiveTasks?.() ?? MAX_ACTIVE_TASKS;
    const ledger = snapshotCapacityLedger(deps.launchServiceDeps, maxActive);
    if (ledger.free <= 0) return `All ${maxActive} task slots are busy, so I cannot start another one now.`;
    return null;
  };
}

/** The projects she may launch in: those the dashboard shows that have a folder on this machine. */
export async function lucyLaunchableProjects(deps: RouteDeps): Promise<LaunchableProject[]> {
  const summaries = await listProjectSummaries(deps);
  const seen = new Set<string>();
  const projects: LaunchableProject[] = [];
  for (const summary of summaries) {
    const cwd = summary.localPath?.trim();
    if (!cwd || !(summary.tracked === true || summary.project.startsWith('local/'))) continue;
    const name = summary.displayName.trim();
    if (!name || seen.has(cwd)) continue;
    seen.add(cwd);
    projects.push({ name, cwd });
  }
  return projects;
}

export function buildLucyLaunchController(
  deps: RouteDeps,
  model: LucyModelPort,
  log: LucyInteractionLog | undefined,
): LucyLaunchController {
  return createLucyLaunchController({
    // Read here, at launch time, from the server's settings. No request can set it.
    getAutonomy: () => deps.settings?.get().lucyAutonomy ?? DEFAULT_LUCY_AUTONOMY,
    getProjects: () => lucyLaunchableProjects(deps),
    writeSpec: async ({ system, operatorWords, signal }) => {
      let text = '';
      for await (const event of model({
        messages: [{ role: 'system', content: system }, ...operatorWords.map((content) => ({ role: 'user' as const, content }))],
        tools: [],
        maxOutputTokens: 900,
        signal,
      })) {
        if (event.type === 'text') text += event.delta;
      }
      return text;
    },
    checkRoom: lucyLaunchRoomCheck(deps),
    launch: (opts, server) => launchTask(deps.launchServiceDeps, opts, server),
    // The durable trail: who asked (lucy-operator), for which task, under which level, how it was confirmed.
    audit: (row) => appendAuditRow(deps.auditLogPath ?? (deps.kookrDir ? join(deps.kookrDir, 'audit.jsonl') : undefined), {
      type: 'task.launch',
      timestamp: nowISO(),
      actor: LUCY_OPERATOR_ACTOR_ID,
      ...row,
    }),
    // Owners only: a read-only viewer must not see the operator's words or the task description.
    emit: (message: LucyLaunchBroadcast) => deps.emitToOwners?.(message),
    log,
  });
}
