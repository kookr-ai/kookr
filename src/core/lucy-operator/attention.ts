/**
 * Why a task is waiting on the operator, worked out from Kookr's own records: the
 * finding raised on one of its sessions, or its "finished, please review" signal.
 *
 * Both of Lucy's pictures of the work read this: the board of the operator conversation
 * and the shorter status the hands-free helper model answers from (issue #3927). They
 * word it differently, but they agree on which tasks wait and why.
 *
 * Nothing here is free text written by an agent. The finding's explanation is read only
 * for the name of the tool a permission prompt is about, and only when that name looks
 * like a tool name; the command or path the prompt shows is never taken.
 */

import type { AnomalyType } from '../../shared/contracts/anomalies.js';
import type { TaskStatus } from '../../shared/contracts/task-status.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';

type TimeValue = Date | string | number;

/** A finding waiting on the operator, keyed by the session that raised it. */
export interface AttentionFinding {
  agentId: string;
  anomaly: { type: AnomalyType; subType?: string; explanation?: string; detectedAt?: TimeValue };
}

/** The task fields read here; Kookr's task record satisfies it. */
export interface AttentionTask {
  status: TaskStatus;
  sessions: ReadonlyArray<{ tmuxSession: string }>;
  pendingSignal?: { kind: string; raisedAt?: string };
}

export type OperatorAttentionKind = AnomalyType | 'asked_question' | 'wants_review';

export interface OperatorAttention {
  kind: OperatorAttentionKind;
  /** For a permission prompt: the tool it asks about, when Kookr knows a clean name for it. */
  tool?: string;
  /** Since when the task has waited, in epoch milliseconds; absent when unknown. */
  sinceMs?: number;
}

/** A tool name as Claude Code reports it (`Bash`, `WebFetch`, `mcp__github__create_issue`). Anything else is not quoted. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function toMs(value: TimeValue | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** The tool named by a permission finding ("... for tool: Bash"), or undefined when it names none or not cleanly. */
export function permissionToolName(explanation: string | undefined): string | undefined {
  const raw = explanation ? /for tool: (\S+)/.exec(explanation)?.[1] : undefined;
  return raw && TOOL_NAME.test(raw) ? raw : undefined;
}

/**
 * Why the task waits on the operator, or undefined when it does not. A finding counts whatever
 * the task's status, as on the board; callers that list only live tasks filter ended ones out.
 */
export function operatorAttention(task: AttentionTask, findings: readonly AttentionFinding[]): OperatorAttention | undefined {
  const sessions = new Set(task.sessions.map((session) => session.tmuxSession));
  const finding = findings.find((entry) => sessions.has(entry.agentId));
  if (finding) {
    const { anomaly } = finding;
    const sinceMs = toMs(anomaly.detectedAt);
    const since = sinceMs === undefined ? {} : { sinceMs };
    if (anomaly.type === 'needs_input' && anomaly.subType === 'ask_user_question') return { kind: 'asked_question', ...since };
    if (anomaly.type === 'permission_blocked') {
      const tool = permissionToolName(anomaly.explanation);
      return { kind: 'permission_blocked', ...(tool ? { tool } : {}), ...since };
    }
    return { kind: anomaly.type, ...since };
  }
  if (task.pendingSignal?.kind === 'completion_ready' && !isTerminalStatus(task.status)) {
    const sinceMs = toMs(task.pendingSignal.raisedAt);
    return { kind: 'wants_review', ...(sinceMs === undefined ? {} : { sinceMs }) };
  }
  return undefined;
}
