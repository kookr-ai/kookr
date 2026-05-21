import { hashPrompt } from '../hash-prompt.js';
import { canonicalizeCwd } from '../launch-service.js';
import { normalizePromptFileReferences } from '../prompt-file-paths.js';
import type { Task } from '../../core/tasks.js';
import type { AgentType } from '../../shared/contracts/agent-types.js';
import type {
  CoordinatorChainMember,
  CoordinatorChainStrip,
  CoordinatorDetectorId,
  CoordinatorDetectorOutput,
  CoordinatorFinding,
  CoordinatorSnapshotState,
  CoordinatorTaskChip,
} from '../../shared/contracts/coordinator.js';
import type { CoordinatorSuppressionReader } from './suppression-store.js';

export interface CoordinatorAuditTailProvider {
  getCoordinatorAuditTail(): CoordinatorAuditTailRow[];
}

export type CoordinatorTask = Task & {
  anomaly?: unknown;
  followUp?: unknown;
  followUpRequired?: boolean;
  nextAction?: unknown;
  metadata?: {
    intent?: string;
  };
};

export interface CoordinatorSnapshot {
  tasks: readonly CoordinatorTask[];
}

export interface CoordinatorAuditTailRow {
  taskId?: string;
  timestamp?: string | number | Date;
  observedAt?: string | number | Date;
  ts?: string | number | Date;
  hook_event_name?: string;
  rawHookEventName?: string;
  type?: string;
  event?: {
    type?: string;
  };
  envelope?: {
    taskId?: string;
    kookrSessionId?: string;
    observedAt?: string | number | Date;
    rawHookEventName?: string;
  };
}

export interface RunDetectorsOptions {
  now?: Date;
  staleAfterMs?: number;
  suppressions?: CoordinatorSuppressionReader;
}

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const ACTIVE_STATUSES = new Set(['open', 'pending', 'inProgress']);

export function runDetectors(
  snapshot: CoordinatorSnapshot,
  auditTail: readonly CoordinatorAuditTailRow[],
  opts: RunDetectorsOptions = {},
): CoordinatorDetectorOutput[] {
  const { tasks } = snapshot;
  const now = opts.now ?? new Date();
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  return [
    ...detectDeclaredEdges(tasks),
    ...detectStaleTasks(tasks, auditTail, now, staleAfterMs),
    ...detectDuplicateTasks(tasks),
    ...detectDoneNotClearedTasks(tasks),
  ].filter((output) => !isSuppressed(output, tasks, now, opts.suppressions));
}

export function buildCoordinatorSnapshotState(
  snapshot: CoordinatorSnapshot,
  auditTail: readonly CoordinatorAuditTailRow[],
  opts: RunDetectorsOptions = {},
): CoordinatorSnapshotState {
  const now = opts.now ?? new Date();
  const outputs = runDetectors(snapshot, auditTail, { ...opts, now });
  return {
    outputs,
    chips: buildTaskChips(snapshot.tasks, outputs),
    findings: buildFleetFindings(snapshot.tasks, outputs),
    chains: buildChainStrips(snapshot.tasks),
  };
}

function isSuppressed(
  output: CoordinatorDetectorOutput,
  tasks: readonly CoordinatorTask[],
  now: Date,
  suppressions?: CoordinatorSuppressionReader,
): boolean {
  if (!suppressions) return false;
  const task = tasks.find((candidate) => candidate.id === output.taskId);
  return task ? suppressions.isSuppressed(output.detectorId, task.agentType, now, task.id) : false;
}

function detectDeclaredEdges(tasks: readonly CoordinatorTask[]): CoordinatorDetectorOutput[] {
  const taskIds = new Set(tasks.map((task) => task.id));
  const out: CoordinatorDetectorOutput[] = [];
  for (const task of tasks) {
    const blocks = task.blocks ?? [];
    const blockedBy = task.blocked_by ?? [];
    const meaningfulBlocks = blocks.filter((edge) => edge.startsWith('task:') ? taskIds.has(edge.slice('task:'.length)) : true);
    const meaningfulBlockedBy = blockedBy.filter((edge) => edge.startsWith('task:') ? taskIds.has(edge.slice('task:'.length)) : true);
    const orphanEdges = [...blocks, ...blockedBy].filter((edge) => edge.startsWith('task:') && !taskIds.has(edge.slice('task:'.length)));
    if (meaningfulBlocks.length === 0 && meaningfulBlockedBy.length === 0 && orphanEdges.length === 0) continue;
    out.push({
      detectorId: 'declared_edge',
      taskId: task.id,
      evidence: {
        blocksCount: meaningfulBlocks.length,
        blockedByCount: meaningfulBlockedBy.length,
        orphanCount: orphanEdges.length,
      },
    });
  }
  return out;
}

