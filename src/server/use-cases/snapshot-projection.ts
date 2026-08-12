import { performance } from 'node:perf_hooks';
import type { MonitorAgentState } from '../../core/monitor.js';
import { recordHotPath } from '../../core/hot-path-sampler.js';
import { toClientAgentState } from '../../core/monitor-agent-state.js';
import type { AgentType } from '../../core/agent-types.js';
import { deriveLatestCompletionSignal } from '../../core/completion-signal.js';
import { displayPromptForTask } from '../../core/prompt-display.js';
import { projectDisplayLabel } from '../../core/project-identity.js';
import { isAgedTerminalTask, isTerminalStatus, taskSnapshotRecencyMs, type Task, type TaskLaunchHealthSummary } from '../../core/tasks.js';
import type { AgentStatus, Anomaly, TaskStatus, WorktreeHealth } from '../../core/types.js';
import { normalizeTerminalWorktreeHealth } from '../../core/worktree-health.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';
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
 * WS snapshot synthetic terminal entries older than this are excluded (payload
 * diet). Aligned with hot-store prune default so the dashboard never carries
 * terminal tasks the server is about to drop from memory. Older history stays
 * available via `GET /api/tasks` (+ `status`/`since`/`limit`) and
 * `GET /api/tasks/:id`. Debug/raw snapshot surfaces are NOT affected.
 */
export const SNAPSHOT_TERMINAL_TASK_MAX_AGE_DAYS = 1;

/**
 * Hard cap on synthetic terminal rows in the client WebSocket snapshot.
 *
 * Age alone is not enough on high-throughput hosts: with hundreds of same-day
 * terminal tasks the dashboard still ships multi-MB snapshots, blocks the
 * event loop on `JSON.stringify`, and disconnects clients with
 * `1013 sustained dashboard snapshot backpressure` before playbook
 * list/launch messages can land. Keep the most recent N for the Completed
 * pane; REST remains the full-history path.
 */
export const SNAPSHOT_TERMINAL_TASK_MAX_COUNT = 100;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Milliseconds equivalent of {@link SNAPSHOT_TERMINAL_TASK_MAX_AGE_DAYS}. */
export const SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS = SNAPSHOT_TERMINAL_TASK_MAX_AGE_DAYS * MS_PER_DAY;

/**
 * Task snapshot-age helpers now live in `core/tasks.ts` so
 * `TaskStore.listTasksForSnapshot` can filter aged terminal tasks BEFORE
 * cloning (issue #1749 follow-up). Re-exported here for existing importers.
 */
export { taskSnapshotRecencyMs, isAgedTerminalTask };

type SnapshotFindingState = AgentState & { anomaly: Anomaly; taskId: string };

/**
 * Build the dashboard-facing agent snapshot from raw monitor state plus task
 * snapshots. Maps live {@link MonitorAgentState} into wire {@link AgentState}
 * (shared SSOT), then enriches with task metadata and projection-only fields.
 * Synthetic pending/terminal entries stay out of Monitor so core monitoring
 * remains focused on live event/anomaly state (issue #1460).
 */
