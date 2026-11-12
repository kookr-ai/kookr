/**
 * Where Lucy's look-ups get their facts in the running server: the task list, the
 * findings waiting on the operator, the quota, a task's terminal, and the projects.
 *
 * This file only reads. It maps Kookr's own records onto the small shapes the operator
 * loop understands (`core/lucy-operator`); hiding secrets and capping lengths happens
 * there, in one place, before anything is sent to the model.
 */

import { basename } from 'node:path';
import type { AnomalyType } from '../../shared/contracts/anomalies.js';
import type { TaskStatus } from '../../shared/contracts/task-status.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';
import { projectDisplayName } from '../../core/project-identity.js';
import { boundTailText } from '../../core/task-tail-store.js';
import type { LucyBoardInput, LucyBoardTask } from '../../core/lucy-operator/board.js';
import type { LucyLookSource, LucyProjectLine, LucyTaskDetail, LucyTaskOutput } from '../../core/lucy-operator/tools.js';

/** The task fields this file reads; Kookr's full task record satisfies it. */
export interface LookTask {
  id: string;
  name?: string;
  status: TaskStatus;
  prompt?: string;
  userPrompt?: string;
  cwd?: string;
  projectId?: string;
  agentType?: string;
  createdAt?: Date | string | number;
  updatedAt: Date | string | number;
  finishedAt?: Date | string | number;
  terminatedAt?: Date | string | number;
  terminationReason?: string;
  tokenUsage?: { costUsd?: number };
  sessions: ReadonlyArray<{ tmuxSession: string; lastStatus?: string }>;
  pendingSignal?: { kind: string; note?: string };
  completionDigest?: { bullets?: readonly string[]; testSummary?: string };
}

export interface LucyLookSourceDeps {
  /** Live task list, read fresh on every call. */
  getTasks: () => readonly LookTask[];
  /** Findings waiting on the operator, keyed by the session that raised them. */
  getFindings: () => ReadonlyArray<{ agentId: string; anomaly: { type: AnomalyType; subType?: string } }>;
  getLifetimeSpendUsd?: () => number;
  getQuota?: () => { fiveHour: { utilization: number; resetsAt: string } | null; sevenDay: { utilization: number; resetsAt: string } | null } | null;
  /** Read what a running session's terminal shows now. Rejects when the session is gone. */
  captureDisplay?: (sessionId: string) => Promise<string>;
  /** The terminal tail saved when a task ended; null when none was kept. */
  getStoredTail?: (taskId: string) => Promise<{ text: string } | null>;
  getReferences?: (taskId: string) => ReadonlyArray<{ type: 'pr' | 'issue'; number: number }>;
  listProjects?: () => Promise<ReadonlyArray<{ displayName: string; activeAgents: number; findingCount: number }>>;
}

/** Why a task waits on the operator, in words she can repeat. The finding's own text is not used: an agent may have shaped it. */
const ATTENTION_WORDS: Record<AnomalyType, string> = {
  needs_input: 'it stopped and needs your input',
  permission_blocked: 'it is blocked on a permission',
  repeated_error: 'it keeps hitting the same error',
  merge_conflict: 'it has a merge conflict',
  stale_agent: 'it has gone quiet',
  hook_disconnected: 'Kookr lost contact with it',
  hook_missing: 'Kookr cannot see what it is doing',
  hook_parse_degraded: 'Kookr can only partly see what it is doing',
  backend_unreachable: 'its terminal cannot be reached',
  api_error: 'it hit an error from its model provider',
  budget_exceeded: 'it went over its budget',
};

function attentionFor(task: LookTask, findings: ReturnType<LucyLookSourceDeps['getFindings']>): string | undefined {
  const sessions = new Set(task.sessions.map((session) => session.tmuxSession));
  const finding = findings.find((entry) => sessions.has(entry.agentId));
  if (finding) {
    if (finding.anomaly.type === 'needs_input' && finding.anomaly.subType === 'ask_user_question') return 'it asked you a question';
    return ATTENTION_WORDS[finding.anomaly.type] ?? 'it needs you';
  }
  if (task.pendingSignal?.kind === 'completion_ready' && !isTerminalStatus(task.status)) return 'it says it is finished and wants your review';
  return undefined;
}

