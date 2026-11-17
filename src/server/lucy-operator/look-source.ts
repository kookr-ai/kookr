/**
 * Where Lucy's look-ups get their facts in the running server: the task list, the
 * findings waiting on the operator, the quota, and the projects, and a task's terminal,
 * read as a rendered screen (issue #3683).
 *
 * This file only reads. It maps Kookr's own records onto the small shapes the operator
 * loop understands (`core/lucy-operator`); hiding secrets and capping lengths happens
 * there, in one place, before anything is sent to the model.
 */

import { basename } from 'node:path';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { TaskStatus } from '../../shared/contracts/task-status.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';
import type { TerminalScreenTextOptions, TerminalScreenTextResult } from '../terminal-screen-text.js';
import { projectDisplayName } from '../../core/project-identity.js';
import { operatorAttention, type AttentionFinding, type OperatorAttentionKind } from '../../core/lucy-operator/attention.js';
import type { BriefingNeed } from '../../core/lucy-live/briefing.js';
import type { LucyBoardInput, LucyBoardTask, LucyTaskPullRequest } from '../../core/lucy-operator/board.js';
import { TASK_OUTPUT_LINES } from '../../core/lucy-operator/tools.js';
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
  pendingSignal?: { kind: string; note?: string; raisedAt?: string };
  completionDigest?: { bullets?: readonly string[]; testSummary?: string };
}

export interface LucyLookSourceDeps {
  /** Live task list, read fresh on every call. */
  getTasks: () => readonly LookTask[];
  /** Findings waiting on the operator, keyed by the session that raised them. */
  getFindings: () => readonly AttentionFinding[];
  getLifetimeSpendUsd?: () => number;
  /** Questions tasks asked the operator (`kookr ask`): the pending ones and the recently closed. */
  getAsks?: () => readonly OperatorAskView[];
  getQuota?: () => { fiveHour: { utilization: number; resetsAt: string } | null; sevenDay: { utilization: number; resetsAt: string } | null } | null;
  getReferences?: (taskId: string) => ReadonlyArray<{ type: 'pr' | 'issue'; number: number }>;
  /**
   * The pull requests of a task's own work with their state on GitHub. The caller leaves out any that
   * the task's request merely cites: those are not the task's delivery.
   */
  getPullRequests?: (taskId: string) => readonly LucyTaskPullRequest[];
  /**
   * The raw terminal stream of a task: the live session's, or the tail saved when it ended.
   * Null when there is none. Never sent to the model as is: `taskOutput` renders it first.
   */
  readTerminalStream?: (task: LookTask) => Promise<{ text: string; live: boolean } | null>;
  /** Replays a raw stream through a terminal emulator off the main thread; the server wires the worker. */
  renderScreenText?: (bytes: Uint8Array, options: TerminalScreenTextOptions) => Promise<TerminalScreenTextResult>;
  listProjects?: () => Promise<ReadonlyArray<{ displayName: string; activeAgents: number; findingCount: number; launchable?: boolean }>>;
}

/** Why a task waits on the operator, in words she can repeat. The finding's own text is not used: an agent may have shaped it. */
const ATTENTION_WORDS: Record<OperatorAttentionKind, string> = {
  needs_input: 'it stopped and needs your input',
  asked_question: 'it asked you a question',
  wants_review: 'it says it is finished and wants your review',
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
  const attention = operatorAttention(task, findings);
  return attention ? ATTENTION_WORDS[attention.kind] ?? 'it needs you' : undefined;
}

