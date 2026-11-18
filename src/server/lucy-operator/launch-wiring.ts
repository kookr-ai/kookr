/**
 * Connects Lucy's launch controller (issue #3676) to the server's own parts: the launch
 * service, the admission checks `POST /api/tasks` applies, the project list, the settings,
 * and the model that writes the task description.
 */

import { join } from 'node:path';
import { appendAuditRow } from '../../core/audit-log.js';
import { nowISO } from '../../core/interaction-log.js';
import type { LucyModelPort } from '../../core/lucy-operator/model-port.js';
import { getProjectId } from '../../core/project-identity.js';
import type { ProjectSummary } from '../../core/project-summary.js';
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

/** When a task was last started in the project, from the tasks Kookr holds for it; undefined when it holds none. */
function lastUsedAt(summary: ProjectSummary): number | undefined {
  const starts = (summary.recentTasks ?? [])
    .map((task) => (task.startedAt ? Date.parse(task.startedAt) : NaN))
    .filter((ms) => Number.isFinite(ms));
  return starts.length > 0 ? Math.max(...starts) : undefined;
}

/**
 * The launch rule, in one place: she may launch in every project the dashboard shows that has a
 * folder on this machine, which is what the dashboard's Launch dialog offers as a working folder
 * (`trackedProjectPaths` in `LaunchTaskDialog.tsx`: every project with a `localPath`, whether or not
 * it is tracked). Before issue #4144 only tracked projects passed, which left out Kookr's own
 * repository on an install where most tasks run there. A folder is offered once, under the first
 * name that has it. `list_projects` uses the same function, so what she is told matches what she may do.
 *
 * `ownProjectId` is the id of the repository this server runs from. The project with that id is
 * marked as Kookr itself. Ids are compared, never names or folders: production runs from a
 * `kookr-prod` worktree whose recorded folder is the parent clone.
 */
export function selectLaunchableProjects(summaries: readonly ProjectSummary[], ownProjectId?: string): Array<{ summary: ProjectSummary; project: LaunchableProject }> {
  const byFolder = new Map<string, { summary: ProjectSummary; project: LaunchableProject }>();
  for (const summary of summaries) {
    const cwd = summary.localPath?.trim();
    const name = summary.displayName.trim();
    if (!cwd || !name) continue;
    const own = ownProjectId !== undefined && summary.project === ownProjectId;
    const used = lastUsedAt(summary);
    const existing = byFolder.get(cwd);
    if (existing) {
      // The folder is already offered under another name: it keeps that name, and what is known of it is merged.
      if (own) existing.project.own = true;
      if (used !== undefined && (existing.project.lastUsedAt === undefined || used > existing.project.lastUsedAt)) existing.project.lastUsedAt = used;
      continue;
    }
    byFolder.set(cwd, { summary, project: { name, cwd, ...(own ? { own: true as const } : {}), ...(used !== undefined ? { lastUsedAt: used } : {}) } });
  }
  return [...byFolder.values()];
}

/** Server folder -> the id of the repository it belongs to, once it is known for certain. */
const ownProjectIds = new Map<string, string>();

/**
 * The id of the repository this server runs from (`github.com/kookr-ai/kookr`), read from its git
 * remote. Undefined when it cannot be known for certain: `getProjectId` falls back to
 * `local/<folder name>` when there is no remote or git fails, and a folder name proves nothing.
 * Only a certain answer is remembered, so a failure is tried again on the next launch request.
 */
export async function kookrOwnProjectId(serverCwd: string | undefined, resolve: (cwd: string) => Promise<string> = getProjectId): Promise<string | undefined> {
  if (!serverCwd) return undefined;
  const known = ownProjectIds.get(serverCwd);
  if (known) return known;
  try {
    const id = await resolve(serverCwd);
    if (!id || id.startsWith('local/')) return undefined;
    ownProjectIds.set(serverCwd, id);
    return id;
  } catch {
    return undefined;
  }
}

/** The projects she may launch in: those the dashboard shows that have a folder on this machine. */
export async function lucyLaunchableProjects(deps: RouteDeps, resolveOwn: (cwd: string) => Promise<string> = getProjectId): Promise<LaunchableProject[]> {
  const [summaries, ownProjectId] = await Promise.all([listProjectSummaries(deps), kookrOwnProjectId(deps.serverCwd, resolveOwn)]);
  return selectLaunchableProjects(summaries, ownProjectId).map((entry) => entry.project);
}

/**
 * The one model call that writes what will be launched or sent: no tools, and the only messages it is
 * given are the instructions and the operator's own sentences. Shared by the launch and action
 * controllers so neither can hand it anything else.
 */
export function lucyWriterCall(
  model: LucyModelPort,
  maxOutputTokens: number,
): (request: { system: string; operatorWords: readonly string[]; signal?: AbortSignal }) => Promise<string> {
  return async ({ system, operatorWords, signal }) => {
    let text = '';
    for await (const event of model({
      messages: [{ role: 'system', content: system }, ...operatorWords.map((content) => ({ role: 'user' as const, content }))],
      tools: [],
      maxOutputTokens,
      signal,
    })) {
      if (event.type === 'text') text += event.delta;
    }
    return text;
  };
}

export function buildLucyLaunchController(
  deps: RouteDeps,
  model: LucyModelPort,
  log: LucyInteractionLog | undefined,
  options: { onHeld?: () => void } = {},
): LucyLaunchController {
  return createLucyLaunchController({
    ...(options.onHeld ? { onHeld: options.onHeld } : {}),
    // Read here, at launch time, from the server's settings. No request can set it.
    getAutonomy: () => deps.settings?.get().lucyAutonomy ?? DEFAULT_LUCY_AUTONOMY,
    getProjects: () => lucyLaunchableProjects(deps),
    writeSpec: lucyWriterCall(model, 900),
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
    // Her report on a task she launched is something she says unprompted: her next turn is shown it.
    onReport: (report) => deps.lucyUnprompted?.record({
      key: `launch:${report.taskId}`,
      text: report.text,
      tasks: [{ id: report.taskId, ...(report.taskName ? { name: report.taskName } : {}) }],
    }),
    log,
  });
}