function projectOf(task: LookTask): string | undefined {
  if (task.projectId) return projectDisplayName(task.projectId);
  return task.cwd ? basename(task.cwd) : undefined;
}

function toBoardTask(task: LookTask, findings: ReturnType<LucyLookSourceDeps['getFindings']>): LucyBoardTask {
  const attention = attentionFor(task, findings);
  const costUsd = task.tokenUsage?.costUsd;
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    updatedAt: task.updatedAt,
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(task.terminatedAt !== undefined ? { terminatedAt: task.terminatedAt } : {}),
    ...(task.terminationReason ? { terminationReason: task.terminationReason } : {}),
    ...(projectOf(task) ? { project: projectOf(task) } : {}),
    ...(typeof costUsd === 'number' && Number.isFinite(costUsd) ? { costUsd } : {}),
    ...(attention ? { attention } : {}),
  };
}

export function createLucyLookSource(deps: LucyLookSourceDeps): LucyLookSource {
  const findTask = (taskId: string): LookTask | undefined => deps.getTasks().find((task) => task.id === taskId);

  return {
    board(): LucyBoardInput {
      const findings = deps.getFindings();
      const quota = deps.getQuota?.() ?? null;
      const spend = deps.getLifetimeSpendUsd?.();
      return {
        tasks: deps.getTasks().map((task) => toBoardTask(task, findings)),
        lifetimeSpendUsd: typeof spend === 'number' && Number.isFinite(spend) ? spend : null,
        quota: quota ? { fiveHour: quota.fiveHour, sevenDay: quota.sevenDay } : null,
      };
    },

    taskDetail(taskId): LucyTaskDetail | null {
      const task = findTask(taskId);
      if (!task) return null;
      const digest = task.completionDigest;
      const summary = [...(digest?.bullets ?? []), ...(digest?.testSummary ? [`Tests: ${digest.testSummary}`] : [])].join('\n');
      const signal = task.pendingSignal;
      const references = deps.getReferences?.(task.id).map((ref) => `${ref.type === 'pr' ? 'PR' : 'issue'} #${ref.number}`);
      return {
        prompt: task.userPrompt ?? task.prompt,
        agentType: task.agentType,
        cwd: task.cwd,
        createdAt: task.createdAt,
        ...(signal ? { pendingSignal: signal.note ? `${signal.kind}: ${signal.note}` : signal.kind } : {}),
        ...(summary ? { completionSummary: summary } : {}),
        ...(references && references.length > 0 ? { references } : {}),
      };
    },

    async taskOutput(taskId, lines): Promise<LucyTaskOutput | null> {
      const task = findTask(taskId);
      if (!task) return null;
      const live = [...task.sessions].reverse().find((session) => session.lastStatus !== 'completed' && session.lastStatus !== 'aborted');
      if (live && deps.captureDisplay) {
        try {
          const text = boundTailText(await deps.captureDisplay(live.tmuxSession), lines).text;
          if (text.trim()) return { text, source: 'live' };
        } catch {
          // The session ended between the list and the read: fall back to the saved tail.
        }
      }
      const stored = await deps.getStoredTail?.(task.id);
      if (!stored || !stored.text.trim()) return null;
      return { text: boundTailText(stored.text, lines).text, source: 'persisted' };
    },

    async projects(): Promise<readonly LucyProjectLine[]> {
      if (deps.listProjects) {
        const projects = await deps.listProjects();
        return projects.map((project) => ({ name: project.displayName, activeTasks: project.activeAgents, findings: project.findingCount }));
      }
      // No project registry wired: fall back to the projects that have tasks on the board.
      const findings = deps.getFindings();
      const byName = new Map<string, LucyProjectLine>();
      for (const task of deps.getTasks()) {
        const name = projectOf(task);
        if (!name) continue;
        const line = byName.get(name) ?? { name, activeTasks: 0, findings: 0 };
        if (!isTerminalStatus(task.status)) line.activeTasks += 1;
        if (attentionFor(task, findings)) line.findings += 1;
        byName.set(name, line);
      }
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