function detectStaleTasks(
  tasks: readonly CoordinatorTask[],
  auditTail: readonly CoordinatorAuditTailRow[],
  now: Date,
  staleAfterMs: number,
): CoordinatorDetectorOutput[] {
  const taskIdsBySession = buildTaskIdsBySession(tasks);
  const lastPostToolUseByTask = new Map<string, Date>();

  for (const row of auditTail) {
    if (!isPostToolUseRow(row)) continue;
    const taskId = rowTaskId(row, taskIdsBySession);
    if (!taskId) continue;
    const observedAt = rowObservedAt(row);
    if (!observedAt) continue;
    const prior = lastPostToolUseByTask.get(taskId);
    if (!prior || observedAt > prior) lastPostToolUseByTask.set(taskId, observedAt);
  }

  const out: CoordinatorDetectorOutput[] = [];
  for (const task of tasks) {
    if (task.status !== 'inProgress') continue;
    const lastPostToolUseAt = lastPostToolUseByTask.get(task.id);
    const fallbackActivityAt = latestActiveSessionStartedAt(task);
    const activityAt = latestDate(lastPostToolUseAt, fallbackActivityAt);
    if (!activityAt) continue;

    const ageMs = now.getTime() - activityAt.getTime();
    if (ageMs < staleAfterMs) continue;
    out.push({
      detectorId: 'stale',
      taskId: task.id,
      evidence: {
        ageMs,
        staleAfterMs,
        lastPostToolUseAt: lastPostToolUseAt?.toISOString() ?? null,
        fallbackActivityAt: lastPostToolUseAt ? null : activityAt.toISOString(),
      },
    });
  }
  return out;
}

function detectDuplicateTasks(tasks: readonly CoordinatorTask[]): CoordinatorDetectorOutput[] {
  const activeTasks = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
  const groups = new Map<string, { promptHash: string; tasks: CoordinatorTask[] }>();

  for (const task of activeTasks) {
    if (task.metadata?.intent === 'keep_as_duplicate') continue;
    const promptHash = hashPrompt(normalizePromptFileReferences(task.prompt, task.cwd));
    const duplicateKey = `${task.agentType}\0${canonicalizeCwd(task.cwd)}\0${promptHash}`;
    const group = groups.get(duplicateKey) ?? { promptHash, tasks: [] };
    group.tasks.push(task);
    groups.set(duplicateKey, group);
  }

  const out: CoordinatorDetectorOutput[] = [];
  for (const { promptHash, tasks: group } of groups.values()) {
    if (group.length < 2) continue;
    const clusterTaskIds = group.map((task) => task.id).sort();
    const canonicalCwd = canonicalizeCwd(group[0]!.cwd);
    const agentType = group[0]!.agentType;
    for (const task of group) {
      out.push({
        detectorId: 'duplicate',
        taskId: task.id,
        evidence: {
          promptHash,
          agentType,
          canonicalCwd,
          clusterTaskIds,
          peerTaskIds: clusterTaskIds.filter((id) => id !== task.id),
        },
      });
    }
  }
  return out;
}

function detectDoneNotClearedTasks(tasks: readonly CoordinatorTask[]): CoordinatorDetectorOutput[] {
  const out: CoordinatorDetectorOutput[] = [];
  for (const task of tasks) {
    if (task.status !== 'completed') continue;
    if (!task.completionDigest) continue;
    if (hasFollowUpSignal(task)) continue;
    if (task.anomaly) continue;
    out.push({
      detectorId: 'done_not_cleared',
      taskId: task.id,
      evidence: {
        hasCompletionDigest: true,
        completionFeedbackPresent: Boolean(task.completionFeedback),
      },
    });
  }
  return out;
}

