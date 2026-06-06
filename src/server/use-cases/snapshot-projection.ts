import type { AgentState } from '../../core/monitor.js';
import type { AgentType } from '../../core/agent-types.js';
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
      // user acknowledges them.
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
  state.taskName = meta.name ?? truncatePrompt(meta.displayPrompt, 60);
  state.description = meta.displayPrompt;
  state.cwd = meta.cwd;
  state.agentType = meta.agentType;
  state.startedAt = meta.createdAt.toISOString();
  state.playbookId = meta.playbookId;
  state.playbookParameterValues = meta.playbookParameterValues;
  state.launchHealthSummary = meta.launchHealthSummary;
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
  if (task.tokenUsage) {
    state.tokenUsage = task.tokenUsage;
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
    taskName: task.name ?? truncatePrompt(displayPrompt, 60),
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
    projectId: task.projectId,
    projectDisplayLabel: projectDisplayLabel({ projectId: task.projectId, cwd: task.cwd }),
    priority: task.priority,
    ralphLoop: task.ralphLoop,
  };
}

function buildTerminalTaskEntry(task: Task): AgentState {
  const displayPrompt = displayPromptForTask(task);
  const lastSession = task.sessions[task.sessions.length - 1];
  return {
    agentId: lastSession?.tmuxSession ?? `done-${task.id}`,
    events: [],
    anomaly: null,
    lastEventSeq: 0,
    taskId: task.id,
    taskName: task.name ?? truncatePrompt(displayPrompt, 60),
    taskStatus: task.status,
    parentTaskId: task.parentTaskId,
    childTaskIds: task.childTaskIds,
    blocks: task.blocks,
    blocked_by: task.blocked_by,
    description: displayPrompt,
    cwd: lastSession?.cwd ?? task.cwd,
    agentType: lastSession?.agentType ?? task.agentType,
    startedAt: task.createdAt.toISOString(),
    playbookId: task.playbookId,
    playbookParameterValues: task.playbookParameterValues,
    launchHealthSummary: task.launchHealthSummary,
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
  };
}

/** Truncate a prompt to maxLen chars at a word boundary, adding "..." if truncated. */
function truncatePrompt(prompt: string, maxLen: number): string {
  if (prompt.length <= maxLen) return prompt;
  const truncated = prompt.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + '...';
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
