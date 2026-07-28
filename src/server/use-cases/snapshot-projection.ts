import type { AgentState } from '../../core/monitor.js';
import type { AgentType } from '../../core/agent-types.js';
import { deriveLatestCompletionSignal } from '../../core/completion-signal.js';
import { displayPromptForTask } from '../../core/prompt-display.js';
import { projectDisplayLabel } from '../../core/project-identity.js';
import { isTerminalStatus, type Task, type TaskLaunchHealthSummary } from '../../core/tasks.js';
import type { AgentStatus, Anomaly, TaskStatus, WorktreeHealth } from '../../core/types.js';
import { normalizeTerminalWorktreeHealth } from '../../core/worktree-health.js';
import type { TaskPriority } from '../../shared/contracts/task.js';

interface SessionSnapshotMeta {
  task: Task;
  taskId: string;
  name?: string;
  displayPrompt: string;
  cwd: string;
  agentType: AgentType;
  createdAt: Date;
  taskStatus: TaskStatus;
  sessionStatus?: AgentStatus | 'completed' | 'aborted';
  playbookId?: string;
  playbookParameterValues?: Record<string, string>;
  launchHealthSummary?: TaskLaunchHealthSummary;
  launchPermissionPosture?: NonNullable<Task['metadata']>['launchPermissionPosture'];
  projectId?: string;
  projectDisplayLabel: string;
  priority?: TaskPriority;
  gitBranch?: string;
  gitCommit?: string;
  gitIsWorktree?: boolean;
  worktreeHealth?: WorktreeHealth;
  worktreeHealthObservedAt?: string;
  worktreeRegistryStale?: boolean;
}

const FINDING_CAUSALITY_SEVERITY_ORDER: Record<Anomaly['severity'], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * Terminal tasks whose last activity is older than this many days are excluded
 * from the client-facing WebSocket snapshot (issue #1526 Phase C / C2 payload
 * diet). The Completed pane keeps rendering the recent window; older history
 * is available on demand via `GET /api/tasks` (with `status`/`since`/`limit`
 * filters) and `GET /api/tasks/:id`. Debug/raw snapshot surfaces
 * (`getSnapshotAgentsRaw`, `/api/snapshot`) are NOT affected.
 */
export const SNAPSHOT_TERMINAL_TASK_MAX_AGE_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Milliseconds equivalent of {@link SNAPSHOT_TERMINAL_TASK_MAX_AGE_DAYS}. */
export const SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS = SNAPSHOT_TERMINAL_TASK_MAX_AGE_DAYS * MS_PER_DAY;

/**
 * Latest activity timestamp (ms) attributable to a task for snapshot-age
 * purposes. `updatedAt` normally dominates (every transition bumps it), but
 * `finishedAt`/`terminatedAt` are included defensively for legacy records.
 * Using `updatedAt` means any fresh mutation (rename, feedback, reopen) makes
 * an aged terminal task reappear in the snapshot — the operator-friendly
 * behavior.
 */
export function taskSnapshotRecencyMs(task: Pick<Task, 'updatedAt' | 'finishedAt' | 'terminatedAt'>): number {
  return Math.max(
    task.updatedAt.getTime(),
    task.finishedAt?.getTime() ?? 0,
    task.terminatedAt?.getTime() ?? 0,
  );
}

/** True when the task is terminal AND its last activity predates `cutoffMs`. */
export function isAgedTerminalTask(
  task: Pick<Task, 'status' | 'updatedAt' | 'finishedAt' | 'terminatedAt'>,
  cutoffMs: number,
): boolean {
  return isTerminalStatus(task.status) && taskSnapshotRecencyMs(task) < cutoffMs;
}

type SnapshotFindingState = AgentState & { anomaly: Anomaly; taskId: string };

/**
 * Build the dashboard-facing agent snapshot from raw monitor state plus task
 * snapshots. The projection creates fresh AgentState objects, preserves the
 * source monitor states, and keeps synthetic pending/terminal entries out of
 * Monitor so core monitoring stays focused on live event/anomaly state.
 */