/** The display name of the project a task works in, as the board shows it. */
export function projectOf(task: Pick<LookTask, 'projectId' | 'cwd'>): string | undefined {
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

/**
 * The live tasks waiting on the operator, for the hands-free status (issue #3927). Built from
 * the same findings and signals as the board's "Needs the operator" section. The name and the
 * project are cleaned and cut by the status builder before anything is sent.
 */
export function operatorNeeds(tasks: readonly LookTask[], findings: readonly AttentionFinding[]): BriefingNeed[] {
  const needs: BriefingNeed[] = [];
  for (const task of tasks) {
    if (isTerminalStatus(task.status)) continue;
    const attention = operatorAttention(task, findings);
    if (!attention) continue;
    const project = projectOf(task);
    needs.push({ ...(task.name !== undefined ? { name: task.name } : {}), ...(project ? { project } : {}), attention });
  }
  return needs;
}

/**
 * The size the stream is replayed at. A fixed size is a simplification: the pane's real size
 * can change (a browser attach resizes it) and is not read here. The dashboard pins a pane at
 * about 200 columns, so this is the common case; a program that redraws relative to a much
 * narrower pane can leave stale fragments. Wrapped rows are joined before redaction.
 */
const RENDER_COLS = 200;
const RENDER_ROWS = 50;

export function createLucyLookSource(deps: LucyLookSourceDeps): LucyLookSource {
  const findTask = (taskId: string): LookTask | undefined => deps.getTasks().find((task) => task.id === taskId);

  return {
    board(): LucyBoardInput {
      const findings = deps.getFindings();
      const quota = deps.getQuota?.() ?? null;
      const spend = deps.getLifetimeSpendUsd?.();
      const asks = deps.getAsks?.() ?? [];
      return {
        tasks: deps.getTasks().map((task) => toBoardTask(task, findings)),
        lifetimeSpendUsd: typeof spend === 'number' && Number.isFinite(spend) ? spend : null,
        quota: quota ? { fiveHour: quota.fiveHour, sevenDay: quota.sevenDay } : null,
        ...(asks.length > 0 ? { asks } : {}),
        ...(deps.getPullRequests ? { pullRequestsOf: deps.getPullRequests } : {}),
      };
    },

    taskDetail(taskId): LucyTaskDetail | null {
      const task = findTask(taskId);
      if (!task) return null;
      const digest = task.completionDigest;
      const summary = [...(digest?.bullets ?? []), ...(digest?.testSummary ? [`Tests: ${digest.testSummary}`] : [])].join('\n');
      const signal = task.pendingSignal;
      const pullRequests = deps.getPullRequests?.(task.id) ?? [];
      // A pull request listed with its state is not repeated among the plain links.
      const own = new Set(pullRequests.map((pr) => pr.number));
      const references = deps.getReferences?.(task.id)
        .filter((ref) => !(ref.type === 'pr' && own.has(ref.number)))
        .map((ref) => `${ref.type === 'pr' ? 'PR' : 'issue'} #${ref.number}`);
      return {
        prompt: task.userPrompt ?? task.prompt,
        agentType: task.agentType,
        cwd: task.cwd,
        createdAt: task.createdAt,
        ...(signal ? { pendingSignal: signal.note ? `${signal.kind}: ${signal.note}` : signal.kind } : {}),
        ...(summary ? { completionSummary: summary } : {}),
        ...(references && references.length > 0 ? { references } : {}),
        ...(pullRequests.length > 0 ? { pullRequests } : {}),
      };
    },

    async taskOutput(taskId): Promise<LucyTaskOutput | null> {
      const task = findTask(taskId);
      if (!task || !deps.readTerminalStream || !deps.renderScreenText) return null;
      const stream = await deps.readTerminalStream(task);
      if (!stream || stream.text.length === 0) return null;
      const rendered = await deps.renderScreenText(new TextEncoder().encode(stream.text), {
        cols: RENDER_COLS,
        rows: RENDER_ROWS,
        maxLines: TASK_OUTPUT_LINES,
        sessionKey: `lucy-output:${task.id}`,
      });
      // A stream that could not be rendered in time gives nothing, never the raw stream.
      if (rendered.kind !== 'text') return null;
      return { text: rendered.text, live: stream.live };
    },

    async projects(): Promise<readonly LucyProjectLine[]> {
      if (deps.listProjects) {
        const projects = await deps.listProjects();
        return projects.map((project) => ({ name: project.displayName, activeTasks: project.activeAgents, findings: project.findingCount, ...(project.launchable !== undefined ? { launchable: project.launchable } : {}) }));
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