function buildTaskChips(
  tasks: readonly CoordinatorTask[],
  outputs: readonly CoordinatorDetectorOutput[],
): CoordinatorTaskChip[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const byTask = new Map<string, CoordinatorDetectorOutput[]>();
  for (const output of outputs) {
    const list = byTask.get(output.taskId) ?? [];
    list.push(output);
    byTask.set(output.taskId, list);
  }

  const chips: CoordinatorTaskChip[] = [];
  for (const [taskId, candidates] of byTask) {
    const task = tasksById.get(taskId);
    if (!task) continue;
    const output = [...candidates].sort((left, right) => detectorRank(left.detectorId) - detectorRank(right.detectorId))[0];
    chips.push(chipForOutput(task, output));
  }
  return chips;
}

function detectorRank(detectorId: CoordinatorDetectorId): number {
  switch (detectorId) {
    case 'declared_edge': return 0;
    case 'stale': return 1;
    case 'duplicate': return 2;
    case 'done_not_cleared': return 3;
  }
}

function chipForOutput(task: CoordinatorTask, output: CoordinatorDetectorOutput): CoordinatorTaskChip {
  const base = {
    taskId: task.id,
    detectorId: output.detectorId,
    agentType: task.agentType as AgentType,
  };
  switch (output.detectorId) {
    case 'declared_edge': {
      const blocksCount = evidenceNumber(output, 'blocksCount');
      const blockedByCount = evidenceNumber(output, 'blockedByCount');
      const count = blocksCount + blockedByCount + evidenceNumber(output, 'orphanCount');
      return {
        ...base,
        action: blockedByCount > 0 ? 'snooze' : 'nudge',
        verb: blockedByCount > 0 ? 'Snooze' : 'Nudge',
        evidenceGlyph: 'chain',
        evidenceCount: count,
        title: `${blocksCount} downstream, ${blockedByCount} upstream, ${evidenceNumber(output, 'orphanCount')} orphan edge(s)`,
      };
    }
    case 'stale':
      return {
        ...base,
        action: 'nudge',
        verb: 'Nudge',
        evidenceGlyph: 'clock',
        evidenceCount: Math.max(1, Math.round(evidenceNumber(output, 'ageMs') / 60_000)),
        title: `No recent tool activity for ${Math.round(evidenceNumber(output, 'ageMs') / 60_000)} minute(s)`,
      };
    case 'duplicate': {
      const peerTaskIds = evidenceStringArray(output, 'peerTaskIds');
      return {
        ...base,
        action: 'compare',
        verb: 'Compare',
        evidenceGlyph: 'match',
        evidenceCount: peerTaskIds.length + 1,
        peerTaskIds,
        title: `Matches ${peerTaskIds.length} active task(s) with the same prompt, cwd, and agent`,
      };
    }
    case 'done_not_cleared':
      return {
        ...base,
        action: 'acknowledge',
        verb: 'Acknowledge',
        evidenceGlyph: 'check',
        evidenceCount: 1,
        title: 'Completed task has a digest and no active follow-up signal',
      };
  }
}

function buildFleetFindings(
  tasks: readonly CoordinatorTask[],
  outputs: readonly CoordinatorDetectorOutput[],
): CoordinatorFinding[] {
  const findings: CoordinatorFinding[] = [];
  const duplicateClusters = new Map<string, Set<string>>();
  for (const output of outputs) {
    if (output.detectorId !== 'duplicate') continue;
    const clusterTaskIds = evidenceStringArray(output, 'clusterTaskIds');
    if (clusterTaskIds.length < 2) continue;
    const key = clusterTaskIds.join(':');
    duplicateClusters.set(key, new Set(clusterTaskIds));
  }
  for (const [key, taskIds] of duplicateClusters) {
    findings.push({
      id: `duplicate:${key}`,
      kind: 'duplicate_cluster',
      title: 'Duplicate task cluster',
      taskIds: [...taskIds],
      evidenceGlyph: 'match',
      evidenceCount: taskIds.size,
    });
  }

  const taskIds = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    const orphanEdges = [...(task.blocks ?? []), ...(task.blocked_by ?? [])]
      .filter((edge) => edge.startsWith('task:') && !taskIds.has(edge.slice('task:'.length)));
    if (orphanEdges.length === 0) continue;
    findings.push({
      id: `orphan:${task.id}`,
      kind: 'orphan_blocker',
      title: 'Orphan dependency edge',
      taskIds: [task.id],
      evidenceGlyph: 'chain',
      evidenceCount: orphanEdges.length,
    });
  }
  return findings;
}