export function buildSnapshotProjection(deps: {
  monitorStates: readonly AgentState[];
  tasks: readonly Task[];
  /**
   * When set, synthetic terminal entries are skipped for tasks whose last
   * activity (see {@link taskSnapshotRecencyMs}) is older than this epoch-ms
   * cutoff (issue #1526 Phase C / C2). Client snapshot paths pass
   * `now - SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS`; raw/debug paths leave it unset
   * so they keep full-fidelity history.
   */
  excludeTerminalBeforeMs?: number;
}): AgentState[] {
  const sessionIndex = new Map<string, SessionSnapshotMeta>();
  for (const task of deps.tasks) {
    for (const session of task.sessions) {
      sessionIndex.set(session.tmuxSession, {
        task,
        taskId: task.id,
        name: task.name,
        displayPrompt: displayPromptForTask(task),
        cwd: session.cwd,
        agentType: session.agentType,
        createdAt: session.createdAt,
        taskStatus: task.status,
        sessionStatus: session.lastStatus,
        playbookId: task.playbookId,
        playbookParameterValues: task.playbookParameterValues,
        launchHealthSummary: task.launchHealthSummary,
        launchPermissionPosture: task.metadata?.launchPermissionPosture,
        projectId: task.projectId,
        projectDisplayLabel: projectDisplayLabel({ projectId: task.projectId, cwd: session.cwd }),
        priority: task.priority,
        gitBranch: session.gitBranch,
        gitCommit: session.gitCommit,
        gitIsWorktree: session.gitIsWorktree,
        worktreeHealth: session.worktreeHealth,
        worktreeHealthObservedAt: session.worktreeHealthObservedAt,
        worktreeRegistryStale: session.worktreeRegistryStale,
      });
    }
  }

  const states: AgentState[] = [];
  for (const rawState of deps.monitorStates) {
    const meta = sessionIndex.get(rawState.agentId);
    if (
      meta
      && (isTerminalStatus(meta.taskStatus)
        || meta.sessionStatus === 'completed'
        || meta.sessionStatus === 'aborted')
    ) {
      continue;
    }

    const state: AgentState = { ...rawState };
    if (meta) {
      enrichLiveState(state, meta);
    }
    states.push(state);
  }

  for (const task of deps.tasks) {
    if (task.status === 'pending') {
      states.push(buildPendingTaskEntry(task));
    } else if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'terminated') {
      // Terminal-state tasks are synthetic entries for the dashboard Completed
      // pane. Without this, terminated tasks can become invisible before the
      // user acknowledges them. Aged terminal tasks are excluded from client
      // snapshots (issue #1526 Phase C / C2) — history stays reachable via
      // the REST task list/detail endpoints.
      if (
        deps.excludeTerminalBeforeMs !== undefined
        && isAgedTerminalTask(task, deps.excludeTerminalBeforeMs)
      ) {
        continue;
      }
      if (!states.some((state) => state.taskId === task.id)) {
        states.push(buildTerminalTaskEntry(task));
      }
    }
  }

  annotateFindingCausality(states);
  return states;
}

function enrichLiveState(state: AgentState, meta: SessionSnapshotMeta): void {
  const task = meta.task;
  state.taskId = meta.taskId;
  state.taskName = meta.name ?? promptTitle(meta.displayPrompt);
  state.description = meta.displayPrompt;
  state.cwd = meta.cwd;
  state.agentType = meta.agentType;
  state.startedAt = meta.createdAt.toISOString();
  state.playbookId = meta.playbookId;
  state.playbookParameterValues = meta.playbookParameterValues;
  state.launchHealthSummary = meta.launchHealthSummary;
  state.launchPermissionPosture = meta.launchPermissionPosture;
  state.gitBranch = meta.gitBranch;
  state.gitCommit = meta.gitCommit;
  state.gitIsWorktree = meta.gitIsWorktree;
  state.worktreeHealth = meta.worktreeHealth;
  state.worktreeHealthObservedAt = meta.worktreeHealthObservedAt;
  state.worktreeRegistryStale = meta.worktreeRegistryStale;
  state.projectId = meta.projectId;
  state.projectDisplayLabel = meta.projectDisplayLabel;
  state.priority = meta.priority;
  state.taskStatus = task.status;
  state.parentTaskId = task.parentTaskId;
  state.childTaskIds = task.childTaskIds;
  state.blocks = task.blocks;
  state.blocked_by = task.blocked_by;
  state.ralphLoop = task.ralphLoop;
  state.unattended = task.unattended;
  if (task.operatorNeeded) state.operatorNeeded = task.operatorNeeded;
  if (task.tokenUsage) {
    state.tokenUsage = task.tokenUsage;
  }
  const latestCompletionSignal = deriveLatestCompletionSignal({
    taskId: meta.taskId,
    agentId: state.agentId,
    taskStatus: state.taskStatus,
    events: state.events,
  });
  if (state.turnState === 'completed_turn' && latestCompletionSignal) {
    state.latestCompletionSignal = latestCompletionSignal;
  }
}