export function buildSnapshotProjection(deps: {
  monitorStates: readonly MonitorAgentState[];
  tasks: readonly Task[];
  /**
   * When set, synthetic terminal entries are skipped for tasks whose last
   * activity (see {@link taskSnapshotRecencyMs}) is older than this epoch-ms
   * cutoff (issue #1526 Phase C / C2). Client snapshot paths pass
   * `now - SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS`; raw/debug paths leave it unset
   * so they keep full-fidelity history.
   */
  excludeTerminalBeforeMs?: number;
  /**
   * When set (client path), keep only the most recent N non-aged terminal
   * synthetic rows after the age cutoff. Raw/debug paths leave this unset.
   * Defaults to {@link SNAPSHOT_TERMINAL_TASK_MAX_COUNT} when
   * `excludeTerminalBeforeMs` is set so client callers stay bounded even if
   * they forget to pass the count.
   */
  maxTerminalTasks?: number;
  /**
   * Ghost-agent guard (issue #2408, replaces the #1760 clone-set protection).
   * Session ids (`tmuxSession`) that are live in the monitor snapshot but
   * owned by a terminal task the caller deliberately dropped from `tasks`
   * (age/count bounded). A raw monitor state whose id is in this set but has
   * NO {@link SessionSnapshotMeta} entry is suppressed instead of leaking as
   * an unattributed agent card. Orphan monitor states (id absent from the
   * set) still surface, preserving prior behavior. Cheap Set of ids — the
   * caller no longer clones the owning tasks just to build the session index.
   */
  suppressSessionIds?: ReadonlySet<string>;
}): AgentState[] {
  // Hot-path ranking (issue #1781): snapshot rebuild runs on every broadcast and
  // is a known heavy contributor. Two clock reads + one O(1) record per rebuild.
  const startedAt = performance.now();
  const sessionIndex = new Map<string, SessionSnapshotMeta>();
  for (const task of deps.tasks) {
    const taskIsTerminal = isTerminalStatus(task.status);
    // displayPromptForTask depends only on the task (regex over the full prompt),
    // so hoist it to at most once per task and compute it lazily — only when a
    // live session actually needs it. Terminal/completed/aborted sessions are
    // `continue`d in the monitorStates loop below after reading only
    // taskStatus/sessionStatus, so their displayPrompt and projectDisplayLabel
    // are never consumed; skipping those two computes trims wasted work on the
    // hot snapshot_rebuild path (issue #2125). Placeholder empty strings keep the
    // meta shape intact without touching the retained (live) output.
    let taskDisplayPrompt: string | undefined;
    for (const session of task.sessions) {
      const sessionIsTerminal = taskIsTerminal
        || session.lastStatus === 'completed'
        || session.lastStatus === 'aborted';
      sessionIndex.set(session.tmuxSession, {
        task,
        taskId: task.id,
        name: task.name,
        displayPrompt: sessionIsTerminal ? '' : (taskDisplayPrompt ??= displayPromptForTask(task)),
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
        projectDisplayLabel: sessionIsTerminal
          ? ''
          : projectDisplayLabel({ projectId: task.projectId, cwd: session.cwd }),
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
  const presentTaskIds = new Set<string>();
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
    // Ghost-agent guard (issue #2408): the owning terminal task was dropped
    // from the (bounded) clone set, so there is no session-index entry to
    // suppress this live monitor state via the terminal branch above. Drop it
    // here instead of leaking it as an unattributed agent card.
    if (!meta && deps.suppressSessionIds?.has(rawState.agentId)) {
      continue;
    }

    const state = toClientAgentState(rawState);
    if (meta) {
      enrichLiveState(state, meta);
    }
    states.push(state);
    if (state.taskId) presentTaskIds.add(state.taskId);
  }

  const pendingTasks: Task[] = [];
  const terminalCandidates: Task[] = [];
  for (const task of deps.tasks) {
    if (task.status === 'pending') {
      pendingTasks.push(task);
      continue;
    }
    if (task.status !== 'completed' && task.status !== 'cancelled' && task.status !== 'terminated') {
      continue;
    }
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
    if (presentTaskIds.has(task.id)) continue;
    terminalCandidates.push(task);
  }

  for (const task of pendingTasks) {
    states.push(buildPendingTaskEntry(task));
    presentTaskIds.add(task.id);
  }

  // Client path: age + hard count cap. Prefer most recent by recency so the
  // Completed pane stays useful under high same-day terminal throughput.
  const terminalCap = resolveTerminalCap(deps);
  let terminalsToEmit = terminalCandidates;
  if (terminalCap !== undefined && terminalCandidates.length > terminalCap) {
    terminalsToEmit = [...terminalCandidates]
      .sort((a, b) => taskSnapshotRecencyMs(b) - taskSnapshotRecencyMs(a))
      .slice(0, terminalCap);
  }
  for (const task of terminalsToEmit) {
    states.push(buildTerminalTaskEntry(task));
  }

  annotateFindingCausality(states);
  recordHotPath('snapshot_rebuild', performance.now() - startedAt);
  return states;
}

/**
 * Resolve the synthetic-terminal count cap for a projection build.
 * - explicit `maxTerminalTasks` wins (including 0)
 * - client path (`excludeTerminalBeforeMs` set) defaults to
 *   {@link SNAPSHOT_TERMINAL_TASK_MAX_COUNT}
 * - raw/debug path (no age cutoff) stays unbounded
 */
function resolveTerminalCap(deps: {
  excludeTerminalBeforeMs?: number;
  maxTerminalTasks?: number;
}): number | undefined {
  if (deps.maxTerminalTasks !== undefined) {
    if (!Number.isFinite(deps.maxTerminalTasks) || deps.maxTerminalTasks < 0) {
      return SNAPSHOT_TERMINAL_TASK_MAX_COUNT;
    }
    return Math.floor(deps.maxTerminalTasks);
  }
  if (deps.excludeTerminalBeforeMs !== undefined) {
    return SNAPSHOT_TERMINAL_TASK_MAX_COUNT;
  }
  return undefined;
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