function buildChainStrips(tasks: readonly CoordinatorTask[]): Record<string, CoordinatorChainStrip> {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const out: Record<string, CoordinatorChainStrip> = {};
  for (const task of tasks) {
    const members: CoordinatorChainMember[] = [];
    addMember(members, tasksById, task.parentTaskId, 'parent');
    for (const childTaskId of task.childTaskIds ?? []) addMember(members, tasksById, childTaskId, 'child');
    for (const edge of task.blocks ?? []) {
      if (edge.startsWith('task:')) addMember(members, tasksById, edge.slice('task:'.length), 'blocks');
    }
    for (const edge of task.blocked_by ?? []) {
      if (edge.startsWith('task:')) addMember(members, tasksById, edge.slice('task:'.length), 'blocked_by');
    }
    if (members.length === 0) continue;
    const priorTaskIds = members
      .filter((member) => member.relation === 'parent' || member.relation === 'blocked_by')
      .map((member) => member.taskId);
    out[task.id] = {
      members,
      priorTaskIds,
      concurrencyToken: buildConcurrencyToken(task, members, tasksById),
    };
  }
  return out;
}

function addMember(
  members: CoordinatorChainMember[],
  tasksById: ReadonlyMap<string, CoordinatorTask>,
  taskId: string | undefined,
  relation: CoordinatorChainMember['relation'],
): void {
  if (!taskId || members.some((member) => member.taskId === taskId)) return;
  const task = tasksById.get(taskId);
  if (!task) return;
  members.push({
    taskId,
    label: task.name ?? task.prompt.slice(0, 60),
    status: task.status,
    relation,
  });
}

function buildConcurrencyToken(
  task: CoordinatorTask,
  members: readonly CoordinatorChainMember[],
  tasksById: ReadonlyMap<string, CoordinatorTask>,
): string {
  const parts = [task, ...members.map((member) => tasksById.get(member.taskId)).filter((member): member is CoordinatorTask => Boolean(member))]
    .map((member) => `${member.id}:${member.status}:${member.updatedAt instanceof Date ? member.updatedAt.toISOString() : String(member.updatedAt)}`);
  return hashPrompt(parts.sort().join('|'));
}

function evidenceNumber(output: CoordinatorDetectorOutput, key: string): number {
  const value = output.evidence[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function evidenceStringArray(output: CoordinatorDetectorOutput, key: string): string[] {
  const value = output.evidence[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function hasFollowUpSignal(task: CoordinatorTask): boolean {
  if (task.followUpRequired === true) return true;
  if (task.followUp !== undefined && task.followUp !== null) return true;
  if (task.nextAction !== undefined && task.nextAction !== null) return true;
  return false;
}

function buildTaskIdsBySession(tasks: readonly CoordinatorTask[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const task of tasks) {
    for (const session of task.sessions ?? []) {
      if (session.tmuxSession) out.set(session.tmuxSession, task.id);
    }
  }
  return out;
}

function latestActiveSessionStartedAt(task: CoordinatorTask): Date | undefined {
  let latest: Date | undefined;
  for (const session of task.sessions ?? []) {
    if (session.lastStatus === 'completed' || session.lastStatus === 'aborted') continue;
    const createdAt = parseDate(session.createdAt);
    if (!createdAt) continue;
    if (!latest || createdAt > latest) latest = createdAt;
  }
  return latest;
}

function latestDate(...dates: Array<Date | undefined>): Date | undefined {
  let latest: Date | undefined;
  for (const date of dates) {
    if (!date) continue;
    if (!latest || date > latest) latest = date;
  }
  return latest;
}

function rowTaskId(row: CoordinatorAuditTailRow, taskIdsBySession: ReadonlyMap<string, string>): string | undefined {
  if (row.taskId) return row.taskId;
  if (row.envelope?.taskId) return row.envelope.taskId;
  if (row.envelope?.kookrSessionId) return taskIdsBySession.get(row.envelope.kookrSessionId);
  return undefined;
}

function rowObservedAt(row: CoordinatorAuditTailRow): Date | undefined {
  return parseDate(row.observedAt)
    ?? parseDate(row.timestamp)
    ?? parseDate(row.ts)
    ?? parseDate(row.envelope?.observedAt);
}

function isPostToolUseRow(row: CoordinatorAuditTailRow): boolean {
  return row.hook_event_name === 'PostToolUse'
    || row.rawHookEventName === 'PostToolUse'
    || row.envelope?.rawHookEventName === 'PostToolUse'
    || row.event?.type === 'tool_result'
    || row.type === 'tool_result';
}

function parseDate(value: string | number | Date | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