function buildPendingTaskEntry(task: Task): AgentState {
  const displayPrompt = displayPromptForTask(task);
  return {
    agentId: `pending-${task.id}`,
    events: [],
    anomaly: null,
    lastEventSeq: 0,
    taskId: task.id,
    taskName: task.name ?? promptTitle(displayPrompt),
    taskStatus: 'pending',
    parentTaskId: task.parentTaskId,
    childTaskIds: task.childTaskIds,
    blocks: task.blocks,
    blocked_by: task.blocked_by,
    description: displayPrompt,
    cwd: task.cwd,
    agentType: task.agentType,
    startedAt: task.createdAt.toISOString(),
    playbookId: task.playbookId,
    playbookParameterValues: task.playbookParameterValues,
    launchHealthSummary: task.launchHealthSummary,
    launchPermissionPosture: task.metadata?.launchPermissionPosture,
    projectId: task.projectId,
    projectDisplayLabel: projectDisplayLabel({ projectId: task.projectId, cwd: task.cwd }),
    priority: task.priority,
    ralphLoop: task.ralphLoop,
    unattended: task.unattended,
    ...(task.operatorNeeded ? { operatorNeeded: task.operatorNeeded } : {}),
  };
}

function buildTerminalTaskEntry(task: Task): AgentState {
  const displayPrompt = displayPromptForTask(task);
  const lastSession = task.sessions[task.sessions.length - 1];
  const finishedAt = terminalFinishedAt(task, lastSession);
  return {
    agentId: lastSession?.tmuxSession ?? `done-${task.id}`,
    events: [],
    anomaly: null,
    lastEventSeq: 0,
    taskId: task.id,
    taskName: task.name ?? promptTitle(displayPrompt),
    taskStatus: task.status,
    parentTaskId: task.parentTaskId,
    childTaskIds: task.childTaskIds,
    blocks: task.blocks,
    blocked_by: task.blocked_by,
    description: displayPrompt,
    cwd: lastSession?.cwd ?? task.cwd,
    agentType: lastSession?.agentType ?? task.agentType,
    startedAt: task.createdAt.toISOString(),
    finishedAt,
    playbookId: task.playbookId,
    playbookParameterValues: task.playbookParameterValues,
    launchHealthSummary: task.launchHealthSummary,
    launchPermissionPosture: task.metadata?.launchPermissionPosture,
    projectId: task.projectId,
    projectDisplayLabel: projectDisplayLabel({ projectId: task.projectId, cwd: lastSession?.cwd ?? task.cwd }),
    priority: task.priority,
    tokenUsage: task.tokenUsage,
    gitBranch: lastSession?.gitBranch,
    gitCommit: lastSession?.gitCommit,
    gitIsWorktree: lastSession?.gitIsWorktree,
    worktreeHealth: normalizeTerminalWorktreeHealth(task.status, lastSession?.worktreeHealth),
    worktreeHealthObservedAt: lastSession?.worktreeHealthObservedAt,
    worktreeRegistryStale: lastSession?.worktreeRegistryStale,
    completionDigest: task.completionDigest,
    completionFeedback: task.completionFeedback,
    ralphLoop: task.ralphLoop,
    unattended: task.unattended,
    ...(task.operatorNeeded ? { operatorNeeded: task.operatorNeeded } : {}),
    ...(task.disposition?.outcome ? { reapOutcome: task.disposition.outcome } : {}),
  };
}

function terminalFinishedAt(task: Task, lastSession: Task['sessions'][number] | undefined): string {
  if (task.finishedAt) return task.finishedAt.toISOString();
  if (task.terminatedAt) return task.terminatedAt.toISOString();
  if (typeof lastSession?.lastEventAt === 'number' && Number.isFinite(lastSession.lastEventAt)) {
    return new Date(lastSession.lastEventAt).toISOString();
  }
  if (typeof lastSession?.lastEventAt === 'string') {
    const parsed = new Date(lastSession.lastEventAt);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return task.updatedAt.toISOString();
}

/**
 * Build a single-line display title from a prompt for tasks that have no
 * explicit (LLM-generated) name yet. Collapses whitespace to one clean line and
 * caps length only as a payload safety valve — the client truncates the title
 * to the available card width, so the cap is deliberately larger than any panel
 * can show. That keeps the visible ellipsis CSS-driven (and therefore dynamic
 * as the panel resizes) instead of baking a fixed "..." into the string, which
 * a widened card could never expand past. See the finding/healthy card titles.
 */
function promptTitle(prompt: string, maxLen = 200): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  const cut = collapsed.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + '…';
}

