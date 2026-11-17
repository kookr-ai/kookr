/**
 * The dashboard's side of `kookr ask`: what an owner's dashboard connection is
 * sent about questions, and what happens when the operator answers one there
 * (in Lucy's panel). Kept out of `server/index.ts` so the two rules that matter
 * can be tested on their own:
 *
 *  - Questions go to **owner** connections only. A question can quote anything a
 *    task sees, so a read-only shared view must never receive the list, even an
 *    all-projects one that does receive other live updates.
 *  - Every answer sent from the dashboard is written to the shared audit log,
 *    accepted or refused. On a loopback server any local process can open the
 *    owner socket, so that line is the trace that a question was closed from
 *    there. It never holds the answer text.
 */

import { appendAuditRow } from '../../core/audit-log.js';
import { listOperatorAsks, type TaskNameLookup, type TaskStatusLookup } from '../../core/operator-asks.js';
import type {
  AnswerResult,
  AskChange,
  AskRecord,
  DashboardAnswerInput,
  OperatorAskView,
} from '../../shared/contracts/asks.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';
import type { Actor } from '../auth.js';

const WS_OPEN = 1;

/** The slice of the ask service this module needs (the real class satisfies it). */
export interface OperatorAsksSource {
  all(): AskRecord[];
  answerFromDashboard(input: DashboardAnswerInput): Promise<AnswerResult>;
}

export interface OperatorAsksPortDeps {
  service: OperatorAsksSource;
  taskName: TaskNameLookup;
  taskStatus: TaskStatusLookup;
  /** Shared `audit.jsonl`; undefined writes nothing (lightweight harnesses). */
  auditLogPath?: string;
  now?: () => number;
  /** Test seam; production appends to the audit log and never throws. */
  appendAudit?: (path: string | undefined, row: Record<string, unknown>) => Promise<void>;
}

/** What the dashboard socket handler uses: the current list, and recording an answer. */
export interface OperatorAsksPort {
  list(): OperatorAskView[];
  /**
   * The list to re-send after a task outcome, or undefined when nothing on screen changes: only a task
   * that has ended and still has a pending question flips that question's "task ended" mark.
   */
  listAfterTaskOutcome(taskId: string): OperatorAskView[] | undefined;
  answer(input: DashboardAnswerInput): Promise<AnswerResult>;
}

export function createOperatorAsksPort(deps: OperatorAsksPortDeps): OperatorAsksPort {
  const now = deps.now ?? Date.now;
  const appendAudit = deps.appendAudit ?? appendAuditRow;
  return {
    list: () => listOperatorAsks(deps.service.all(), now(), deps.taskName, deps.taskStatus),
    listAfterTaskOutcome(taskId) {
      const status = deps.taskStatus(taskId);
      if (status === undefined || !isTerminalStatus(status)) return undefined;
      if (!deps.service.all().some((ask) => ask.taskId === taskId && ask.state === 'pending')) return undefined;
      return listOperatorAsks(deps.service.all(), now(), deps.taskName, deps.taskStatus);
    },
    async answer(input) {
      const result = await deps.service.answerFromDashboard(input);
      try {
        await appendAudit(deps.auditLogPath, {
          type: 'ask.dashboardAnswer',
          timestamp: new Date(now()).toISOString(),
          actor: 'owner:dashboard',
          askId: input.askId,
          ...(result.ask ? { taskId: result.ask.taskId } : {}),
          choice: input.optionIndex !== undefined ? `option:${input.optionIndex}` : 'text',
          outcome: result.ok ? 'recorded' : result.reason,
          ...(result.ok && result.ask.taskDelivery ? { taskDelivery: result.ask.taskDelivery } : {}),
        });
      } catch (err) {
        // The answer is already recorded and typed into the task: a failed audit write must not turn it into "no reply".
        console.warn('[asks] could not write the dashboard-answer audit line:', err);
      }
      return result;
    },
  };
}

/** A dashboard connection as the connection registry lists it. */
export interface DashboardConnectionLike {
  ws: { readyState: number; send(data: string): void };
  actor: Actor;
}

/**
 * Send the current question list to every open owner connection after a
 * change. `announce` is set only when the change is a question just created,
 * which is the one Lucy reads aloud. `change` is undefined when the list is re-sent
 * for another reason (a task ended), which announces nothing. Returns how many connections were sent to.
 */
export function pushOperatorAsks(
  connections: Iterable<DashboardConnectionLike>,
  asks: OperatorAskView[],
  change: AskChange | undefined,
  warn: (message: string, err: unknown) => void = (message, err) => console.warn(message, err),
): number {
  const data = JSON.stringify({
    type: 'operatorAsks',
    asks,
    serverNow: Date.now(),
    ...(change?.kind === 'created' ? { announce: change.ask.id } : {}),
  } satisfies ServerMessage);
  let sent = 0;
  for (const { ws, actor } of connections) {
    if (actor.kind !== 'owner' || ws.readyState !== WS_OPEN) continue;
    try {
      ws.send(data);
      sent += 1;
    } catch (err) {
      warn('[asks] could not push the question list to a dashboard connection:', err);
    }
  }
  return sent;
}