function annotateFindingCausality(states: AgentState[]): void {
  const byAgentId = new Map<string, AgentState>();
  const parentByTaskId = new Map<string, string>();
  const findingsByTaskId = new Map<string, SnapshotFindingState>();

  for (const state of states) {
    byAgentId.set(state.agentId, state);
    if (state.taskId && state.parentTaskId) {
      parentByTaskId.set(state.taskId, state.parentTaskId);
    }
    if (state.taskId && state.anomaly) {
      findingsByTaskId.set(state.taskId, state as SnapshotFindingState);
    }
  }

  const relatedByRoot = new Map<string, Set<string>>();
  const rootBySymptom = new Map<string, string>();

  for (const symptom of findingsByTaskId.values()) {
    const ancestors: SnapshotFindingState[] = [];
    let parentTaskId = parentByTaskId.get(symptom.taskId);

    while (parentTaskId) {
      const ancestor = findingsByTaskId.get(parentTaskId);
      if (ancestor) ancestors.push(ancestor);
      parentTaskId = parentByTaskId.get(parentTaskId);
    }

    if (ancestors.length === 0) continue;

    ancestors.sort(compareLikelyRootFinding);
    const root = ancestors[0];
    if (root.agentId === symptom.agentId) continue;

    const related = relatedByRoot.get(root.agentId) ?? new Set<string>();
    related.add(symptom.agentId);
    relatedByRoot.set(root.agentId, related);
    rootBySymptom.set(symptom.agentId, root.agentId);
  }

  for (const [rootAgentId, relatedIds] of relatedByRoot) {
    const root = byAgentId.get(rootAgentId);
    if (!root?.anomaly) continue;
    root.anomaly = withCausality(root.anomaly, {
      likelyRootCause: true,
      relatedFindingIds: Array.from(relatedIds).sort(),
      causalityReason: `Linked by task ancestry: descendant tasks also have active findings under ${root.taskId ?? root.agentId}.`,
    });
  }

  for (const [symptomAgentId, rootAgentId] of rootBySymptom) {
    const symptom = byAgentId.get(symptomAgentId);
    if (!symptom?.anomaly) continue;
    symptom.anomaly = withCausality(symptom.anomaly, {
      rootCauseFindingId: rootAgentId,
      ...(symptom.anomaly.likelyRootCause ? {} : {
        causalityReason: `Linked by task ancestry to likely root finding ${rootAgentId}.`,
      }),
    });
  }
}

function compareLikelyRootFinding(a: SnapshotFindingState, b: SnapshotFindingState): number {
  const severity = FINDING_CAUSALITY_SEVERITY_ORDER[a.anomaly.severity] - FINDING_CAUSALITY_SEVERITY_ORDER[b.anomaly.severity];
  if (severity !== 0) return severity;
  const detectedAt = a.anomaly.detectedAt.getTime() - b.anomaly.detectedAt.getTime();
  if (detectedAt !== 0) return detectedAt;
  return a.agentId.localeCompare(b.agentId);
}

function withCausality(
  anomaly: Anomaly,
  patch: Partial<Pick<Anomaly, 'causalityReason' | 'likelyRootCause' | 'relatedFindingIds' | 'rootCauseFindingId'>>,
): Anomaly {
  const relatedFindingIds = Array.from(new Set([
    ...(anomaly.relatedFindingIds ?? []),
    ...(patch.relatedFindingIds ?? []),
  ])).sort();

  return {
    ...anomaly,
    ...(relatedFindingIds.length > 0 ? { relatedFindingIds } : {}),
    ...(patch.rootCauseFindingId ? { rootCauseFindingId: patch.rootCauseFindingId } : {}),
    ...(patch.likelyRootCause ? { likelyRootCause: true } : {}),
    ...(patch.causalityReason ? { causalityReason: patch.causalityReason } : {}),
  };
}
